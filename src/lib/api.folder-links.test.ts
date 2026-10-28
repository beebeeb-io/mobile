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
test('createFolderLink_sends_format_l7_no_folder_keys_and_a_43_char_token', async () => {
  const body = { folder_id: 'folder', token: 'A'.repeat(43), access_level: 'add', wrapped_folder_key: 'wrap', owner_wrapped_key: 'owner', owner_wrapped_token: 'token-wrap' };
  respond({ id: 'link', ...body }); await api.createFolderLink(body);
  expect(sent()).toEqual({ url: 'https://api.test/api/v1/shares/folder-links', method: 'POST', body: { ...body, format: 'l7' } });
  expect(sent().body).not.toHaveProperty('folder_keys');
});
test('folder_endpoint_methods_paths_and_response_envelopes_match_the_server', async () => {
  respond({ id: 'l' }); await api.updateFolderLink('l', { paused: true, expires_in_hours: null }); expect(sent().method).toBe('PATCH'); expect(sent().body).toEqual({ paused: true, expires_in_hours: null });
  respond({}); await api.revokeFolderLink('l'); expect(sent().method).toBe('DELETE');
  respond({ members: [], folder_id: 'f', owner_id: 'o' }); await api.getFolderMembers('f'); expect(sent().url).toEndWith('/shares/invites/folder-members/f');
  respond({ created: true, key_version: 1 }); await api.registerSharedFolderKey('f', { owner_wrapped_folder_key: 'w', key_version: 1 }); expect(sent().method).toBe('PUT'); expect(sent().url).toEndWith('/shared-folders/f/key');
  respond({ adopted: true }); await api.adoptOwnerFileKey('i', 'w'); expect(sent().body).toEqual({ owner_wrapped_file_key: 'w' }); expect(sent().url).toEndWith('/files/i/owner-key');
  respond({ activity: [] }); expect(await api.getSharedFolderActivity('f', 20)).toEqual([]); expect(sent().url).toEndWith('/shared-folders/f/activity?limit=20');
});

test('L10_the_custody_refusals_reach_the_screen_as_their_own_message_not_a_generic_error', async () => {
  const { CustodyUnavailableError, UpgradeRequiredError } = await import('./shared-folder-custody');
  expect(api.friendlyError(new CustodyUnavailableError())).toBe("This folder's keys are unavailable");
  expect(api.friendlyError(new UpgradeRequiredError())).toBe('The owner must convert this folder first');
});

// request() keeps ApiError.code only for an allowlist. link creation branches on these codes (re-mint the
// token, re-register custody, the 20-links line, the nested-share line), so they must survive real responses.
function respondStatus(status: number, body: unknown) { fetchQueue.push(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); }
test('the_folder_link_error_codes_survive_request_and_reach_the_recovery_paths', async () => {
  const { linkErrorCode } = await import('./folder-link-types');
  for (const code of ['folder_key_missing', 'too_many_links', 'token_taken', 'nested_share', 'cap_below_used', 'key_version_conflict']) {
    respondStatus(409, { error: code, message: 'refused' });
    const err = await api.createFolderLink({ folder_id: 'f', token: 'A'.repeat(43), access_level: 'add', wrapped_folder_key: 'w', owner_wrapped_key: 'o', owner_wrapped_token: 't' }).catch((e: unknown) => e);
    expect(err.status).toBe(409); expect(err.code).toBe(code);
    if (code !== 'key_version_conflict') expect(linkErrorCode(err)).toBe(code);
  }
});
test('an_unrelated_409_code_stays_code_less', async () => {
  respondStatus(409, { error: 'something_else', message: 'nope' });
  const err = await api.createFolderLink({ folder_id: 'f', token: 'A'.repeat(43), access_level: 'add', wrapped_folder_key: 'w', owner_wrapped_key: 'o', owner_wrapped_token: 't' }).catch((e: unknown) => e);
  expect(err.code).toBeUndefined();
});
