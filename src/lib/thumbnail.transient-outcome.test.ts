// @ts-nocheck
/**
 * Task 2233 round 3 (N1) — transient failures must not resolve the same as
 * "this file has no thumbnail".
 *
 * `fetchDecryptedThumbnailUri` returned plain `null` for the backoff skip,
 * 429/5xx, a fetch that throws and a failed write; `useThumbnail` turned that
 * into `failed:true` → `has_thumbnail:false` for the session. Those four cases
 * now resolve THUMBNAIL_LOAD_TRANSIENT. Only a real 404 / missing thumbnail /
 * decrypt failure / too-short frame resolves null.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  response: null as any,
  fetchCalls: 0,
  fetchThrows: false,
  decryptFails: false,
  folderExists: true,
  writeFails: false,
  writes: 0,
};

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
  encryptChunk: async () => new Uint8Array(),
  decryptChunk: async () => {
    if (state.decryptFails) throw new Error('decrypt failed');
    return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  },
  generateVideoThumbnail: async () => null,
  generateDngThumbnail: async () => null,
  generateAndUploadPhotoLibraryThumbnailNative: async () => null,
  handleDecryptChunk: async () => new Uint8Array(),
}));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  readDirectoryAsync: async () => [],
  getInfoAsync: async (uri: string) => ({ exists: state.folderExists && uri.endsWith('/') }),
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => { state.writes += 1; },
  copyAsync: async () => undefined,
  moveAsync: async () => undefined,
}));
mock.module('expo-media-library/legacy', () => ({
  getAssetInfoAsync: async () => null,
  requestPermissionsAsync: async () => ({ granted: false }),
}));
mock.module('./thumbnail-fs-modern', () => ({
  getModernThumbnailFs: () => ({
    ensureDir: async () => undefined,
    writeBytes: async () => {
      state.writes += 1;
      if (state.writeFails) throw new Error('No space left on device');
    },
  }),
  resetModernThumbnailFsForTests: () => {},
}));
mock.module('./api', () => ({
  uploadThumbnail: async () => undefined,
  downloadFile: async () => { throw new Error('not used'); },
  getApiUrl: () => 'https://api.beebeeb.io',
  getToken: async () => 'test-token',
  thumbnailUrl: (id: string) => `https://api.beebeeb.io/api/v1/files/${id}/thumbnail`,
}));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async () => {
    state.fetchCalls += 1;
    if (state.fetchThrows) throw new Error('network down');
    return state.response;
  },
}));
mock.module('./encrypted-download', () => ({
  decryptEncryptedBytes: async () => new Uint8Array(),
  inferChunkCountFromEncryptedSize: () => 1,
}));
mock.module('./shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: () => false,
  getSharedKeyResolver: () => null,
}));
mock.module('./shared-folder-tree', () => ({ isForeignSharedFile: () => false }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));

const outcome = await import('./thumbnail-load-outcome');
const { THUMBNAIL_LOAD_CANCELLED, THUMBNAIL_LOAD_TRANSIENT } = outcome;
const { clearThumbnailCache } = await import('./thumbnail-cache');
const { fetchDecryptedThumbnailUri } = await import('./thumbnail');

function encryptedFrame(): Uint8Array {
  const out = new Uint8Array(12 + 8);
  out.set(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]), 12);
  return out;
}

function responseFor(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function failureResponse(status: number, retryAfter: string | null = null) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe('task 2233 round 3 N1 — transient outcomes in fetchDecryptedThumbnailUri', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    state.response = responseFor(encryptedFrame());
    state.fetchCalls = 0;
    state.fetchThrows = false;
    state.decryptFails = false;
    state.folderExists = true;
    state.writeFails = false;
    state.writes = 0;
  });

  test('a 404 is unavailable (null), not transient', async () => {
    state.response = failureResponse(404);
    expect(await fetchDecryptedThumbnailUri('missing-404', new Uint8Array(32))).toBeNull();
  });

  test('a decrypt failure is unavailable (null), not transient', async () => {
    state.decryptFails = true;
    expect(await fetchDecryptedThumbnailUri('bad-decrypt', new Uint8Array(32))).toBeNull();
  });

  test('a failed write is transient', async () => {
    state.writeFails = true;
    expect(await fetchDecryptedThumbnailUri('write-fails', new Uint8Array(32))).toBe(THUMBNAIL_LOAD_TRANSIENT);
    expect(state.writes).toBe(1);
  });

  test('a fetch that throws is transient', async () => {
    state.fetchThrows = true;
    expect(await fetchDecryptedThumbnailUri('fetch-throws', new Uint8Array(32))).toBe(THUMBNAIL_LOAD_TRANSIENT);
  });

  test('429 is transient and starts the backoff', async () => {
    state.response = failureResponse(429, '2');
    expect(await fetchDecryptedThumbnailUri('limited-429', new Uint8Array(32))).toBe(THUMBNAIL_LOAD_TRANSIENT);
    expect(state.fetchCalls).toBe(1);
  });

  test('a request skipped during backoff is transient and never hits the network', async () => {
    const before = state.fetchCalls;
    expect(await fetchDecryptedThumbnailUri('during-backoff', new Uint8Array(32))).toBe(THUMBNAIL_LOAD_TRANSIENT);
    expect(state.fetchCalls).toBe(before);
  });

  test('an abort still resolves CANCELLED, not transient', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await fetchDecryptedThumbnailUri('aborted', new Uint8Array(32), controller.signal)).toBe(THUMBNAIL_LOAD_CANCELLED);
  });
});
