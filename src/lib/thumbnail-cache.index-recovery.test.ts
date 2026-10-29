// @ts-nocheck
/**
 * Task 2233 round 2 (P2-6a/b) — the cache index must survive a reset and a
 * missing folder.
 *
 *  (a) A directory listing started before a reset (account switch / sign-out)
 *      must be discarded, not installed afterwards.
 *  (b) "The folder does not exist yet" means an EMPTY, enabled index — not
 *      "the index is off for this session" (which costs a stat per lookup and
 *      serves stale names).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fs = {
  disk: new Set<string>(),
  readDirectoryCalls: 0,
  getInfoCalls: 0,
  manual: null as null | ((resolve: (names: string[]) => void, reject: (err: unknown) => void) => void),
  readError: null as Error | null,
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
    if (fs.manual) return new Promise<string[]>((resolve, reject) => fs.manual!(resolve, reject));
    if (fs.readError) throw fs.readError;
    return [...fs.disk];
  },
  getInfoAsync: async (uri: string) => {
    fs.getInfoCalls += 1;
    return { exists: fs.disk.has(uri.slice(uri.lastIndexOf('/') + 1)) };
  },
  deleteAsync: async (uri: string) => { fs.disk.delete(uri.slice(uri.lastIndexOf('/') + 1)); },
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async (uri: string) => { fs.disk.add(uri.slice(uri.lastIndexOf('/') + 1)); },
  copyAsync: async (opts: { to: string }) => { fs.disk.add(opts.to.slice(opts.to.lastIndexOf('/') + 1)); },
  moveAsync: async () => undefined,
}));

const { advanceAccountEpoch } = await import('./account-epoch');
const { cacheThumbnail, clearThumbnailCache, getCachedThumbnail } = await import('./thumbnail-cache');

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('task 2233 round 2 P2-6 — cache index recovery', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    fs.disk = new Set();
    fs.readDirectoryCalls = 0;
    fs.getInfoCalls = 0;
    fs.manual = null;
    fs.readError = null;
  });

  test('(a) a listing started before a reset is discarded, not installed', async () => {
    fs.disk = new Set(['old.medium.webp']);
    let resolveListing: (names: string[]) => void = () => {};
    fs.manual = (resolve) => { resolveListing = resolve; };

    const first = getCachedThumbnail('old');
    await tick();

    // Account switch while the listing is in flight.
    advanceAccountEpoch();
    fs.manual = null;
    fs.disk = new Set();
    resolveListing(['old.medium.webp']);

    expect(await first).toBeNull();
    // The stale listing must not have been installed: the new account does not
    // see the old account's name.
    expect(await getCachedThumbnail('old')).toBeNull();
  });

  test('(b) a missing folder is an EMPTY, ENABLED index', async () => {
    fs.readError = new Error('ENOENT: no such file or directory, scandir \'file:///doc/beebeeb-thumbnails-v3/\'');

    expect(await getCachedThumbnail('none')).toBeNull();
    expect(fs.readDirectoryCalls).toBe(1); // one failed hydration, not per lookup
    // Enabled (empty) index: a miss is ONE verification stat. With the index
    // switched off a miss also probes every legacy name with its own stat.
    expect(fs.getInfoCalls).toBe(1);

    // The folder is recreated and a thumbnail is written by this module.
    fs.readError = null;
    const path = await cacheThumbnail('fresh', BYTES);
    expect(fs.disk.has('fresh.medium.webp')).toBe(true);

    const statsBefore = fs.getInfoCalls;
    expect(await getCachedThumbnail('fresh')).toBe(path);
    // Enabled index: a name this module just added is a hit with no stat.
    expect(fs.getInfoCalls).toBe(statsBefore);
    expect(fs.readDirectoryCalls).toBe(1);
  });
});
