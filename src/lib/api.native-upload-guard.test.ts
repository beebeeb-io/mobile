// @ts-nocheck
/**
 * Task 1351 — proves the completion guard is a REAL assertion, not a
 * tautology. An independent review of the branch found the original guard
 * compared `nativeEncryptionFileId` (a variable assigned directly from
 * `serverFileId` and never reassigned) against `serverFileId` itself — two
 * names for the identical value, so it could never fire no matter what id
 * the native bridge call actually sent. The reviewer proved this by
 * reintroducing task 1351's original bug at the call site and showing the
 * guard stayed silent.
 *
 * `api.ts` now derives the guard's input from `uploadChunksNativeTracked`'s
 * result (native-upload-bridge.ts) — the id read off the SAME params object
 * actually forwarded to the bridge, not a caller-local alias. This test
 * mocks `uploadChunksNativeTracked` to report an id DIFFERENT from the
 * upload session's server file id — simulating exactly the drift the guard
 * exists to catch — and asserts `uploadEncryptedFileNative` throws
 * `native_upload_id_mismatch` BEFORE ever calling the complete endpoint.
 *
 * Every other export of native-upload-bridge.ts used below (the guard
 * itself, `NativeUploadIdMismatchError`, `parseNativeUploadError`,
 * `nativeProgressToUploadProgress`, `resumeStateMatchesNativePlan`) is the
 * REAL implementation — imported here (executed) before `mock.module`
 * replaces the specifier for the api.ts import below, so the actual
 * guard/error-mapping logic under test is unmocked. Isolated per
 * bun:test-per-file semantics — every native module this file needs is
 * mocked here (see mobile/CLAUDE.md "Tests").
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  assertNativeUploadEncryptedUnderSessionId,
  NativeUploadIdMismatchError,
  nativeProgressToUploadProgress,
  parseNativeUploadError,
  resumeStateMatchesNativePlan,
} from './native-upload-bridge';

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
  isNativeUploadAvailable: () => true,
  planUploadChunksNative: () => ({ chunkSizeBytes: 4_194_304, chunkCount: 1 }),
  // api.ts still imports this to pass as `uploadChunksNativeTracked`'s
  // `call` argument, but the tracked wrapper is mocked below and never
  // actually invokes it in this file.
  uploadChunksNative: async () => ({ chunksUploaded: 1, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 }),
}));

// Only `uploadChunksNativeTracked` is faked; everything else re-exports the
// REAL implementation captured by the static import above, evaluated before
// this call replaces the specifier for api.ts's later dynamic import.
mock.module('./native-upload-bridge', () => ({
  assertNativeUploadEncryptedUnderSessionId,
  NativeUploadIdMismatchError,
  nativeProgressToUploadProgress,
  parseNativeUploadError,
  resumeStateMatchesNativePlan,
  uploadChunksNativeTracked: async () => ({
    chunksUploaded: 1,
    bytesUploaded: 2_000_000,
    bytesTotal: 2_000_000,
    cryptoBytesPerSec: 500_000_000,
    encryptedUnderFileId: 'BRIDGE-REPORTED-WRONG-ID',
  }),
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
  return import(`./api?nativeUploadGuardTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('uploadEncryptedFileNative — completion guard is real, not a tautology (task 1351)', () => {
  test('throws native_upload_id_mismatch and never calls complete when the bridge reports a different id than the server file id', async () => {
    store.set('beebeeb_session_token', 'test-token');
    fetchQueue.push(
      // POST /api/v1/uploads/init — the ONLY fetch this test expects. If
      // uploadEncryptedFileNative ever reached complete despite the
      // mismatch, the next fetch call would throw "unexpected fetch"
      // instead of the mismatch error asserted below.
      async () => jsonResponse({
        file_id: 'SERVER-ID',
        upload_session_id: 'upload-session-1',
        chunk_size_bytes: 4_194_304,
        chunk_count: 1,
      }),
    );

    const { uploadEncryptedFileNative } = await loadFreshApi();

    await expect(uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
    })).rejects.toMatchObject({ code: 'native_upload_id_mismatch' });

    expect(fetchCalls).toHaveLength(1); // only the init call
    expect(fetchCalls.every((c) => !c.url.includes('/complete'))).toBe(true);
  });
});
