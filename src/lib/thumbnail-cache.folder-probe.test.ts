// @ts-nocheck
/**
 * Task 2233 round 3 (N7) — "the folder is missing" is decided by looking at
 * the folder, not by parsing an error message.
 *
 * iOS spells the message with a curly apostrophe ("doesn’t exist"), so the
 * round-2 regex missed it and folder recovery never ran. Both platform
 * spellings must recover: on a write failure, stat THUMB_DIR; only
 * `exists === false` means recreate-once-and-retry-once.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  dirExists: true,
  ensureDirCalls: 0,
  writes: 0,
  failNextWrite: false,
  failWriteKeepingFolder: false,
  writeError: '',
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
  getInfoAsync: async () => ({ exists: state.dirExists }),
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
      if (state.failWriteKeepingFolder) {
        state.failWriteKeepingFolder = false;
        throw new Error(state.writeError);
      }
      if (state.failNextWrite) {
        state.failNextWrite = false;
        state.dirExists = false;
        throw new Error(state.writeError);
      }
      if (!state.dirExists) {
        throw new Error(state.writeError);
      }
    },
  }),
  resetModernThumbnailFsForTests: () => {},
}));

const { cacheThumbnail, clearThumbnailCache, getCachedThumbnail } = await import('./thumbnail-cache');

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

describe('task 2233 round 3 N7 — missing folder is detected by stat, not message', () => {
  beforeEach(async () => {
    await clearThumbnailCache();
    state.dirExists = true;
    state.ensureDirCalls = 0;
    state.writes = 0;
    state.failNextWrite = false;
    state.failWriteKeepingFolder = false;
    state.writeError = '';
  });

  test('an Android-style message recovers (control)', async () => {
    state.writeError = "ENOENT: no such file or directory, open 'file:///doc/beebeeb-thumbnails-v3/a.medium.webp'";
    state.failNextWrite = true;

    const path = await cacheThumbnail('android-style', BYTES);

    expect(path).toBe('file:///doc/beebeeb-thumbnails-v3/android-style.medium.webp');
    expect(state.writes).toBe(2);
    expect(state.ensureDirCalls).toBe(2);
    expect(await getCachedThumbnail('android-style')).toBe(path);
  });

  test('an iOS-style message with a curly apostrophe also recovers', async () => {
    state.writeError = 'The folder “beebeeb-thumbnails-v3” doesn’t exist.';
    state.failNextWrite = true;

    const path = await cacheThumbnail('ios-style', BYTES);

    expect(path).toBe('file:///doc/beebeeb-thumbnails-v3/ios-style.medium.webp');
    expect(state.writes).toBe(2);
    expect(state.ensureDirCalls).toBe(2);
    expect(await getCachedThumbnail('ios-style')).toBe(path);
  });

  test('a write failure while the folder still exists is not treated as missing', async () => {
    state.writeError = 'No space left on device';
    state.failWriteKeepingFolder = true;

    await expect(cacheThumbnail('disk-full', BYTES)).rejects.toThrow('No space left on device');
    expect(state.ensureDirCalls).toBe(1);
    expect(state.writes).toBe(1);
  });
});
