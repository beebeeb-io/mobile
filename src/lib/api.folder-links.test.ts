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
test('createFolderLink_sends_no_folder_keys_and_a_43_char_token', async () => {
  const body = { folder_id: 'folder', token: 'A'.repeat(43), access_level: 'add', wrapped_folder_key: 'wrap', owner_wrapped_key: 'owner', owner_wrapped_token: 'token-wrap' };
  respond({ id: 'link', ...body }); await api.createFolderLink(body);
  expect(sent()).toEqual({ url: 'https://api.test/api/v1/shares/folder-links', method: 'POST', body });
  expect(sent().body).not.toHaveProperty('folder_keys');
});
test('publishSharedFolderKeys_body_is_keys_array_of_file_id_and_encrypted_file_key', async () => {
  const keys = [{ file_id: 'file', encrypted_file_key: 'wrapped' }]; respond({ written: 1, skipped: 0 });
  expect(await api.publishSharedFolderKeys('folder', keys)).toEqual({ written: 1, skipped: 0 });
  expect(sent()).toEqual({ url: 'https://api.test/api/v1/shared-folders/folder/keys', method: 'POST', body: { keys } });
});
test('getFileOwnerWrap_accepts_base64_and_byte_array_owner_wraps', async () => {
  for (const owner_wrapped_file_key of ['AQID', [1, 2, 3]]) {
    respond({ owner_wrapped_file_key, acted_via_share_id: 'link' });
    expect(await api.getFileOwnerWrap('file')).toEqual({ ownerWrap: new Uint8Array([1, 2, 3]), actedViaShareId: 'link' });
  }
  respond({}); expect(await api.getFileOwnerWrap('file')).toEqual({ ownerWrap: null, actedViaShareId: null });
});
test('folder_endpoint_methods_paths_and_response_envelopes_match_the_server', async () => {
  respond({ flags: {} }); expect(await api.getEvaluateFlags()).toEqual({ flags: {} }); expect(sent().url).toEndWith('/feature-flags/evaluate');
  respond({ links: [{ id: 'l' }] }); expect(await api.listFolderLinks('a b')).toEqual([{ id: 'l' }]); expect(sent().url).toEndWith('/shares/folder-links?folder_id=a%20b');
  respond({ id: 'l' }); await api.updateFolderLink('l', { paused: true, expires_in_hours: null }); expect(sent().method).toBe('PATCH'); expect(sent().body).toEqual({ paused: true, expires_in_hours: null });
  respond({}); await api.revokeFolderLink('l'); expect(sent().method).toBe('DELETE');
  respond({ members: [], folder_id: 'f', owner_id: 'o' }); await api.getFolderMembers('f'); expect(sent().url).toEndWith('/shares/invites/folder-members/f');
  respond({ folder_id: 'f' }); await api.getSharedFolder('f'); expect(sent().url).toEndWith('/shared-folders/f');
  respond({ created: true, key_version: 1 }); await api.registerSharedFolderKey('f', { owner_wrapped_folder_key: 'w', key_version: 1 }); expect(sent().method).toBe('PUT'); expect(sent().url).toEndWith('/shared-folders/f/key');
  respond({ keys: [], next_cursor: null }); await api.listSharedFolderKeys('f', { limit: 1000, cursor: 'a+b' }); expect(sent().url).toEndWith('/shared-folders/f/keys?limit=1000&cursor=a%2Bb');
  respond({ adopted: true }); await api.adoptOwnerFileKey('i', 'w'); expect(sent().body).toEqual({ owner_wrapped_file_key: 'w' }); expect(sent().url).toEndWith('/files/i/owner-key');
  respond({ activity: [] }); expect(await api.getSharedFolderActivity('f', 20)).toEqual([]); expect(sent().url).toEndWith('/shared-folders/f/activity?limit=20');
});
