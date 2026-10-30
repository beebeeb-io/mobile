// @ts-nocheck
/**
 * Task 2233 round 2 (P2-6c) — `pruneThumbnailCache` must remove deleted names
 * from the hydrated cache index.
 *
 * The index answers a hit from a name Set with no stat. Pruning deletes files
 * behind `thumbnail-cache.ts`'s back; if the name stays in the Set, the next
 * read serves a path that no longer exists until the app restarts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fs = {
  names: [] as string[],
  mtimes: new Map<string, number>(),
  deleted: [] as string[],
  getInfoCalls: 0,
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
  decryptChunk: async () => new Uint8Array(),
  generateVideoThumbnail: async () => null,
  generateDngThumbnail: async () => null,
  generateAndUploadPhotoLibraryThumbnailNative: async () => null,
  handleDecryptChunk: async () => new Uint8Array(),
}));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  readDirectoryAsync: async (dir: string) => (dir === 'file:///cache/' ? [] : [...fs.names]),
  getInfoAsync: async (uri: string) => {
    fs.getInfoCalls += 1;
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    return { exists: fs.names.includes(name), modificationTime: fs.mtimes.get(name) ?? 0 };
  },
  deleteAsync: async (uri: string) => {
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    fs.deleted.push(name);
    fs.names = fs.names.filter((n) => n !== name);
  },
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
  getModernThumbnailFs: () => null,
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
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => ({ ok: false, status: 404 }) }));
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

const { clearThumbnailCache, getCachedThumbnail } = await import('./thumbnail-cache');
const { pruneThumbnailCache } = await import('./thumbnail');

describe('task 2233 round 2 P2-6c — prune drops names from the cache index', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    fs.names = ['a.medium.webp', 'b.medium.webp'];
    fs.mtimes = new Map([['a.medium.webp', 100], ['b.medium.webp', 200]]);
    fs.deleted = [];
    fs.getInfoCalls = 0;
  });

  test('a pruned file is not served from the stale index afterwards', async () => {
    // Hydrate the index (without touching 'a', so no in-memory path shadows it).
    await getCachedThumbnail('b');

    await pruneThumbnailCache(1);
    expect(fs.deleted).toContain('a.medium.webp');

    expect(await getCachedThumbnail('a')).toBeNull();
  });
});
