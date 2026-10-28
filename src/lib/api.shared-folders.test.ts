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
beforeEach(() => { fetchCalls.length = 0; fetchQueue = []; });
function respond(body: unknown) { fetchQueue.push(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })); }
function sent() { const { url, init } = fetchCalls.at(-1)!; return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : null }; }
test('publishSharedFolderKeys_body_is_keys_array_plus_format_l7', async () => {
  const keys = [{ file_id: 'file', encrypted_file_key: 'wrapped' }]; respond({ written: 1, skipped: 0 });
  expect(await api.publishSharedFolderKeys('folder', keys)).toEqual({ written: 1, skipped: 0 });
  expect(sent()).toEqual({ url: 'https://api.test/api/v1/shared-folders/folder/keys', method: 'POST', body: { keys, format: 'l7' } });
});
test('getFileOwnerWrap_accepts_base64_and_byte_array_owner_wraps', async () => {
  for (const owner_wrapped_file_key of ['AQID', [1, 2, 3]]) {
    respond({ owner_wrapped_file_key, acted_via_share_id: 'link' });
    expect(await api.getFileOwnerWrap('file')).toEqual({ ownerWrap: new Uint8Array([1, 2, 3]), actedViaShareId: 'link' });
  }
  respond({}); expect(await api.getFileOwnerWrap('file')).toEqual({ ownerWrap: null, actedViaShareId: null });
});
test('the_resolver_and_publisher_endpoints_use_the_server_paths_and_envelopes', async () => {
  respond({ flags: {} }); expect(await api.getEvaluateFlags()).toEqual({ flags: {} }); expect(sent().url).toEndWith('/feature-flags/evaluate');
  respond({ links: [{ id: 'l' }] }); expect(await api.listFolderLinks('a b')).toEqual([{ id: 'l' }]); expect(sent().url).toEndWith('/shares/folder-links?folder_id=a%20b');
  respond({ folder_id: 'f' }); await api.getSharedFolder('f'); expect(sent().url).toEndWith('/shared-folders/f'); expect(sent().method).toBe('GET');
  respond({ keys: [], next_cursor: null }); await api.listSharedFolderKeys('f', { limit: 1000, cursor: 'a+b' }); expect(sent().url).toEndWith('/shared-folders/f/keys?limit=1000&cursor=a%2Bb');
  respond({ keys: [], next_cursor: null }); await api.listSharedFolderKeys('f', { limit: 5, cursor: null }); expect(sent().url).toEndWith('/shared-folders/f/keys?limit=5');
});
test('the_six_functions_the_resolver_and_publisher_call_exist_in_this_api', () => {
  for (const name of ['getEvaluateFlags', 'listFolderLinks', 'getSharedFolder', 'listSharedFolderKeys', 'getFileOwnerWrap', 'publishSharedFolderKeys']) expect(typeof api[name]).toBe('function');
});
