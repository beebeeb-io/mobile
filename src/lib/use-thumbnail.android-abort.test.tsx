// @ts-nocheck
/**
 * Task 2233 item 1 (A4, adversarial cases 1 and 2) — a cell's load is
 * withdrawn when the cell unmounts.
 *
 * The hook used to pass no AbortSignal: an unmounted cell's job stayed in the
 * queue (case 1) and an in-flight fetch kept downloading/decrypting for a tile
 * nobody sees (case 2). Now the effect owns an AbortController and aborts it
 * in cleanup.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const ledger = {
  fetchCalls: [] as string[],
  signals: [] as AbortSignal[],
  aborted: 0,
  release: [] as Array<() => void>,
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
  fetchDecryptedThumbnailUri: async (fileId: string, _key: unknown, signal?: AbortSignal) => {
    ledger.fetchCalls.push(fileId);
    if (signal) ledger.signals.push(signal);
    return new Promise<string | null>((resolve) => {
      const done = () => { ledger.aborted += 1; resolve(null); };
      if (signal?.aborted) return done();
      signal?.addEventListener('abort', done);
      ledger.release.push(() => resolve('file:///doc/thumb.webp'));
    });
  },
  cacheLocalThumbnail: async () => null,
}));
mock.module('./shared-folder-keys', () => ({
  sharedFileKeyIsLoaded: () => false,
  getSharedKeyResolver: () => null,
}));
mock.module('./shared-folder-tree', () => ({ isForeignSharedFile: () => false }));
mock.module('./thumbnail-events', () => ({ onThumbnailReady: () => ({ remove: () => {} }) }));
// Stable identities: useThumbnail's deps include these, so a fresh function
// per call would re-fire the effect forever.
const cryptoValue = {
  getFileKeyBytes: async () => new Uint8Array(32),
  decryptChunk: async () => new Uint8Array(),
  isUnlocked: true,
};
mock.module('./crypto-context', () => ({ useCrypto: () => cryptoValue }));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: () => null }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));

const { useThumbnail } = await import('./use-thumbnail');
const { clearThumbnailQueue, enqueueThumbnailLoad, thumbnailQueueStats } = await import('./thumbnail-cache');

function Probe({ fileId }: { fileId: string }) {
  useThumbnail(fileId);
  return null;
}

let releaseBlockers: () => void = () => {};
const blockers = new Promise<void>((resolve) => { releaseBlockers = resolve; });

async function fillSlots(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    void enqueueThumbnailLoad(`block-${i}`, async () => {
      await blockers;
      return `block-${i}`;
    });
  }
  expect(thumbnailQueueStats().active).toBe(6);
}

describe('task 2233 A4 — unmount withdraws the cell load', () => {
  beforeEach(() => {
    clearThumbnailQueue();
    ledger.fetchCalls = [];
    ledger.signals = [];
    ledger.aborted = 0;
    ledger.release = [];
  });

  test('case 1: unmount while queued — the loader never runs', async () => {
    await fillSlots();

    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<Probe fileId="queued-file" />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(thumbnailQueueStats().waiting).toBe(1);

    await act(async () => {
      renderer.unmount();
    });
    expect(thumbnailQueueStats().waiting).toBe(0);

    releaseBlockers();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(ledger.fetchCalls).toEqual([]);
  });

  test('case 2: unmount while fetching aborts the in-flight fetch', async () => {
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<Probe fileId="running-file" />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(ledger.fetchCalls).toEqual(['running-file']);
    const signal = ledger.signals[0];
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
    expect(signal?.aborted).toBe(true);
    expect(ledger.aborted).toBe(1);
  });
});
