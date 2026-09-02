// @ts-nocheck
/**
 * Regression pin for task 1351 (P0): the native manual-upload path
 * (`uploadEncryptedFileNative`) MUST encrypt every chunk under the id the
 * file is actually stored under (the server-minted `file_id`), never the
 * ephemeral client-generated id. Task 1349 found the native bridge was
 * handed the client id while the file lived under the server id — chunks
 * encrypted under a key nobody could ever re-derive.
 *
 * These tests drive `uploadEncryptedFileNative` end-to-end (mocking only the
 * native bridge + network) and assert on the `fileId` the mocked bridge
 * actually received. Isolated per bun:test-per-file semantics — every native
 * module this file needs is mocked here (see mobile/CLAUDE.md "Tests").
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
const nativeUploadCalls: Array<Record<string, unknown>> = [];
let nativeUploadImpl: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
  chunksUploaded: 1,
  bytesUploaded: 0,
  bytesTotal: 0,
  cryptoBytesPerSec: 0,
});

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
  isNativeUploadAvailable: () => true,
  planUploadChunksNative: () => ({ chunkSizeBytes: 4_194_304, chunkCount: 1 }),
  uploadChunksNative: async (params: Record<string, unknown>) => {
    nativeUploadCalls.push(params);
    return nativeUploadImpl(params);
  },
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?nativeUploadTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  nativeUploadCalls.length = 0;
  nativeUploadImpl = async () => ({ chunksUploaded: 1, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 });
});

describe('uploadEncryptedFileNative — encrypts under the server file id (task 1351)', () => {
  test('fresh upload: bridge receives the SERVER-minted file id, not the client id', async () => {
    store.set('beebeeb_session_token', 'test-token');
    fetchQueue.push(
      // POST /api/v1/uploads/init
      async () => jsonResponse({
        file_id: 'SERVER-ID',
        upload_session_id: 'upload-session-1',
        chunk_size_bytes: 4_194_304,
        chunk_count: 1,
      }),
      // POST /api/v1/uploads/:id/complete
      async () => jsonResponse({ id: 'SERVER-ID', name_encrypted: 'name-cipher' }),
    );

    const { uploadEncryptedFileNative } = await loadFreshApi();

    const result = await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    });

    expect(result?.id).toBe('SERVER-ID');
    expect(nativeUploadCalls).toHaveLength(1);
    expect(nativeUploadCalls[0].fileId).toBe('SERVER-ID');
    expect(nativeUploadCalls[0].fileId).not.toBe('CLIENT-ID');
  });

  test('resumed upload: bridge receives the STORED server file id, not a fresh client id', async () => {
    store.set('beebeeb_session_token', 'test-token');
    store.set('beebeeb_upload_resume_resume-key-1', JSON.stringify({
      protocol: 'v2',
      fileId: 'STORED-SERVER-ID',
      uploadSessionId: 'upload-session-resume',
      chunkSizeBytes: 4_194_304,
      chunkCount: 1,
      plaintextSizeBytes: 2_000_000,
      parentId: null,
      mimeType: null,
      lastUploadedChunkIndex: -1,
    }));
    fetchQueue.push(
      // POST /api/v1/uploads/:id/complete — no init call, this is a resume
      async () => jsonResponse({ id: 'STORED-SERVER-ID', name_encrypted: 'name-cipher' }),
    );

    const { uploadEncryptedFileNative } = await loadFreshApi();

    const result = await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'FRESH-CLIENT-ID-2',
      inputUri: 'file:///tmp/clip.mp4',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
      resumeKey: 'resume-key-1',
    });

    expect(result?.id).toBe('STORED-SERVER-ID');
    expect(nativeUploadCalls).toHaveLength(1);
    expect(nativeUploadCalls[0].fileId).toBe('STORED-SERVER-ID');
    expect(nativeUploadCalls[0].fileId).not.toBe('FRESH-CLIENT-ID-2');
  });
});
