// @ts-nocheck
/**
 * Task 2233 item 1 (adversarial cases 4 and 5) — account boundary.
 *
 *  - Case 4: an account-epoch advance aborts every queued thumbnail job and
 *    clears the in-memory cache index (nothing from the old account is served
 *    to the new one).
 *  - Case 5: a write that reaches the cache after the sign-out purge closed
 *    the plaintext gate is refused and never lands in the index.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fs = { names: [] as string[], writes: 0, dirs: 0 };

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
  getInfoAsync: async (uri: string) => ({ exists: fs.names.includes(uri.slice(uri.lastIndexOf('/') + 1)) }),
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => { fs.writes += 1; },
  copyAsync: async () => undefined,
  moveAsync: async () => undefined,
}));
mock.module('./thumbnail-fs-modern', () => ({
  getModernThumbnailFs: () => ({
    ensureDir: async () => { fs.dirs += 1; },
    writeBytes: async () => { fs.writes += 1; },
  }),
  resetModernThumbnailFsForTests: () => {},
}));

const { advanceAccountEpoch } = await import('./account-epoch');
const { plaintextGate } = await import('./plaintext-gate');
const {
  cacheThumbnail,
  clearThumbnailQueue,
  enqueueThumbnailLoad,
  getCachedThumbnail,
  thumbnailQueueStats,
} = await import('./thumbnail-cache');

describe('task 2233 cases 4/5 — account boundary', () => {
  beforeEach(() => {
    clearThumbnailQueue();
    plaintextGate.open();
    fs.names = [];
    fs.writes = 0;
    fs.dirs = 0;
  });

  test('case 4a: epoch advance resolves queued jobs null; running jobs stop being served', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    for (let i = 0; i < 6; i++) {
      void enqueueThumbnailLoad(`block-${i}`, async () => { started.push(`block-${i}`); await gate; return 'uri'; });
    }
    const queued = enqueueThumbnailLoad('queued', async () => { started.push('queued'); return 'uri'; });
    expect(thumbnailQueueStats().waiting).toBe(1);

    advanceAccountEpoch();
    expect(await queued).toBeNull();
    expect(thumbnailQueueStats().waiting).toBe(0);

    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).not.toContain('queued');
  });

  test('case 4b: epoch advance clears the cache index (old names are not served)', async () => {
    fs.names = ['old.medium.webp'];
    expect(await getCachedThumbnail('old')).toBe('file:///doc/beebeeb-thumbnails-v3/old.medium.webp');
    // (the listing is now hydrated with the old account's name)
    advanceAccountEpoch();
    fs.names = [];
    expect(await getCachedThumbnail('old')).toBeNull();
  });

  test('case 5: a write after the purge closed the gate is refused and not indexed', async () => {
    let releasePurge: () => void = () => {};
    const sweepGate = new Promise<void>((resolve) => { releasePurge = resolve; });
    const purging = plaintextGate.purge(async () => { await sweepGate; });

    const refused = cacheThumbnail('late', new Uint8Array([1, 2, 3]));
    await expect(refused).rejects.toBeDefined();
    expect(fs.writes).toBe(0);

    releasePurge();
    await purging;
    // Nothing landed in the index: the next lookup misses.
    expect(await getCachedThumbnail('late')).toBeNull();
  });
});
