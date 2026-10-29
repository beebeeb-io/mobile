// @ts-nocheck
/**
 * Task 2233 round 2 (P2-5) — a stale "folder exists" memo must not break
 * every later write.
 *
 * `ensureThumbDir` memoises one directory creation per session. The folder can
 * vanish under that memo: the sign-out purge can race a write, and the iOS
 * native service purges the directory on its own. Required: on a write failure
 * caused by a missing folder, drop the memo, recreate once and retry the write
 * once; an account-epoch advance also drops the memo.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  dirExists: true,
  ensureDirCalls: 0,
  writes: 0,
  failNextWrite: false,
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
  readDirectoryAsync: async () => [],
  getInfoAsync: async () => ({ exists: false }),
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => { state.writes += 1; },
  copyAsync: async () => undefined,
  moveAsync: async () => undefined,
}));
mock.module('./thumbnail-fs-modern', () => ({
  getModernThumbnailFs: () => ({
    ensureDir: async () => {
      state.ensureDirCalls += 1;
      state.dirExists = true;
    },
    writeBytes: async () => {
      state.writes += 1;
      if (state.failNextWrite) {
        state.failNextWrite = false;
        state.dirExists = false;
        throw new Error('ENOENT: no such file or directory, open \'file:///doc/beebeeb-thumbnails-v3/race.medium.webp\'');
      }
      if (!state.dirExists) {
        throw new Error('ENOENT: no such file or directory, open \'file:///doc/beebeeb-thumbnails-v3/race.medium.webp\'');
      }
    },
  }),
  resetModernThumbnailFsForTests: () => {},
}));

const { advanceAccountEpoch } = await import('./account-epoch');
const { cacheThumbnail, clearThumbnailCache, getCachedThumbnail } = await import('./thumbnail-cache');

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

describe('task 2233 round 2 P2-5 — directory memo recovery', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    state.dirExists = true;
    state.ensureDirCalls = 0;
    state.writes = 0;
    state.failNextWrite = false;
  });

  test('a write that loses the folder recreates it once and retries once', async () => {
    state.failNextWrite = true;

    const path = await cacheThumbnail('race', BYTES);

    expect(path).toBe('file:///doc/beebeeb-thumbnails-v3/race.medium.webp');
    expect(state.writes).toBe(2); // one failed attempt + one retry
    expect(state.ensureDirCalls).toBe(2); // memo dropped, directory recreated
    expect(await getCachedThumbnail('race')).toBe(path);
  });

  test('an account-epoch advance drops the directory memo', async () => {
    await cacheThumbnail('before', BYTES);
    expect(state.ensureDirCalls).toBe(1);

    advanceAccountEpoch();

    await cacheThumbnail('after', BYTES);
    expect(state.ensureDirCalls).toBe(2);
  });
});
