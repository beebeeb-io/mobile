// @ts-nocheck
/**
 * Task 2233 item 1 (A5, adversarial case 2) — the thumbnail cache write takes
 * the decrypted bytes, and an aborted (unmounted) load never writes.
 *
 * Runs the REAL `thumbnail.ts` / `thumbnail-cache.ts` pipeline over a fake
 * network and a fake modern-file-system adapter:
 *  - the write receives a `Uint8Array` (no base64 encode, no legacy
 *    `writeAsStringAsync` with Base64);
 *  - the directory is created once per session, not per tile;
 *  - aborting mid-decrypt returns null and performs no write.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  response: null as any,
  decrypt: null as null | ((nonce: Uint8Array, ciphertext: Uint8Array) => Promise<Uint8Array>),
  writes: [] as Array<{ uri: string; bytes: Uint8Array }>,
  dirs: 0,
  legacyWrites: 0,
  legacyMkdirs: 0,
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
  decryptChunk: async (_key: unknown, nonce: Uint8Array, ciphertext: Uint8Array) =>
    state.decrypt ? state.decrypt(nonce, ciphertext) : new Uint8Array(),
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
  makeDirectoryAsync: async () => { state.legacyMkdirs += 1; },
  writeAsStringAsync: async () => { state.legacyWrites += 1; },
  copyAsync: async () => undefined,
  moveAsync: async () => undefined,
}));
mock.module('expo-media-library/legacy', () => ({
  getAssetInfoAsync: async () => null,
  requestPermissionsAsync: async () => ({ granted: false }),
}));
mock.module('./thumbnail-fs-modern', () => ({
  getModernThumbnailFs: () => ({
    ensureDir: async () => { state.dirs += 1; },
    writeBytes: async (uri: string, bytes: Uint8Array) => { state.writes.push({ uri, bytes }); },
  }),
  resetModernThumbnailFsForTests: () => {},
}));
mock.module('./api', () => ({
  uploadThumbnail: async () => undefined,
  downloadFile: async () => { throw new Error('not used'); },
  getApiUrl: () => 'https://api.beebeeb.io',
  getToken: async () => 'test-token',
  thumbnailUrl: (id: string, variant = 'medium') =>
    `https://api.beebeeb.io/api/v1/files/${id}/thumbnail${variant === 'medium' ? '' : `/${variant}`}`,
}));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async () => state.response,
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

const { clearThumbnailCache } = await import('./thumbnail-cache');
const { fetchDecryptedThumbnailUri } = await import('./thumbnail');

const PLAIN = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

function encryptedFrame(): Uint8Array {
  const out = new Uint8Array(12 + 8);
  out.set(PLAIN, 12);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 1));
}

describe('task 2233 A5 — byte writes, no base64, one mkdir per session', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    state.writes = [];
    state.dirs = 0;
    state.legacyWrites = 0;
    state.legacyMkdirs = 0;
    state.response = responseFor(encryptedFrame());
    state.decrypt = async () => PLAIN;
  });

  test('the cache write receives the decrypted Uint8Array; no base64 writer runs', async () => {
    const uri = await fetchDecryptedThumbnailUri('bytes-1', new Uint8Array(32));
    expect(uri).toBe('file:///doc/beebeeb-thumbnails-v3/bytes-1.medium.webp');
    expect(state.writes.length).toBe(1);
    expect(state.writes[0].bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(state.writes[0].bytes)).toEqual(Array.from(PLAIN));
    expect(state.legacyWrites).toBe(0);

    // A second tile reuses the session's directory creation.
    await fetchDecryptedThumbnailUri('bytes-2', new Uint8Array(32));
    expect(state.writes.length).toBe(2);
    expect(state.dirs).toBe(1);
    expect(state.legacyMkdirs).toBe(0);
  });

  test('case 2: aborting mid-decrypt returns null and writes nothing', async () => {
    let resolveDecrypt: (b: Uint8Array) => void = () => {};
    state.decrypt = () => new Promise((resolve) => { resolveDecrypt = resolve; });

    const controller = new AbortController();
    const pending = fetchDecryptedThumbnailUri('abort-1', new Uint8Array(32), controller.signal);
    await waitFor(() => typeof resolveDecrypt === 'function' && state.response !== null);
    // Wait until the decrypt is actually in flight.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    resolveDecrypt(PLAIN);

    expect(await pending).toBeNull();
    expect(state.writes.length).toBe(0);
  });
});
