// @ts-nocheck
/**
 * Task 2233 round 2 (P1-2, P2-3) — jobs are coalesced by fileId.
 *
 * A first screen enqueues up to 72 cell jobs, then the prefetch enqueues the
 * same ids ~100 ms later. With one job per enqueue (~138 waiting) the 96 cap
 * dropped the OLDEST — the cells' own jobs — and newest-first then served the
 * prefetch's list, whose visible ids came first, LAST.
 *
 * Required: one job per fileId (+variant). A second enqueue joins the existing
 * job; the job aborts only when ALL joined signals have aborted; the fetch
 * gets the job's own controller. FIFO by first enqueue, cell-owned jobs before
 * prefetch-only jobs, cap 256 unique jobs, a dropped job resolves CANCELLED.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'android' },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
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
}));

const outcome = await import('./thumbnail-load-outcome');
const {
  MAX_WAITING_THUMBNAIL_JOBS,
  clearThumbnailQueue,
  enqueueThumbnailLoad,
  thumbnailQueueStats,
} = await import('./thumbnail-cache');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('task 2233 round 2 P1-2 — coalesce by fileId', () => {
  beforeEach(() => {
    clearThumbnailQueue();
  });

  test('72 cell enqueues + 72 prefetch re-enqueues of the same ids: 0 dropped, each id fetched once', async () => {
    const gate = deferred();
    const loaderCalls = new Map<string, number>();
    const loader = (id: string) => {
      loaderCalls.set(id, (loaderCalls.get(id) ?? 0) + 1);
      return gate.promise.then(() => `uri://${id}`);
    };

    // Cells own the first 72 jobs (6 start, 66 wait for a slot).
    const cellPromises = Array.from({ length: 72 }, (_, i) =>
      enqueueThumbnailLoad(`photo-${i}`, (_id) => loader(`photo-${i}`)),
    );
    expect(thumbnailQueueStats().active).toBe(6);
    expect(thumbnailQueueStats().waiting).toBe(66);
    const droppedBefore = thumbnailQueueStats().dropped;

    // The prefetch re-enqueues the same ids, prefetch-only.
    const prefetchPromises = Array.from({ length: 72 }, (_, i) =>
      enqueueThumbnailLoad(`photo-${i}`, (_id) => loader(`photo-${i}`), undefined, { prefetch: true }),
    );

    // Coalesced: no new jobs, and nothing visible was dropped.
    expect(thumbnailQueueStats().waiting).toBe(66);
    expect(thumbnailQueueStats().dropped).toBe(droppedBefore);

    gate.resolve();
    const results = await Promise.all([...cellPromises, ...prefetchPromises]);

    // Every id was fetched exactly once and every caller got its uri.
    expect(results.length).toBe(144);
    for (const result of results) {
      expect(typeof result).toBe('string');
    }
    expect(loaderCalls.size).toBe(72);
    for (const count of loaderCalls.values()) expect(count).toBe(1);
    expect(thumbnailQueueStats().dropped).toBe(droppedBefore);
  });

  test('one caller aborting does not kill the other caller\'s load', async () => {
    const gate = deferred();
    const controllerA = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const loader = (_id: string, signal?: AbortSignal) => {
      seenSignal = signal;
      return gate.promise.then(() => 'uri://shared');
    };

    const a = enqueueThumbnailLoad('shared', loader, controllerA.signal);
    const b = enqueueThumbnailLoad('shared', loader);

    controllerA.abort();
    expect(await a).toBe(outcome.THUMBNAIL_LOAD_CANCELLED);
    expect(seenSignal?.aborted).toBe(false);

    gate.resolve();
    expect(await b).toBe('uri://shared');
  });

  test('the job aborts only when ALL joined signals have aborted; the result is CANCELLED', async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const loader = (_id: string, signal?: AbortSignal) => {
      seenSignal = signal;
      return new Promise<string | null>((resolve) => {
        signal?.addEventListener('abort', () => resolve(null));
      });
    };

    const a = enqueueThumbnailLoad('all-abort', loader, controllerA.signal);
    const b = enqueueThumbnailLoad('all-abort', loader, controllerB.signal);

    controllerA.abort();
    expect((await a)).toBe(outcome.THUMBNAIL_LOAD_CANCELLED);
    expect(seenSignal?.aborted).toBe(false);

    controllerB.abort();
    expect((await b)).toBe(outcome.THUMBNAIL_LOAD_CANCELLED);
    expect(seenSignal?.aborted).toBe(true);
  });

  test('FIFO by first enqueue, but a cell-owned job goes before prefetch-only jobs', async () => {
    const gate = deferred();
    const started: string[] = [];
    const loader = (id: string) => {
      started.push(id);
      return gate.promise.then(() => `uri://${id}`);
    };

    // Saturate the six slots.
    for (let i = 0; i < 6; i++) void enqueueThumbnailLoad(`block-${i}`, loader);
    expect(thumbnailQueueStats().active).toBe(6);

    const p1 = enqueueThumbnailLoad('prefetch-1', loader, undefined, { prefetch: true });
    const p2 = enqueueThumbnailLoad('prefetch-2', loader, undefined, { prefetch: true });
    const cell = enqueueThumbnailLoad('cell-1', loader);

    gate.resolve();
    await Promise.all([p1, p2, cell]);
    expect(started.slice(6)).toEqual(['cell-1', 'prefetch-1', 'prefetch-2']);
  });

  test('the waiting bound is 256 unique jobs', () => {
    expect(MAX_WAITING_THUMBNAIL_JOBS).toBe(256);
  });
});
