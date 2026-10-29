// @ts-nocheck
/**
 * Review thread (#233, P2): a shared-file thumbnail arrives through a decrypt CALLBACK, which is allowed on iOS.
 * The write that followed went through the base64 writer, which throws on every platform but Android, so a
 * cache-miss download failed on iOS even after a successful decrypt. The callback path must use the
 * platform-neutral byte writer (the base64 writer no longer exists — task 2233 round 2).
 */
import { beforeEach, expect, mock, test } from 'bun:test';
const written: Array<{ id: string; bytes: number[]; variant?: string }> = [];
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('react-native-blurhash', () => ({ Blurhash: { encode: async () => 'hash' } }));
mock.module('expo-image-manipulator', () => ({}));
mock.module('expo-media-library/legacy', () => ({}));
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', documentDirectory: 'file:///docs/', deleteAsync: async () => {}, EncodingType: { Base64: 'base64' },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  encryptChunk: async () => ({}), decryptChunk: async () => new Uint8Array(),
  generateDngThumbnail: async () => '', generateVideoThumbnail: async () => '', generateAndUploadPhotoLibraryThumbnailNative: async () => true,
}));
mock.module('./api', () => ({ uploadThumbnail: async () => {}, downloadFile: async () => {}, getApiUrl: () => '', getToken: async () => 'token', thumbnailUrl: (id: string) => `https://api.test/thumb/${id}` }));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => new Response(new Uint8Array(12 + 20 + 5).fill(7)) }));
mock.module('./encrypted-download', () => ({ decryptEncryptedBytes: async () => {}, inferChunkCountFromEncryptedSize: () => 1 }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));
mock.module('./thumbnail-cache', () => ({
  forgetCachedThumbnailName: () => {},
  getCachedThumbnail: async () => null, enqueueThumbnailLoad: async () => {},
  cacheThumbnail: async (id: string, bytes: Uint8Array, variant?: string) => { written.push({ id, bytes: [...bytes], variant }); return `file:///docs/thumbs/${id}.webp`; },
}));
mock.module('./shared-folder-keys', () => ({ sharedFileKeyIsLoaded: () => true, getSharedKeyResolver: () => null }));
const { fetchDecryptedThumbnailUri } = await import('./thumbnail');
beforeEach(() => { written.length = 0; });
test('a_shared_thumbnail_downloaded_on_ios_is_written_with_the_platform_neutral_writer', async () => {
  const uri = await fetchDecryptedThumbnailUri('shared-file-1', async (_nonce, _ciphertext) => new Uint8Array([1, 2, 3]));
  expect(uri).toBe('file:///docs/thumbs/shared-file-1.webp');
  expect(written).toEqual([{ id: 'shared-file-1', bytes: [1, 2, 3], variant: undefined }]);
});
test('a_raw_key_on_ios_still_refuses_and_never_reaches_a_writer', async () => {
  await expect(fetchDecryptedThumbnailUri('own-file', new Uint8Array(32))).rejects.toThrow('iOS path replaced');
  expect(written).toEqual([]);
});
