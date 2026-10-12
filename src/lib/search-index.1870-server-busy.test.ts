// @ts-nocheck
/**
 * Task 1870 — `saveIndex()` (`PUT /api/v1/index`) retries a `429 server_busy`
 * after Retry-After, and still collapses a final non-OK answer to `null`.
 * Timing contract: `server-busy-retry.test.ts`. `./api` is mocked (isolated-runner rule).
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

let fetchQueue: Array<() => Promise<Response>> = [];
let mockFetchImpl: ((init: RequestInit) => Promise<Response>) | null = null;
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
    if (mockFetchImpl) return mockFetchImpl(init);
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
const busy = (n: number) => jsonResponse({ error: 'server_busy', message: 'busy', retry_after: n }, 429, { 'Retry-After': String(n) });

const { saveIndex, createEmptyIndex } = await import('./search-index');

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  fetchQueue = [];
  mockFetchImpl = null;
  fetchCalls.length = 0;
  calls.endSession = 0;
  calls.endSessionSnapshots = [];
  currentToken = 'token-A';
  currentGeneration = 0;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('1870 — saveIndex() retries a 429 server_busy', () => {
  test('429 server_busy + Retry-After: 2, then 200 -> returns the ETag after exactly one retry, >= 2 s later', async () => {
    fetchQueue.push(async () => busy(2), async () => jsonResponse({}, 200, { ETag: 'v2' }));
    const start = Date.now();
    const p = saveIndex(createEmptyIndex(), new Uint8Array(32), 'v1');
    await flush();
    expect(fetchCalls.length).toBe(1);
    jest.advanceTimersByTime(1999);
    await flush();
    expect(fetchCalls.length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(await p).toBe('v2');
    expect(fetchCalls.length).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2000);
    expect(fetchCalls.every((c) => c.init.method === 'PUT' && c.url.endsWith('/api/v1/index'))).toBe(true);
    expect(fetchCalls[1].init.headers['If-Match']).toBe('v1');
  });

  test('four server_busy -> null, as for any other non-OK answer; session untouched', async () => {
    fetchQueue.push(async () => busy(1), async () => busy(1), async () => busy(1), async () => busy(1), async () => jsonResponse({}, 200, { ETag: 'x' }));
    const p = saveIndex(createEmptyIndex(), new Uint8Array(32));
    for (let i = 0; i < 8; i++) {
      await flush();
      jest.advanceTimersByTime(30_000);
    }
    expect(await p).toBeNull();
    expect(fetchCalls.length).toBe(4);
    expect(calls.endSession).toBe(0);
  });

  test('a 409 account_mismatch is not retried and still ends the session', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'account_mismatch', message: 'stale' }, 409), async () => jsonResponse({}, 200, { ETag: 'x' }));
    const p = saveIndex(createEmptyIndex(), new Uint8Array(32));
    for (let i = 0; i < 4; i++) {
      await flush();
      jest.advanceTimersByTime(30_000);
    }
    expect(await p).toBeNull();
    expect(fetchCalls.length).toBe(1);
    expect(calls.endSession).toBe(1);
  });

  // Codex P1 on #176: an older save that is waiting out a server_busy must not
  // be retried once a newer save exists — it carries no ETag and would
  // overwrite the newer index.
  test('(r2-1) save A busy, save B sent + succeeds during A\'s wait -> A makes no further request, does not throw; last write is B', async () => {
    const written: string[] = [];
    // Server model: last PUT wins. Body is the (mock-crypto) plaintext JSON.
    const decode = (init: RequestInit) => JSON.parse(new TextDecoder().decode((init.body as Uint8Array).slice(12))).updated_at as string;
    const ok = (init: RequestInit) => { written.push(decode(init)); return jsonResponse({}, 200, { ETag: 'vB' }); };
    const indexA = { ...createEmptyIndex(), updated_at: 'snapshot-A' };
    const indexB = { ...createEmptyIndex(), updated_at: 'snapshot-B' };
    let n = 0;
    mockFetchImpl = async (init) => {
      n += 1;
      if (n === 1) return busy(2); // A's first send
      return ok(init); // anything after that succeeds and is recorded
    };

    const pA = saveIndex(indexA, new Uint8Array(32), 'v1');
    await flush();
    expect(fetchCalls.length).toBe(1); // A sent, now waiting 2 s

    jest.advanceTimersByTime(500);
    const pB = saveIndex(indexB, new Uint8Array(32)); // newer edit, sent during A's wait
    await flush();
    expect(await pB).toBe('vB');
    expect(fetchCalls.length).toBe(2);

    jest.advanceTimersByTime(60_000); // A's wait elapses, then some
    await flush();
    expect(await pA).toBeNull(); // resolved quietly, no throw
    expect(fetchCalls.length).toBe(2); // A never re-sent
    expect(written).toEqual(['snapshot-B']); // server's last write is B
  });

  test('(r2-1b) a save that is still the latest keeps retrying (the guard is not a blanket no-retry)', async () => {
    fetchQueue.push(async () => busy(1), async () => jsonResponse({}, 200, { ETag: 'v9' }));
    const p = saveIndex(createEmptyIndex(), new Uint8Array(32));
    await flush();
    jest.advanceTimersByTime(1000);
    expect(await p).toBe('v9');
    expect(fetchCalls.length).toBe(2);
  });
});
