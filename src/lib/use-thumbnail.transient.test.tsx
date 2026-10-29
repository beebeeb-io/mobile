// @ts-nocheck
/**
 * Task 2233 round 3 (N1) — `useThumbnail` ignores a transient outcome exactly
 * like CANCELLED: no `failed`, no `onUnavailable`, and the cell retries on its
 * next mount. A real null (404 / decrypt failure) still marks it failed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const ledger = {
  outcomes: {} as Record<string, unknown>,
  calls: [] as string[],
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
mock.module('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
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
  writeAsStringAsync: async () => undefined,
  copyAsync: async () => undefined,
}));
mock.module('./thumbnail', () => ({
  fetchDecryptedThumbnailUri: async (fileId: string) => {
    ledger.calls.push(fileId);
    return ledger.outcomes[fileId];
  },
  cacheLocalThumbnail: async () => null,
}));
mock.module('./shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: () => false,
  getSharedKeyResolver: () => null,
}));
mock.module('./shared-folder-tree', () => ({ isForeignSharedFile: () => false }));
mock.module('./thumbnail-events', () => ({ onThumbnailReady: () => ({ remove: () => {} }) }));
const cryptoValue = {
  getFileKeyBytes: async () => new Uint8Array(32),
  decryptChunk: async () => new Uint8Array(),
  isUnlocked: true,
};
mock.module('./crypto-context', () => ({
  useCrypto: () => cryptoValue,
}));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));

const outcome = await import('./thumbnail-load-outcome');
const { THUMBNAIL_LOAD_TRANSIENT } = outcome;
const { useThumbnail } = await import('./use-thumbnail');
const { clearThumbnailQueue } = await import('./thumbnail-cache');

const published: Array<{ uri: string | null; failed: boolean }> = [];

function Probe({ fileId }: { fileId: string }) {
  const state = useThumbnail(fileId, { hasThumbnail: true });
  published.push({ uri: state.uri, failed: state.failed });
  return null;
}

async function run(fileId: string): Promise<{ uri: string | null; failed: boolean }> {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<Probe fileId={fileId} />);
    await new Promise((r) => setTimeout(r, 15));
  });
  await act(async () => { renderer.unmount(); });
  return published[published.length - 1];
}

describe('task 2233 round 3 N1 — a transient load is not a failed tile', () => {
  beforeEach(() => {
    clearThumbnailQueue();
    ledger.outcomes = {};
    ledger.calls = [];
    published.length = 0;
  });

  test('backoff skip is transient → not failed', async () => {
    ledger.outcomes['backoff'] = THUMBNAIL_LOAD_TRANSIENT;
    expect(await run('backoff')).toEqual({ uri: null, failed: false });
  });

  test('429/5xx is transient → not failed', async () => {
    ledger.outcomes['server-error'] = THUMBNAIL_LOAD_TRANSIENT;
    expect(await run('server-error')).toEqual({ uri: null, failed: false });
  });

  test('a fetch that throws is transient → not failed', async () => {
    ledger.outcomes['fetch-threw'] = THUMBNAIL_LOAD_TRANSIENT;
    expect(await run('fetch-threw')).toEqual({ uri: null, failed: false });
  });

  test('a failed write is transient → not failed', async () => {
    ledger.outcomes['write-failed'] = THUMBNAIL_LOAD_TRANSIENT;
    expect(await run('write-failed')).toEqual({ uri: null, failed: false });
  });

  test('a real 404 (null) still marks the tile failed', async () => {
    ledger.outcomes['real-404'] = null;
    expect(await run('real-404')).toEqual({ uri: null, failed: true });
  });
});
