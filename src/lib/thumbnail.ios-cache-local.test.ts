// @ts-nocheck
/**
 * Task 2233 round 2 (P2-4) — iOS behaviour change.
 *
 * Round 1 made `cacheLocalThumbnail` write `<id>.medium.webp` via the
 * platform-neutral `cacheThumbnail`. On iOS that file is a hit for the native
 * `ThumbnailService.diskCacheURL`, which owns the iOS thumbnail cache. On main
 * the function wrote nothing on iOS (the base64 writer threw, caught →
 * null). Required: no write on iOS, return null; Android unchanged.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  platform: { OS: 'ios' },
  cacheWrites: 0,
  cacheReads: 0,
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
mock.module('react-native', () => ({ NativeModules: {}, Platform: state.platform }));
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
// Force image generation to succeed so the iOS guard is the only thing that
// can prevent the cache write.
mock.module('expo-image-manipulator', () => ({
  manipulateAsync: async () => ({ base64: 'AAECAwQ=', width: 8, height: 8 }),
  SaveFormat: { WEBP: 'webp' },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  encryptChunk: async () => ({ nonce: new Uint8Array(), ciphertext: new Uint8Array() }),
  decryptChunk: async () => new Uint8Array(),
  generateVideoThumbnail: async () => null,
  generateDngThumbnail: async () => null,
  generateAndUploadPhotoLibraryThumbnailNative: async () => null,
  handleDecryptChunk: async () => new Uint8Array(),
}));
mock.module('expo-media-library/legacy', () => ({
  getAssetInfoAsync: async () => null,
}));
mock.module('./api', () => ({
  uploadThumbnail: async () => undefined,
  downloadFile: async () => { throw new Error('not used'); },
  getApiUrl: () => 'https://api.beebeeb.io',
  getToken: async () => 'token',
  thumbnailUrl: (id: string) => `https://api.beebeeb.io/api/v1/files/${id}/thumbnail`,
}));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => ({ ok: false, status: 404 }) }));
mock.module('./encrypted-download', () => ({
  decryptEncryptedBytes: async () => new Uint8Array(),
  inferChunkCountFromEncryptedSize: () => 1,
}));
mock.module('./thumbnail-cache', () => ({
  forgetCachedThumbnailName: () => {},
  getCachedThumbnail: async () => { state.cacheReads += 1; return null; },
  cacheThumbnail: async (fileId: string) => {
    state.cacheWrites += 1;
    return `file:///doc/beebeeb-thumbnails-v3/${fileId}.medium.webp`;
  },
  enqueueThumbnailLoad: async () => null,
}));
mock.module('./shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: () => false,
  getSharedKeyResolver: () => null,
}));
mock.module('./shared-folder-tree', () => ({ isForeignSharedFile: () => false }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));

const { cacheLocalThumbnail } = await import('./thumbnail');

describe('task 2233 round 2 P2-4 — cacheLocalThumbnail does not write on iOS', () => {
  beforeEach(() => {
    state.platform.OS = 'ios';
    state.cacheWrites = 0;
    state.cacheReads = 0;
  });

  test('iOS: returns null and performs no cache write', async () => {
    const result = await cacheLocalThumbnail('ios-file', 'file:///local/photo.jpg', 'image/jpeg');
    expect(result).toBeNull();
    expect(state.cacheWrites).toBe(0);
  });

  test('Android: still caches the generated thumbnail', async () => {
    state.platform.OS = 'android';
    const result = await cacheLocalThumbnail('android-file', 'file:///local/photo.jpg', 'image/jpeg');
    expect(result).toBe('file:///doc/beebeeb-thumbnails-v3/android-file.medium.webp');
    expect(state.cacheWrites).toBe(1);
  });
});
