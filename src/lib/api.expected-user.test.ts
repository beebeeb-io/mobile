// @ts-nocheck
/**
 * Task 1594 fix 4 — `X-Beebeeb-Expected-User` (server task 1554, auth.rs:93).
 *
 * The server refuses (409 `account_mismatch`) any authenticated request whose
 * header names a different user than the session's. Mirroring web
 * (`packages/shared/src/api/request.ts` + `config.ts`): the header carries the
 * id of the account the UNLOCKED master key is bound to, is sent on mutating
 * requests only, and is absent when no key is unlocked. A 409
 * `account_mismatch` ends the local session (the key/session pairing is wrong
 * and must not be trusted further).
 *
 * Every native module is mocked here (isolated-runner rule).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
const rawFetchCalls: Array<{ url: string; init: RequestInit }> = [];

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
  default: { expoConfig: { version: '9.9.9', extra: { apiUrl: 'https://api.test' } } },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => true,
  planUploadChunksNative: () => ({ chunkSizeBytes: 4_194_304, chunkCount: 1 }),
  uploadChunksNative: async () => ({ chunksUploaded: 1, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 }),
}));
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }));
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

const OWNER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  rawFetchCalls.length = 0;
  fetchQueue = [];
  store.set('beebeeb_session_token', 'test-token');
});

describe('1594 — X-Beebeeb-Expected-User on authenticated mutations', () => {
  test('a mutating request carries the unlocked key owner; a GET does not', async () => {
    const { setExpectedUserId } = await import('./expected-user');
    const api = await import('./api');
    setExpectedUserId(OWNER);

    fetchQueue.push(async () => jsonResponse({ id: 'folder-1', name_encrypted: 'x', is_folder: true }));
    await api.createFolder('cipher-name', undefined, 'folder-1');
    fetchQueue.push(async () => jsonResponse({ user_id: OWNER, email: 'a@beebeeb.io', email_verified: true, created_at: 'x' }));
    await api.getMe();

    expect(fetchCalls[0].init.method).toBe('POST');
    expect(headerValue(fetchCalls[0].init, 'X-Beebeeb-Expected-User')).toBe(OWNER);
    expect(fetchCalls[1].init.method).toBe('GET');
    expect(headerValue(fetchCalls[1].init, 'X-Beebeeb-Expected-User')).toBeUndefined();
    setExpectedUserId(null);
  });

  test('no unlocked key → no header', async () => {
    const { setExpectedUserId } = await import('./expected-user');
    const api = await import('./api');
    setExpectedUserId(null);

    fetchQueue.push(async () => jsonResponse({ id: 'folder-2', name_encrypted: 'x', is_folder: true }));
    await api.createFolder('cipher-name', undefined, 'folder-2');
    expect(headerValue(fetchCalls[0].init, 'X-Beebeeb-Expected-User')).toBeUndefined();
  });

  test('a 409 account_mismatch ends the local session', async () => {
    const { setExpectedUserId } = await import('./expected-user');
    const api = await import('./api');
    setExpectedUserId(OWNER);
    let expired = 0;
    api.registerSessionExpiredHandler(() => { expired += 1; });

    fetchQueue.push(async () => jsonResponse({ error: 'account_mismatch', message: "This session doesn't match the expected account." }, 409));
    await expect(api.createFolder('cipher-name', undefined, 'folder-3')).rejects.toMatchObject({ status: 409 });

    expect(expired).toBe(1);
    expect(store.has('beebeeb_session_token')).toBe(false);
    setExpectedUserId(null);
  });

  test('the native upload init (raw fetch) carries the header too', async () => {
    const { setExpectedUserId } = await import('./expected-user');
    const api = await import('./api');
    setExpectedUserId(OWNER);
    fetchQueue.push(
      async () => jsonResponse({ file_id: 'SERVER-ID', upload_session_id: 's1', chunk_size_bytes: 4_194_304, chunk_count: 1 }),
      async () => jsonResponse({ id: 'SERVER-ID', name_encrypted: 'name-cipher' }),
    );
    await api.uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    });
    const init = fetchCalls.find((c) => c.url.includes('/api/v1/uploads/init'));
    const complete = fetchCalls.find((c) => c.url.includes('/complete'));
    expect(headerValue(init!.init, 'X-Beebeeb-Expected-User')).toBe(OWNER);
    expect(headerValue(complete!.init, 'X-Beebeeb-Expected-User')).toBe(OWNER);
    setExpectedUserId(null);
  });
});
