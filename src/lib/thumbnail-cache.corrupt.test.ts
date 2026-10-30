// @ts-nocheck
/**
 * Task 2233 item 1 (adversarial case 8) — a corrupt (0-byte) cached thumbnail
 * is invalidated and fetched once more, not served forever.
 *
 * `<Image onError>` calls `invalidateCachedThumbnail(fileId)`; that must drop
 * both the in-memory entries and the index/disk entry so the next lookup
 * misses exactly once and the normal loader fetches a fresh copy.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fs = {
  names: [] as string[],
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
}));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  readDirectoryAsync: async () => fs.names,
  getInfoAsync: async (uri: string) => {
    fs.getInfoCalls += 1;
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    return { exists: fs.names.includes(name), size: 0 };
  },
  deleteAsync: async (uri: string) => {
    fs.deleted.push(uri);
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    fs.names = fs.names.filter((n) => n !== name);
  },
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => undefined,
  moveAsync: async () => undefined,
  copyAsync: async () => undefined,
}));

const { clearThumbnailCache, getCachedThumbnail, invalidateCachedThumbnail } = await import('./thumbnail-cache');

describe('task 2233 case 8 — corrupt cache entry', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    fs.names = ['broken.medium.webp'];
    fs.deleted = [];
    fs.getInfoCalls = 0;
  });

  test('invalidate deletes the entry and the next lookup misses (one refetch)', async () => {
    expect(await getCachedThumbnail('broken')).toBe('file:///doc/beebeeb-thumbnails-v3/broken.medium.webp');

    await invalidateCachedThumbnail('broken');
    expect(fs.deleted).toContain('file:///doc/beebeeb-thumbnails-v3/broken.medium.webp');

    // Index was updated with the delete: the next lookup misses on the disk
    // index and pays one stat, so the caller fetches exactly once.
    const after = await getCachedThumbnail('broken');
    expect(after).toBeNull();
    expect(fs.getInfoCalls).toBe(1);
  });
});
