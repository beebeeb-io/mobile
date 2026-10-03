// @ts-nocheck
import { beforeEach, expect, mock, test } from 'bun:test';
const blurhashUris: string[] = [];
const cachedVariants: string[] = [];
const nativeSizes: number[] = [];
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('react-native-blurhash', () => ({ Blurhash: { encode: async (uri) => { blurhashUris.push(uri); return 'small-hash'; } } }));
mock.module('expo-image-manipulator', () => ({}));
mock.module('expo-media-library/legacy', () => ({}));
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', documentDirectory: 'file:///docs/',
  readAsStringAsync: async () => btoa('thumbnail'), deleteAsync: async () => {},
  EncodingType: { Base64: 'base64' },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  encryptChunk: async (_key, bytes) => ({ nonce: new Uint8Array(12), ciphertext: bytes }),
  decryptChunk: async () => new Uint8Array(),
  generateDngThumbnail: async (_uri, size) => { nativeSizes.push(size); return 'file:///small.webp'; },
  generateVideoThumbnail: async () => 'file:///small.webp',
  generateAndUploadPhotoLibraryThumbnailNative: async () => true,
}));
mock.module('./api', () => ({ uploadThumbnail: async () => {}, downloadFile: async () => {}, getApiUrl: () => '', getToken: () => '', thumbnailUrl: () => '' }));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => {} }));
mock.module('./encrypted-download', () => ({ decryptEncryptedBytes: async () => {}, inferChunkCountFromEncryptedSize: () => 1 }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));
mock.module('./thumbnail-cache', () => ({
  cacheThumbnail: async (_id, _bytes, variant) => {
    cachedVariants.push(variant); return `file:///cache/${variant}.webp`;
  }, cacheThumbnailBase64: async () => {
    throw new Error('cacheThumbnailBase64 is Android-only');
  }, enqueueThumbnailLoad: async () => {}, getCachedThumbnail: async () => null,
}));
const { generateAndUploadThumbnail } = await import('./thumbnail');
beforeEach(() => { blurhashUris.length = 0; cachedVariants.length = 0; nativeSizes.length = 0; });
test('DNG blurhash encodes the small WebP, never the full RAW source', async () => {
  expect(await generateAndUploadThumbnail('raw', 'file:///57mb.dng', 'image/x-adobe-dng', async () => new Uint8Array(32))).toBe(true);
  expect(blurhashUris).toEqual(['file:///cache/medium.webp']);
  expect(cachedVariants).toEqual(['medium']);
  expect(nativeSizes).toEqual([768]);
});
test('large DNG thumbnail stays local for immediate preview and requests 1600px', async () => {
  expect(await generateAndUploadThumbnail('raw', 'file:///57mb.dng', 'image/x-adobe-dng', async () => new Uint8Array(32), 'large')).toBe(true);
  expect(cachedVariants).toEqual(['large']);
  expect(blurhashUris).toEqual([]);
  expect(nativeSizes).toEqual([1600]);
});
