// @ts-nocheck -- render the real hook; the real thumbnail pipeline runs too.
/**
 * MB-0002 round 2 (security) — before round 1, `enqueueThumbnailLoad` threw on
 * iOS before any loader ran, so a file of your own never had its raw key
 * exported into JS. Round 1 made the queue pure JS without a platform check, so
 * the Photos prefetch and the hook fallback could call `getFileKeyBytes`
 * (32 raw key bytes into the JS heap, plus a `setFileKey` bridge call) and only
 * then fail at the iOS guard in `fetchDecryptedThumbnailUri`.
 *
 * Enforced now, on iOS only: `enqueueThumbnailLoad` refuses a job for anything
 * but a foreign shared file whose key is loaded natively, BEFORE its loader
 * runs; the prefetch skips those ids; the hook never falls back to the raw-key
 * loader. Android is unchanged.
 *
 * `./thumbnail`, `./thumbnail-cache`, `./shared-folder-keys` and
 * `./shared-folder-tree` are the REAL modules: the guards under test live in
 * them. Only native modules (Platform, file system, crypto bindings, the
 * ThumbnailService module) and the network are stubbed.
 */
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// runtime-trace reads the RN global; bun has no `__DEV__`.
(globalThis as any).__DEV__ = false;

const state = {
  platform: { OS: 'ios' as string },
  // Registered = the native ThumbnailService actor exists (own files).
  thumbnailServiceRegistered: true,
  // Native side of the shared-key store: which file keys are loaded natively.
  loadedIds: new Set<string>(),
  // What the crypto context's getFileKeyBytes would do: export + setFileKey.
  rawKeyExports: 0,
  setFileKeyCalls: 0,
  handleDecrypts: 0,
  nativeReads: 0,
  fetchCalls: 0,
  response: { ok: true, status: 200, body: new Uint8Array(12 + 8) },
};

const latency = () => new Promise((resolve) => setTimeout(resolve, 0));

const readNative = async () => {
  state.nativeReads += 1;
  return { uri: 'file:///own-native.webp', source: 'cache' };
};
const thumbnailService = {
  getThumbnail: readNative,
  setFileKey: async () => {
    state.setFileKeyCalls += 1;
  },
  addListener: () => ({ remove() {} }),
};

mock.module('react-native', () => ({ NativeModules: {}, Platform: state.platform }));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: async () => ({ exists: false }),
  readDirectoryAsync: async () => [],
  deleteAsync: async () => undefined,
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async () => undefined,
  copyAsync: async () => undefined,
  moveAsync: async () => undefined,
}));
mock.module('expo-modules-core', () => ({
  NativeModulesProxy: {},
  requireOptionalNativeModule: (name: string) =>
    name === 'ThumbnailService' && state.thumbnailServiceRegistered ? thumbnailService : null,
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
  logDiagnostic: async () => undefined,
  handleDecryptChunk: async () => {
    state.handleDecrypts += 1;
    return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  },
  decryptChunk: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]),
  encryptChunk: async () => ({ nonce: new Uint8Array(), ciphertext: new Uint8Array() }),
  generateVideoThumbnail: async () => null,
  generateDngThumbnail: async () => null,
  generateAndUploadPhotoLibraryThumbnailNative: async () => null,
}));
mock.module('expo-media-library/legacy', () => ({ getAssetInfoAsync: async () => null }));
// Network only.
mock.module('./api', () => ({
  uploadThumbnail: async () => undefined,
  downloadFile: async () => {
    throw new Error('not used');
  },
  getApiUrl: () => 'https://api.beebeeb.io',
  getToken: async () => 'test-token',
  thumbnailUrl: (id: string) => `https://api.beebeeb.io/api/v1/files/${id}/thumbnail`,
}));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async () => {
    state.fetchCalls += 1;
    const body = state.response.body;
    return {
      ok: state.response.ok,
      status: state.response.status,
      headers: { get: () => null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  },
}));
// The crypto context's key provider (a native bridge, not the guard).
const crypto = {
  isUnlocked: true,
  getMasterKeyHandleId: () => 7,
  getFileKeyBytes: async (fileId: string) => {
    state.rawKeyExports += 1;
    if (state.thumbnailServiceRegistered) await thumbnailService.setFileKey(fileId, new Uint8Array(32));
    return new Uint8Array(32);
  },
  decryptChunk: async () => new Uint8Array([1, 2, 3]),
};
mock.module('./crypto-context', () => ({ useCrypto: () => crypto }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));

const { handleDecryptChunk } = await import('../../modules/beebeeb-crypto');
const { configureSharedKeys } = await import('./shared-folder-keys');
const { ingestTree, clearTree } = await import('./shared-folder-tree');
const { enqueueThumbnailLoad, clearThumbnailCache } = await import('./thumbnail-cache');
const { prefetchDecryptedThumbnails, fetchDecryptedThumbnailUri } = await import('./thumbnail');
const { useThumbnail } = await import('./use-thumbnail');

// Real shared-key module, native surface stubbed: "which keys does native hold".
configureSharedKeys(
  {
    isSharedKeysNativeReady: () => true,
    sharedFileKeyIsLoaded: (id: string) => state.loadedIds.has(id),
  } as any,
  {} as any,
  () => 7,
);

/** Exactly what the Photos prefetch passes: crypto-context's key provider. */
async function keyLoader(fileId: string): Promise<Uint8Array> {
  state.rawKeyExports += 1;
  if (state.thumbnailServiceRegistered) await thumbnailService.setFileKey(fileId, new Uint8Array(32));
  return new Uint8Array(32);
}

let hook;
function Harness({ id }: { id: string }) {
  hook = useThumbnail(id);
  return null;
}

beforeEach(async () => {
  await clearThumbnailCache();
  state.platform.OS = 'ios';
  state.thumbnailServiceRegistered = true;
  // The hook captures the module once at import; an unregistered service is
  // modelled by the same object without `getThumbnail` (it checks per render).
  (thumbnailService as any).getThumbnail = readNative;
  state.loadedIds = new Set();
  state.rawKeyExports = 0;
  state.setFileKeyCalls = 0;
  state.handleDecrypts = 0;
  state.nativeReads = 0;
  state.fetchCalls = 0;
  state.response = { ok: true, status: 200, body: new Uint8Array(12 + 8) };
  clearTree();
  hook = undefined;
});

afterEach(() => clearTree());

describe('MB-0002 round 2 — no raw file key for an own file on iOS', () => {
  test('ios: the Photos prefetch path exports no raw key and makes no setFileKey call', async () => {
    const stats = await prefetchDecryptedThumbnails(['mine'], keyLoader, {});
    expect(state.rawKeyExports).toBe(0);
    expect(state.setFileKeyCalls).toBe(0);
    expect(state.fetchCalls).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  test('ios: the hook with the native service UNREGISTERED exports no raw key for an own file', async () => {
    state.thumbnailServiceRegistered = false;
    delete (thumbnailService as any).getThumbnail;
    let tree;
    await act(async () => {
      tree = create(<Harness id="mine" />);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(state.rawKeyExports).toBe(0);
    expect(state.setFileKeyCalls).toBe(0);
    // Own files are unavailable on iOS, as before round 1.
    expect(hook.failed).toBe(true);
    expect(hook.uri).toBeNull();
    expect(state.fetchCalls).toBe(0);
    await act(async () => {
      tree.unmount();
    });
  });

  test('ios: an own file enqueued directly never runs its loader', async () => {
    let loads = 0;
    const result = await enqueueThumbnailLoad('mine', async () => {
      loads += 1;
      await keyLoader('mine');
      return 'file:///never.webp';
    });
    expect(loads).toBe(0);
    expect(state.rawKeyExports).toBe(0);
    expect(state.setFileKeyCalls).toBe(0);
    expect(result).toBeNull();
  });

  test('ios: a foreign shared file whose key is loaded still loads via the native handle callback', async () => {
    state.loadedIds.add('shared');
    ingestTree([{ id: 'shared', uploaded_by: 'someone-else', owner_wrapped_file_key: 'wrapped' }]);
    const result = await enqueueThumbnailLoad(
      'shared',
      (fId, signal, epoch) =>
        fetchDecryptedThumbnailUri(fId, (n, c) => handleDecryptChunk(7, fId, n, c), signal, epoch),
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('.medium.webp');
    expect(state.handleDecrypts).toBe(1);
    expect(state.rawKeyExports).toBe(0);
    expect(state.setFileKeyCalls).toBe(0);
  });

  test('android: an own file still prefetches with the raw key exactly as before', async () => {
    state.platform.OS = 'android';
    state.thumbnailServiceRegistered = false;
    const stats = await prefetchDecryptedThumbnails(['mine'], keyLoader, {});
    expect(state.rawKeyExports).toBe(1);
    expect(state.fetchCalls).toBe(1);
    expect(stats.loaded).toBe(1);
  });
});
