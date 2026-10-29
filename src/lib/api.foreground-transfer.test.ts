// @ts-nocheck
/**
 * Task 1578 — `uploadEncryptedChunked({ foregroundTransfer: true })` must PUT
 * its chunks over a FOREGROUND URLSession. expo-file-system's legacy
 * `uploadAsync` defaults to a BACKGROUND session (tasks run in nsurlsessiond
 * and iOS may defer them) — on device the text editor's Save spinner kept
 * running. Every other caller keeps today's default (no `sessionType` sent).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let fetchQueue: Array<() => Promise<Response>> = [];
const uploadAsyncCalls: Array<{ url: string; options: Record<string, unknown> }> = [];

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
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
  uploadAsync: async (url: string, _uri: string, options: Record<string, unknown>) => {
    uploadAsyncCalls.push({ url, options });
    return { status: 200, body: '{}', headers: {} };
  },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => null,
  uploadChunksNative: async () => { throw new Error('native path not expected'); },
}));
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }));
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string) => {
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function runUpload(foregroundTransfer: boolean | undefined) {
  store.set('beebeeb_session_token', 'test-token');
  fetchQueue.push(
    async () => jsonResponse({ file_id: 'F', upload_session_id: 'S', chunk_size_bytes: 4_194_304, chunk_count: 1 }),
    async () => jsonResponse({ id: 'F', name_encrypted: 'n', version_number: 3 }),
  );
  const { uploadEncryptedChunked } = await import(`./api?fgTest=${Math.random()}`);
  return uploadEncryptedChunked({
    fileId: 'F',
    nameEncrypted: 'n',
    v2InitNameEncrypted: 'n',
    plaintextSizeBytes: 5,
    versionReplace: { fileId: 'F', baseVersionNumber: 2 },
    readEncryptedChunk: async () => new Uint8Array(33),
    ...(foregroundTransfer === undefined ? {} : { foregroundTransfer }),
  });
}

beforeEach(() => {
  store.clear();
  fetchQueue = [];
  uploadAsyncCalls.length = 0;
});

describe('uploadEncryptedChunked chunk transport (task 1578)', () => {
  test('foregroundTransfer: true -> chunk PUT uses the FOREGROUND session', async () => {
    const result = await runUpload(true);
    expect(result.version_number).toBe(3);
    expect(uploadAsyncCalls).toHaveLength(1);
    expect(uploadAsyncCalls[0].url).toBe('https://api.test/api/v1/uploads/S/chunks/0');
    expect(uploadAsyncCalls[0].options.sessionType).toBe(1);
  });

  test('default callers are unchanged: no sessionType (expo default)', async () => {
    await runUpload(undefined);
    expect(uploadAsyncCalls).toHaveLength(1);
    expect('sessionType' in uploadAsyncCalls[0].options).toBe(false);
  });
});
