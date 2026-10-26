// @ts-nocheck — real hook, isolated native dependencies.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, mock, test } from 'bun:test';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const platform = { OS: 'android' };
let cacheReads = 0;
let nativeReads = 0;
let state;
let localId = null;
const key = async () => new Uint8Array(32);
mock.module('react-native', () => ({ Platform: platform }));
mock.module('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({
  getThumbnail: async () => { nativeReads++; return { uri: 'native://thumbnail', source: 'cache' }; },
}) }));
mock.module('./crypto-context', () => ({ useCrypto: () => ({ getFileKeyBytes: key, isUnlocked: true }) }));
mock.module('./thumbnail-events', () => ({ onThumbnailReady: () => ({ remove() {} }) }));
mock.module('./thumbnail-cache', () => ({
  getCachedThumbnail: async (id) => { cacheReads++; return `cache://${id}`; },
  enqueueThumbnailLoad: async () => { throw new Error('warm thumbnail must not fetch'); },
}));
mock.module('./thumbnail', () => ({ cacheLocalThumbnail: async () => null, fetchDecryptedThumbnailUri: async () => null }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => localId }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace() {} }));
const { useThumbnail } = await import('./use-thumbnail');
function Harness({ fileId = 'photo', mimeType = null, enabled = true }) {
  state = useThumbnail(fileId, { mimeType, enabled });
  return null;
}
beforeEach(() => { cacheReads = 0; nativeReads = 0; localId = null; platform.OS = 'android'; });
test('Android remote metadata arriving after a cache hit does not clear/reload the image', async () => {
  let tree;
  await act(async () => { tree = create(<Harness />); });
  expect(state.uri).toBe('cache://photo');
  await act(async () => { tree.update(<Harness mimeType="image/jpeg" />); });
  expect(state.uri).toBe('cache://photo');
  expect(cacheReads).toBe(1);
  await act(async () => { tree.unmount(); });
});
test('Android still clears the thumbnail when loading is disabled (including locked tiles)', async () => {
  let tree;
  await act(async () => { tree = create(<Harness />); });
  await act(async () => { tree.update(<Harness enabled={false} />); });
  expect(state.uri).toBeNull();
  await act(async () => { tree.unmount(); });
});
test('a different Android file still gets its own thumbnail', async () => {
  let tree;
  await act(async () => { tree = create(<Harness />); });
  await act(async () => { tree.update(<Harness fileId="next" />); });
  expect(state.uri).toBe('cache://next');
  expect(cacheReads).toBe(2);
  await act(async () => { tree.unmount(); });
});
test('iOS preserves its existing metadata-triggered native request', async () => {
  platform.OS = 'ios';
  let tree;
  await act(async () => { tree = create(<Harness />); });
  await act(async () => { tree.update(<Harness mimeType="image/jpeg" />); });
  expect(state.uri).toBe('native://thumbnail');
  expect(nativeReads).toBe(2);
  expect(cacheReads).toBe(0);
  await act(async () => { tree.unmount(); });
});

test('Android local-asset entries retain their MIME-triggered refresh', async () => {
  localId = 'local-asset';
  let tree;
  await act(async () => { tree = create(<Harness />); });
  await act(async () => { tree.update(<Harness mimeType="image/jpeg" />); });
  expect(cacheReads).toBe(2);
  await act(async () => { tree.unmount(); });
});
