// @ts-nocheck -- render the real hook; the real JS thumbnail queue runs too.
/**
 * MB-0002 — on iOS a file shared with you used to pick the JS queue (its key is
 * loaded, or the resolver loads it) and `enqueueThumbnailLoad` threw
 * synchronously: "enqueueThumbnailLoad is Android-only". With the key already
 * loaded that throw escaped the effect; via the resolver the tile just showed
 * as failed. Shared files must load through the queue on iOS; own files keep
 * the native ThumbnailService path.
 *
 * The real `thumbnail-cache` is imported on purpose: its platform guard is the
 * bug under test, so mocking it would hide the throw.
 */
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const platform = { OS: 'ios' };
mock.module('react-native', () => ({ NativeModules: {}, Platform: platform }));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiRemove: async () => {}, getAllKeys: async () => [] },
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
  moveAsync: async () => undefined,
  copyAsync: async () => undefined,
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
}));

const counts = { nativeReads: 0, handleDecrypts: 0, rawKeyExports: 0, queueLoads: 0 };
mock.module('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({
    getThumbnail: async () => { counts.nativeReads++; return { uri: 'file:///own-native.webp', source: 'cache' }; },
  }),
}));
const crypto = {
  isUnlocked: true,
  getMasterKeyHandleId: () => 7,
  getFileKeyBytes: async () => { counts.rawKeyExports++; return new Uint8Array(32); },
  decryptChunk: async () => { counts.handleDecrypts++; return new Uint8Array([1, 2, 3]); },
};
mock.module('./crypto-context', () => ({ useCrypto: () => crypto }));

const loadedIds = new Set(['shared']);
let resolver = null;
mock.module('./shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: (id) => loadedIds.has(id),
  getSharedKeyResolver: () => resolver,
}));
mock.module('./thumbnail-events', () => ({ onThumbnailReady: () => ({ remove() {} }) }));
mock.module('./thumbnail', () => ({
  cacheLocalThumbnail: async () => null,
  fetchDecryptedThumbnailUri: async (_id, decrypt) => {
    counts.queueLoads++;
    await decrypt(new Uint8Array(12), new Uint8Array(48));
    return 'file:///shared.webp';
  },
}));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace() {} }));

const { useThumbnail } = await import('./use-thumbnail');
const { ingestTree, clearTree } = await import('./shared-folder-tree');

let state;
function Harness({ id }) { state = useThumbnail(id); return null; }
function reset() {
  counts.nativeReads = 0; counts.handleDecrypts = 0; counts.rawKeyExports = 0; counts.queueLoads = 0;
  state = undefined;
  platform.OS = 'ios';
}
afterEach(() => { loadedIds.clear(); loadedIds.add('shared'); resolver = null; clearTree(); });

test('ios: a shared file whose key is already loaded loads through the JS queue, never failed', async () => {
  reset();
  let tree;
  await act(async () => { tree = create(<Harness id="shared" />); });
  expect(state.failed).toBe(false);
  expect(state.uri).toBe('file:///shared.webp');
  expect(counts.queueLoads).toBe(1);
  expect(counts.handleDecrypts).toBe(1);
  expect(counts.nativeReads).toBe(0);
  expect(counts.rawKeyExports).toBe(0);
  await act(async () => { tree.unmount(); });
});

test('ios: a shared file whose key the resolver loads also goes through the queue, never failed', async () => {
  reset();
  ingestTree([{ id: 'later', acted_via_share_id: 'link' }]);
  const asked = [];
  resolver = {
    ensureLoaded: async (ids) => { asked.push(ids); loadedIds.add('later'); return new Map([['later', 'loaded']]); },
  };
  let tree;
  await act(async () => { tree = create(<Harness id="later" />); });
  expect(asked).toEqual([['later']]);
  expect(state.failed).toBe(false);
  expect(state.uri).toBe('file:///shared.webp');
  expect(counts.queueLoads).toBe(1);
  expect(counts.handleDecrypts).toBe(1);
  expect(counts.nativeReads).toBe(0);
  await act(async () => { tree.unmount(); });
});

test('ios: an own (non-shared) file still uses the native service and never the queue', async () => {
  reset();
  let tree;
  await act(async () => { tree = create(<Harness id="mine" />); });
  expect(state.uri).toBe('file:///own-native.webp');
  expect(counts.nativeReads).toBe(1);
  expect(counts.queueLoads).toBe(0);
  expect(counts.handleDecrypts).toBe(0);
  await act(async () => { tree.unmount(); });
});

test('android: a shared file keeps using the queue exactly as before', async () => {
  reset();
  platform.OS = 'android';
  let tree;
  await act(async () => { tree = create(<Harness id="shared" />); });
  expect(state.failed).toBe(false);
  expect(state.uri).toBe('file:///shared.webp');
  expect(counts.queueLoads).toBe(1);
  expect(counts.nativeReads).toBe(0);
  await act(async () => { tree.unmount(); });
});
