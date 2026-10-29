// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let secureStoreGetQueue: Array<(key: string) => Promise<string | null>> = [];
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
  getItemAsync: async (key: string) => {
    const next = secureStoreGetQueue.shift();
    if (next) return next(key);
    return store.get(key) ?? null;
  },
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

const api = await import('./api');
const custody = await import('./shared-folder-custody');
beforeEach(() => { fetchCalls.length = 0; fetchQueue = []; });
function respondStatus(status: number, body: unknown) { fetchQueue.push(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); }

// P2-4: request() keeps ApiError.code only for an allowlist; the custody contract codes were not on it,
// so toUpgradeRequired() never matched a real response.
describe('the custody contract codes survive request()', () => {
  test('a 409 upgrade_required keeps its code, and toUpgradeRequired recognises the real error', async () => {
    respondStatus(409, { error: 'upgrade_required' });
    const err = await api.getFile('file').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('upgrade_required');
    expect(custody.toUpgradeRequired(err)).toBeInstanceOf(custody.UpgradeRequiredError);
  });

  test('a 400 invalid_format keeps its code', async () => {
    respondStatus(400, { error: 'invalid_format' });
    const err = await api.getFile('file').catch((e: unknown) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_format');
  });

  test('an unrelated 409 body stays code-less, as before', async () => {
    respondStatus(409, { error: 'something_else', message: 'nope' });
    const err = await api.getFile('file').catch((e: unknown) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBeUndefined();
    expect(custody.toUpgradeRequired(err)).toBeNull();
  });
});
