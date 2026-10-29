// @ts-nocheck
/**
 * Task 2233 item 1 (A6) — cache lookup costs no bridge call on a hit.
 *
 * The cache directory listing is hydrated into a Set once per session. A hit
 * is answered from memory or that Set (0 `getInfoAsync`); a miss costs at most
 * one stat. Clearing the cache (sign-out) drops the Set.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fs = {
  readDirectoryCalls: 0,
  getInfoCalls: 0,
  names: [] as string[],
  deleted: [] as string[],
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
  readDirectoryAsync: async () => {
    fs.readDirectoryCalls += 1;
    return fs.names;
  },
  getInfoAsync: async (uri: string) => {
    fs.getInfoCalls += 1;
    // The stat fallback must agree with the directory listing.
    const name = uri.slice(uri.lastIndexOf('/') + 1);
    return { exists: fs.names.includes(name) };
  },
  deleteAsync: async (uri: string) => { fs.deleted.push(uri); },
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => undefined,
  moveAsync: async () => undefined,
  copyAsync: async () => undefined,
}));

const { clearThumbnailCache, getCachedThumbnail } = await import('./thumbnail-cache');

describe('task 2233 A6 — in-memory cache index', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    fs.readDirectoryCalls = 0;
    fs.getInfoCalls = 0;
    fs.deleted = [];
    fs.names = ['a.medium.webp', 'b.small.webp'];
  });

  test('a hit after hydration performs 0 getInfoAsync; a miss performs 1', async () => {
    const a = await getCachedThumbnail('a');
    expect(a).toBe('file:///doc/beebeeb-thumbnails-v3/a.medium.webp');
    expect(fs.readDirectoryCalls).toBe(1);
    expect(fs.getInfoCalls).toBe(0);

    const hitAgain = await getCachedThumbnail('a');
    expect(hitAgain).toBe(a);
    expect(fs.getInfoCalls).toBe(0);

    const missing = await getCachedThumbnail('c');
    expect(missing).toBeNull();
    expect(fs.getInfoCalls).toBe(1);

    // The listing is hydrated once per session, not per lookup.
    expect(fs.readDirectoryCalls).toBe(1);
  });

  test('clearThumbnailCache drops the index (a later lookup re-hydrates)', async () => {
    await getCachedThumbnail('a');
    expect(fs.readDirectoryCalls).toBe(1);
    await clearThumbnailCache();
    await getCachedThumbnail('a');
    expect(fs.readDirectoryCalls).toBe(2);
  });

  test('a file written after hydration is found by the one-stat fallback', async () => {
    await getCachedThumbnail('a');
    fs.names.push('late.medium.webp');
    const late = await getCachedThumbnail('late');
    expect(late).toBe('file:///doc/beebeeb-thumbnails-v3/late.medium.webp');
    expect(fs.getInfoCalls).toBe(1);
  });
});
