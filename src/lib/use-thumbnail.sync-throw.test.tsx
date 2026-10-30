// @ts-nocheck -- render the real hook with a synchronously throwing queue.
/**
 * MB-0002 — nothing in `useThumbnail` may throw synchronously out of the
 * effect. A throw inside `start()` (the already-loaded-key path calls it
 * directly in the effect body) must become the "unavailable" state instead.
 */
import React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, mock, test } from 'bun:test';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let state;
mock.module('react-native', () => ({ NativeModules: {}, Platform: { OS: 'ios' } }));
mock.module('expo-modules-core', () => ({ requireOptionalNativeModule: () => undefined }));
// Stable identity: a fresh object per render would re-run the effect forever.
const crypto = {
  isUnlocked: true,
  getMasterKeyHandleId: () => 7,
  getFileKeyBytes: async () => new Uint8Array(32),
  decryptChunk: async () => new Uint8Array([1]),
};
mock.module('./crypto-context', () => ({ useCrypto: () => crypto }));
mock.module('./shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: () => true,
  getSharedKeyResolver: () => null,
}));
mock.module('./thumbnail-events', () => ({ onThumbnailReady: () => ({ remove() {} }) }));
mock.module('./thumbnail-cache', () => ({
  getCachedThumbnail: async () => null,
  enqueueThumbnailLoad: () => { throw new Error('queue exploded synchronously'); },
}));
mock.module('./thumbnail', () => ({
  cacheLocalThumbnail: async () => null,
  fetchDecryptedThumbnailUri: async () => 'file:///never.webp',
}));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace() {} }));

const { useThumbnail } = await import('./use-thumbnail');

function Harness({ id }) { state = useThumbnail(id); return null; }

test('a synchronous throw inside start() becomes unavailable, not an effect throw', async () => {
  let tree;
  // No try/catch here on purpose: on origin/main this call throws out of the
  // effect and the test fails; after the fix the hook reports unavailable.
  await act(async () => { tree = create(<Harness id="shared" />); });
  expect(state).toEqual({ uri: null, source: null, failed: true });
  await act(async () => { tree.unmount(); });
});
