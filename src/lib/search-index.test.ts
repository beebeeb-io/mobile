// @ts-nocheck
/**
 * Task 1594 round 3 (Codex T6) — `saveIndex()`'s PUT now sends
 * `X-Beebeeb-Expected-User` (server 1554), so it can receive the same 409
 * `account_mismatch` the upload paths and `request()` handle. Before this
 * fix, `saveIndex` collapsed every non-OK response (including this one) to
 * `null`, and its own callers intentionally swallow that — a key/session
 * mismatch here left the user silently signed in with index persistence
 * quietly broken. This must route through the same guarded session-teardown
 * (`api.endSessionForAccountMismatch`, snapshot-guarded per T5) instead.
 *
 * `./api` is mocked here (isolated-runner rule) — this is a unit test of
 * search-index.ts's OWN response handling, not of api.ts's real
 * `captureRequestAuthSnapshot`/`endSessionForAccountMismatch` (covered by
 * `api.expected-user.test.ts`).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchQueue: Array<() => Promise<Response>> = [];
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const calls = { endSession: 0, endSessionSnapshots: [] as unknown[] };
let currentToken: string | null = 'token-A';
let currentGeneration = 0;

mock.module('../../modules/beebeeb-crypto', () => ({
  encryptChunk: async (_key: Uint8Array, plaintext: Uint8Array) => ({
    nonce: new Uint8Array(12),
    ciphertext: plaintext,
  }),
  decryptChunk: async (_key: Uint8Array, _nonce: Uint8Array, ciphertext: Uint8Array) => ciphertext,
}));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));
mock.module('./expected-user', () => ({
  expectedUserHeaders: () => ({ 'X-Beebeeb-Expected-User': 'owner-id' }),
}));
mock.module('./api', () => ({
  getApiUrl: () => 'http://localhost:3001',
  getToken: async () => currentToken,
  // Mirrors the real api.ts shape: capture at call start, only tear down if
  // still current — see api.ts's own doc comment on these two.
  captureRequestAuthSnapshot: async () => ({ generation: currentGeneration, token: currentToken }),
  endSessionForAccountMismatch: async (snapshot: { generation: number; token: string | null } | null) => {
    calls.endSession += 1;
    calls.endSessionSnapshots.push(snapshot);
  },
}));

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const { saveIndex, createEmptyIndex } = await import('./search-index');

beforeEach(() => {
  fetchQueue = [];
  fetchCalls.length = 0;
  calls.endSession = 0;
  calls.endSessionSnapshots = [];
  currentToken = 'token-A';
  currentGeneration = 0;
});

describe('1594 round 3 (Codex T6) — saveIndex() routes account_mismatch through guarded session-teardown', () => {
  test('a 409 account_mismatch ends the session (via the snapshot-guarded helper) and returns null', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'account_mismatch', message: 'stale' }, 409));

    const result = await saveIndex(createEmptyIndex(), new Uint8Array(32));

    expect(result).toBeNull();
    expect(calls.endSession).toBe(1);
    expect(calls.endSessionSnapshots[0]).toEqual({ generation: 0, token: 'token-A' });
  });

  test('a non-account_mismatch 409 does NOT end the session', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'object_budget_exceeded', message: 'nope' }, 409));

    const result = await saveIndex(createEmptyIndex(), new Uint8Array(32));

    expect(result).toBeNull();
    expect(calls.endSession).toBe(0);
  });

  test('a successful PUT never touches the teardown helper', async () => {
    fetchQueue.push(async () => jsonResponse({}, 200, { ETag: 'v1' }));

    const result = await saveIndex(createEmptyIndex(), new Uint8Array(32));

    expect(result).toBe('v1');
    expect(calls.endSession).toBe(0);
  });

  test('a 404 (no index yet) does NOT end the session', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'not_found' }, 404));

    const result = await saveIndex(createEmptyIndex(), new Uint8Array(32));

    expect(result).toBeNull();
    expect(calls.endSession).toBe(0);
  });
});
