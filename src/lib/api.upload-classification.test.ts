// @ts-nocheck
/**
 * Task 1959 round 4 — the JS uploaders record the `is_media` they sent on
 * init (keyed by the SERVER's file id) before the complete call, so a row the
 * sync write-through adds for this upload can be classified without asking
 * GET /files/index (upload-classification.ts, file-index-loader.ts).
 *
 * Harness copied from api.provenance-headers.test.ts (isolated runner: every
 * native module mocked here).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
const nativeUploadCalls: Array<Record<string, unknown>> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));

// No `version` on expoConfig here — proves the '1.0.0' fallback (matching
// device-registration.ts's existing convention) rather than a crash/undefined.
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
    return { chunksUploaded: 1, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 };
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
  return import(`./api?uploadClassificationTest=${Math.random()}`);
}

function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  nativeUploadCalls.length = 0;
});

const classification = await import('./upload-classification');

describe('JS uploads record their is_media for the index loader (1959 round 4)', () => {
  beforeEach(() => classification.resetUploadClassificationsForTests());

  test('native upload (v2 init): recorded under the server id before the complete call', async () => {
    store.set('beebeeb_session_token', 'test-token');
    let recordedAtComplete;
    fetchQueue.push(
      async () => jsonResponse({
        file_id: 'SERVER-ID',
        upload_session_id: 'upload-session-1',
        chunk_size_bytes: 4_194_304,
        chunk_count: 1,
      }),
      async () => {
        recordedAtComplete = Object.fromEntries(await classification.classifyOwnUploads(['SERVER-ID'], async () => new Map()));
        return jsonResponse({ id: 'SERVER-ID', name_encrypted: 'name-cipher' });
      },
    );
    const { uploadEncryptedFileNative } = await loadFreshApi();
    await uploadEncryptedFileNative({
      masterKeyHandleId: 1,
      fileId: 'CLIENT-ID',
      inputUri: 'file:///tmp/photo.jpg',
      nameEncrypted: 'name-cipher',
      plaintextSizeBytes: 2_000_000,
      isMedia: true,
    });
    expect(fetchCalls[1].url).toContain('/complete');
    expect(recordedAtComplete).toEqual({ 'SERVER-ID': true });
    const after = await classification.classifyOwnUploads(['SERVER-ID', 'CLIENT-ID'], async () => new Map());
    expect(Object.fromEntries(after)).toEqual({ 'SERVER-ID': true });
  });

  test('JS chunked upload of a document: recorded as is_media false (what it sent)', async () => {
    store.set('beebeeb_session_token', 'test-token');
    fetchQueue.push(
      async () => jsonResponse({
        file_id: 'server-doc',
        upload_session_id: 'upload-session-2',
        chunk_size_bytes: 1024,
        chunk_count: 1,
      }),
      async () => new Response('{}', { status: 200 }),
      async () => jsonResponse({ id: 'server-doc', name_encrypted: 'n' }),
    );
    const { uploadEncryptedChunked } = await loadFreshApi();
    await uploadEncryptedChunked({
      fileId: 'client-doc',
      nameEncrypted: 'n',
      plaintextSizeBytes: 1,
      readEncryptedChunk: async () => new Uint8Array(29),
    });
    const out = await classification.classifyOwnUploads(['server-doc'], async () => new Map());
    expect(Object.fromEntries(out)).toEqual({ 'server-doc': false });
  });
});
