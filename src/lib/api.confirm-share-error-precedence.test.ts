// @ts-nocheck
/**
 * Task 1540 continuation (PR #108, Codex review) — two more direct-fetch
 * error branches in api.ts had `err.error ?? err.message` (machine code
 * preferred over human text), the same bug finding 7 fixed in `request()`
 * (see `api.billing-errors.test.ts`). This file is the regression guard for
 * the two the sweep itself flagged as still swapped:
 *
 *   - `confirmActionPlaintext` (line ~733) — the legacy-account step-up
 *     fallback POST to `/api/v1/auth/confirm`, reached via `confirmAction`
 *     when `confirm-opaque-start` answers 409 `{opaque_unavailable: true}`.
 *   - `downloadSharedFileBlob` (line ~2047) — the public share-download GET.
 *
 * Same isolated mock scaffold as `api.billing-errors.test.ts` — every
 * native module `api.ts` touches is mocked here too (mobile/CLAUDE.md
 * "Tests").
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}));

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-file-system/legacy', () => ({}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  isNativeAvailable: true,
  opaqueLoginStart: async () => ({ state: new Uint8Array([1]), message: new Uint8Array([2]) }),
  opaqueLoginFinish: async () => ({ message: new Uint8Array([3]) }),
}));

mock.module('./file-index-cache', () => ({
  clearCachedFileIndex: async () => {},
}));

mock.module('./sync-client', () => ({
  getDeviceId: async () => 'device-1',
}));

mock.module('./announcement-context', () => ({
  setAnnouncement: () => {},
  clearAnnouncement: () => {},
}));

mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

const TOKEN_KEY = 'beebeeb_session_token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?confirmShareErrorPrecedenceTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  store.set(TOKEN_KEY, 'session-token');
});

describe('confirmActionPlaintext: legacy-account step-up prefers `message` over `error`', () => {
  test('confirm-opaque-start 409 opaque_unavailable falls back to plaintext /auth/confirm, whose error body surfaces `message` not `error`', async () => {
    // 1. confirm-opaque-start -> 409, legacy account, no opaque_password_file.
    fetchQueue.push(async () => jsonResponse({ opaque_unavailable: true }, 409));
    // 2. plaintext /auth/confirm -> some non-401 failure carrying both fields.
    fetchQueue.push(async () => jsonResponse({
      error: 'internal_error',
      message: 'Something went wrong confirming your password. Please try again.',
    }, 500));

    const { ApiError, confirmAction } = await loadFreshApi();
    const err = await confirmAction('correct horse battery staple').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('Something went wrong confirming your password. Please try again.');
    expect(err.message).not.toBe('internal_error');
    // Sanity: both fetches actually happened (start, then the plaintext fallback).
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].url).toContain('/api/v1/auth/confirm');
  });

  test('regression guard: a body with ONLY `error` (no `message`) still surfaces it', async () => {
    fetchQueue.push(async () => jsonResponse({ opaque_unavailable: true }, 409));
    fetchQueue.push(async () => jsonResponse({ error: 'confirmation failed' }, 500));

    const { ApiError, confirmAction } = await loadFreshApi();
    const err = await confirmAction('correct horse battery staple').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('confirmation failed');
  });
});

describe('downloadSharedFileBlob: public share download prefers `message` over `error`', () => {
  test('a 403 carrying both fields surfaces the human message, not the machine code', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'share_passphrase_required',
      message: 'This share is protected by a passphrase.',
    }, 403));

    const { ApiError, downloadSharedFileBlob } = await loadFreshApi();
    const err = await downloadSharedFileBlob('tok123').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe('This share is protected by a passphrase.');
    expect(err.message).not.toBe('share_passphrase_required');
  });

  test('regression guard: a body with ONLY `error` (no `message`) still surfaces it', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'share not found' }, 404));

    const { ApiError, downloadSharedFileBlob } = await loadFreshApi();
    const err = await downloadSharedFileBlob('tok123').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('share not found');
  });

  test('regression guard: a body with NEITHER field falls back to the generic status message', async () => {
    fetchQueue.push(async () => jsonResponse({}, 500));

    const { ApiError, downloadSharedFileBlob } = await loadFreshApi();
    const err = await downloadSharedFileBlob('tok123').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('Share download failed: 500');
  });
});
