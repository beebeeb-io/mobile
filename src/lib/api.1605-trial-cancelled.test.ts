// @ts-nocheck
/**
 * Task 1605 (server PR #129) — a 409 `trial_cancelled_read_only` (upload
 * init / share creation) and a 413 `quota_exceeded` with `is_trial_cap:
 * true` (the 25 GB active-trial cap, distinct from the account's real plan
 * quota). Same isolated-per-file mock scaffold as api.billing-errors.test.ts
 * (mobile/CLAUDE.md "Tests").
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
  return import(`./api?trial1605Test=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  store.set(TOKEN_KEY, 'session-token');
});

describe('409 trial_cancelled_read_only — code preserved end to end', () => {
  test('createShare: ApiError.code is trial_cancelled_read_only, friendlyError() names the cancelled trial', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'trial_cancelled_read_only',
      message: 'Uploads are off until you resume your trial or pay now.',
    }, 409));

    const { ApiError, friendlyError, createShare } = await loadFreshApi();
    const err = await createShare('file-1').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('trial_cancelled_read_only');
    expect(friendlyError(err)).toContain('trial was cancelled');
    // Never the generic 409 fallback ("A resource with that name already exists.").
    expect(friendlyError(err)).not.toContain('already exists');
  });

  test('a plain 409 (unrelated code) is NOT given a code — the whitelist stays narrow', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'some_other_conflict' }, 409));

    const { createShare } = await loadFreshApi();
    const err = await createShare('file-1').catch((caught) => caught);

    expect(err.code).toBeUndefined();
  });
});

describe('friendlyError — quota_exceeded with is_trial_cap (25 GB active-trial cap)', () => {
  test('is_trial_cap: true gets the trial-cap message, no purchase CTA (task 1400)', async () => {
    const { ApiError, friendlyError } = await loadFreshApi();
    const err = new ApiError(413, 'server cap message', 'quota_exceeded', undefined, true);
    const msg = friendlyError(err);
    expect(msg).toBe('This account is on the 25 GB trial storage cap. Free up space to keep uploading.');
    expect(msg).not.toMatch(/web|payment|\bplan\b|pay now/i);
  });

  test('is_trial_cap: false (an ordinary plan-quota hit) keeps the existing generic message', async () => {
    const { ApiError, friendlyError } = await loadFreshApi();
    const err = new ApiError(413, 'server cap message', 'quota_exceeded', undefined, false);
    expect(friendlyError(err)).toBe('This account has reached its storage limit. Free up space to keep uploading.');
  });

  test('is_trial_cap absent (older server) keeps the existing generic message', async () => {
    const { ApiError, friendlyError } = await loadFreshApi();
    const err = new ApiError(413, 'server cap message', 'quota_exceeded');
    expect(friendlyError(err)).toBe('This account has reached its storage limit. Free up space to keep uploading.');
  });
});
