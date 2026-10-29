// @ts-nocheck
/**
 * Task 2233 round 2 (P2-7) — an account switch during a RUNNING load drops
 * the write.
 *
 * The queue captures the account epoch when a job is enqueued and hands it to
 * the loader. Right before the gated write, `fetchDecryptedThumbnailUri`
 * re-checks it: if the account moved, the bytes belong to the previous
 * account — no file is written and the caller gets CANCELLED.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  response: null as any,
  fetchCalls: 0,
  writes: [] as Array<{ uri: string; bytes: Uint8Array }>,
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
  decryptChunk: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]),
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
  getInfoAsync: async () => ({ exists: false }),
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => undefined,
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
    writeBytes: async (uri: string, bytes: Uint8Array) => { state.writes.push({ uri, bytes }); },
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

const { THUMBNAIL_LOAD_CANCELLED } = await import('./thumbnail-load-outcome');
const { accountEpoch, advanceAccountEpoch } = await import('./account-epoch');
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

describe('task 2233 round 2 P2-7 — epoch captured at enqueue guards the write', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    state.writes = [];
    state.fetchCalls = 0;
    state.response = responseFor(encryptedFrame());
  });

  test('an epoch advance mid-fetch writes no file and resolves CANCELLED', async () => {
    let releaseResponse: (value: unknown) => void = () => {};
    state.response = new Promise((resolve) => { releaseResponse = resolve; });

    const epoch = accountEpoch();
    const pending = fetchDecryptedThumbnailUri('epoch-1', new Uint8Array(32), undefined, epoch);

    // Wait until the network request is in flight, then switch accounts.
    for (let i = 0; i < 100 && state.fetchCalls === 0; i++) await new Promise((r) => setTimeout(r, 1));
    expect(state.fetchCalls).toBe(1);
    advanceAccountEpoch();
    releaseResponse(responseFor(encryptedFrame()));

    expect(await pending).toBe(THUMBNAIL_LOAD_CANCELLED);
    expect(state.writes.length).toBe(0);
  });

  test('the same epoch lets the write through (control)', async () => {
    const epoch = accountEpoch();
    const uri = await fetchDecryptedThumbnailUri('epoch-2', new Uint8Array(32), undefined, epoch);
    expect(uri).toBe('file:///doc/beebeeb-thumbnails-v3/epoch-2.medium.webp');
    expect(state.writes.length).toBe(1);
  });
});
