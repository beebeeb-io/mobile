// @ts-nocheck
/**
 * Task 1667 round 11 (review of mobile#182 at de23774e, finding 4).
 *
 * The bug: the `purgePlaintextStorage` wrapper in
 * modules/beebeeb-crypto/src/BeebeebCrypto.ts turned ANY native rejection into
 * `{removed: 0, failed: 0}`. account-cleanup.ts counts a throwing native purge
 * as `failed: 1` (round 7, M4), but that catch never ran in production: the
 * wrapper had already swallowed the rejection, so a sign-out whose native
 * registry sweep and manifest reset never ran reported a clean purge. The M4
 * test passed only because it mocked `../../modules/beebeeb-crypto` wholesale.
 *
 * This file does NOT mock the beebeeb-crypto module. It mocks only what sits
 * under it (`expo`'s `requireNativeModule`, `expo-modules-core`), so the REAL
 * wrapper runs between account-cleanup.ts and the fake native module.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

(globalThis as Record<string, unknown>).__DEV__ = false;
(globalThis as Record<string, unknown>).expo = {
  EventEmitter: class {
    addListener = () => ({ remove: () => {} });
    removeAllListeners = () => {};
  },
  modules: {},
};

/** The native BeebeebCrypto module the real wrapper calls. */
const native: Record<string, unknown> = {};
const nativeCalls: string[] = [];

function resetNative() {
  for (const key of Object.keys(native)) delete native[key];
  nativeCalls.length = 0;
  native.finishBackupManifestPurge = async () => {
    nativeCalls.push('finish');
    return { ok: 1, unlinked: 0 };
  };
  native.logDiagnostic = () => {};
}

mock.module('expo', () => ({
  requireNativeModule: () => native,
}));
mock.module('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeViewManager: () => () => null,
}));

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
  readAsStringAsync: async () => '',
  writeAsStringAsync: async () => {},
  createDownloadResumable: () => ({ downloadAsync: async () => ({ uri: 'file:///offline/x' }) }),
}));

const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));

mock.module('react-native', () => {
  const noopEmitter = { addListener: () => ({ remove: () => {} }), emit: () => {}, removeAllListeners: () => {} };
  return {
    Platform: { OS: 'ios', select: (o) => o.ios ?? o.default ?? o.android },
    TurboModuleRegistry: { getEnforcing: () => ({}), get: () => null },
    AppRegistry: { registerRunnable: () => {}, getRunnable: () => null, registerComponent: () => {}, getComponent: () => null },
    NativeModules: {},
    DeviceEventEmitter: noopEmitter,
    NativeEventEmitter: class { addListener = () => ({ remove: () => {} }); removeAllListeners = () => {}; },
    InteractionManager: { runAfterInteractions: (cb) => { cb(); return { cancel: () => {} }; } },
    PixelRatio: { get: () => 2 },
  };
});

mock.module('./api', () => ({
  getDownloadUrl: (fileId: string) => `https://api.test/download/${fileId}`,
  getToken: async () => 'test-token',
  fetchPhotoBackupIdentifierMap: async () => ({}),
  photoBackupClearAssociation: async () => {},
  clearCachedFileIndex: async () => {},
  sweepAllUploadResumeStates: async () => {},
}));
mock.module('./name-cache', () => ({ clearNameCache: async () => {} }));
mock.module('./thumbnail-cache', () => ({ clearThumbnailCache: async () => {} }));
mock.module('./native-decrypt', () => ({ clearPreviewCache: async () => {} }));
mock.module('./photo-cache', () => ({ clearPhotoCache: async () => {} }));
mock.module('./caches-plaintext-registry', () => ({
  purgeCachesPlaintext: async () => ({ removed: [], failed: [] }),
}));
mock.module('./local-identifier-map', () => ({ clearLocalIdentifierMap: async () => {} }));

resetNative();
const wrapper = await import('../../modules/beebeeb-crypto/src/BeebeebCrypto');
const cleanup = await import('./account-cleanup');

beforeEach(() => {
  resetNative();
  secure.clear();
});

describe('round 11 finding 4: a rejected native purge is a failed purge, through the REAL wrapper', () => {
  test('the wrapper propagates the native rejection (it no longer answers {removed: 0, failed: 0})', async () => {
    native.purgePlaintextStorage = async () => {
      nativeCalls.push('purge');
      throw new Error('bridge: argument conversion failed');
    };
    let thrown: unknown = null;
    let value: unknown = null;
    try {
      value = await wrapper.purgePlaintextStorage({ mode: 'sign-out' });
    } catch (error) {
      thrown = error;
    }
    expect(nativeCalls).toEqual(['purge']);
    expect(value).toBeNull();
    expect(String(thrown)).toContain('argument conversion failed');
  });

  test('purgeAllPlaintextCaches counts it as failed (the round-7 failed path now runs)', async () => {
    native.purgePlaintextStorage = async () => {
      nativeCalls.push('purge');
      throw new Error('bridge: argument conversion failed');
    };
    const result = await cleanup.purgeAllPlaintextCaches();
    expect(nativeCalls[0]).toBe('purge');
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  test('a native purge that resolves is passed through unchanged (regression)', async () => {
    native.purgePlaintextStorage = async (mode: string, deleted: string[]) => {
      nativeCalls.push(`purge:${mode}:${deleted.join(',')}`);
      return { removed: 3, failed: 0 };
    };
    expect(await wrapper.purgePlaintextStorage({ mode: 'account-deleted', deletedAccountIds: ['u1'] }))
      .toEqual({ removed: 3, failed: 0 });
    const result = await cleanup.purgeAllPlaintextCaches();
    expect(result).toEqual({ removed: 3, failed: 0 });
    expect(nativeCalls).toEqual(['purge:account-deleted:u1', 'purge:sign-out:']);
  });

  test('the reset-failed answer still runs the JS close and finishBackupManifestPurge', async () => {
    native.purgePlaintextStorage = async () => {
      nativeCalls.push('purge');
      return { removed: 0, failed: 0, backupManifestResetFailed: 1 };
    };
    await cleanup.purgeAllPlaintextCaches();
    expect(nativeCalls).toEqual(['purge', 'finish']);
  });

  test('a native module without the function (Android) still answers {removed: 0, failed: 0}', async () => {
    expect(typeof native.purgePlaintextStorage).toBe('undefined');
    expect(await wrapper.purgePlaintextStorage()).toEqual({ removed: 0, failed: 0 });
  });
});
