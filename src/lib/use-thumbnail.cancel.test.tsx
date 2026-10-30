// @ts-nocheck
/**
 * Task 2233 round 2 (P1-1) — a cancelled effect run must not mark a still
 * visible tile as failed.
 *
 * The hook shared ONE `cancelledRef` across effect runs. When `width` (or
 * `enabled` / `hasThumbnail`) changed, cleanup aborted the old load; its
 * abort resolved `null`; the next run had already reset the shared flag to
 * false, so the old `null` set `failed: true` → `ThumbnailImage` called
 * `onUnavailable` → PhotosScreen cleared `has_thumbnail` and the tile stayed
 * blank until a refetch.
 *
 * Required: the cancel flag is per effect run, and a cancelled load is
 * ignored (no `setState`, never `failed`). Every state the hook ever
 * published for a still-visible tile must be non-failed, and the re-run's
 * load must land.
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
  local: [] as Array<{ fileId: string; resolve: (value: string | null) => void }>,
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
  // The local generator is the second place a stale run can publish: it never
  // sees the queue's CANCELLED sentinel, so only the per-run flag stops it.
  cacheLocalThumbnail: (fileId: string) =>
    new Promise<string | null>((resolve) => { ledger.local.push({ fileId, resolve }); }),
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
mock.module('./crypto-context', () => ({ useCrypto: () => cryptoValue }));
mock.module('./local-identifier-map', () => ({
  getLocalIdentifier: (fileId: string) => (fileId.startsWith('local-') ? 'asset-1' : null),
}));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => {} }));

const { useThumbnail } = await import('./use-thumbnail');
const { clearThumbnailQueue, enqueueThumbnailLoad, thumbnailQueueStats } = await import('./thumbnail-cache');

const published: Array<{ uri: string | null; failed: boolean }> = [];

function Probe({ fileId, width = 256, hasThumbnail = true }: { fileId: string; width?: number; hasThumbnail?: boolean }) {
  const state = useThumbnail(fileId, { width, hasThumbnail });
  published.push({ uri: state.uri, failed: state.failed });
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

async function settle(ms = 15): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

describe('task 2233 round 2 P1-1 — cancelled run never marks the tile failed', () => {
  beforeEach(() => {
    clearThumbnailQueue();
    ledger.fetchCalls = [];
    ledger.signals = [];
    ledger.aborted = 0;
    ledger.release = [];
    ledger.local = [];
    published.length = 0;
  });

  test('effect re-run with a QUEUED load: re-run lands, no failed state was ever published', async () => {
    await fillSlots();

    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<Probe fileId="queued-file" />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(thumbnailQueueStats().waiting).toBe(1); // the six blockers occupy every slot

    // Re-run the effect (width is a dependency) while the first run is queued.
    await act(async () => {
      renderer.update(<Probe fileId="queued-file" width={128} />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(thumbnailQueueStats().waiting).toBe(1);

    await act(async () => { releaseBlockers(); await new Promise((r) => setTimeout(r, 20)); });
    // The re-run's load now owns a slot; let its fetch land.
    expect(ledger.fetchCalls).toEqual(['queued-file']);
    await act(async () => {
      ledger.release.forEach((release) => release());
      await new Promise((r) => setTimeout(r, 20));
    });

    const final = published[published.length - 1];
    expect(final.uri).toBe('file:///doc/thumb.webp');
    expect(final.failed).toBe(false);
    expect(published.some((s) => s.failed)).toBe(false);

    await act(async () => { renderer.unmount(); });
  });

  test('effect re-run with a RUNNING load: re-run lands, no failed state was ever published', async () => {
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<Probe fileId="running-file" />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(ledger.fetchCalls).toEqual(['running-file']);
    expect(ledger.signals[0]?.aborted).toBe(false);

    // Re-run the effect while the fetch is in flight.
    await act(async () => {
      renderer.update(<Probe fileId="running-file" width={128} />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(ledger.signals[0]?.aborted).toBe(true);

    // Let the re-run's fetch land.
    await act(async () => {
      ledger.release.forEach((release) => release());
      await new Promise((r) => setTimeout(r, 20));
    });

    const final = published[published.length - 1];
    expect(final.uri).toBe('file:///doc/thumb.webp');
    expect(final.failed).toBe(false);
    expect(published.some((s) => s.failed)).toBe(false);

    await act(async () => { renderer.unmount(); });
  });

  test('effect re-run while the LOCAL generator is pending: the stale null is ignored, a live miss still fails', async () => {
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<Probe fileId="local-stale" width={256} hasThumbnail={false} />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(ledger.local.map((call) => call.fileId)).toEqual(['local-stale']);

    // Re-run the effect while run 1 is still generating the local thumbnail.
    await act(async () => {
      renderer.update(<Probe fileId="local-stale" width={128} hasThumbnail={false} />);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(ledger.local.length).toBe(2);

    // Run 1's miss must not reach the tile: only the live run may publish `failed`.
    await act(async () => { ledger.local[0].resolve(null); await new Promise((r) => setTimeout(r, 10)); });
    expect(published.some((state) => state.failed)).toBe(false);

    // Control — the live run's miss is a real "no thumbnail".
    await act(async () => { ledger.local[1].resolve(null); await new Promise((r) => setTimeout(r, 10)); });
    const final = published[published.length - 1];
    expect(final.failed).toBe(true);
    expect(final.uri).toBeNull();

    await act(async () => { renderer.unmount(); });
  });
});
