// @ts-nocheck
/**
 * Task 2233 item 1 (A3) + round 2 (P1-2) — the thumbnail queue is bounded.
 *
 * Round 1 capped the waiting set at 96 and served newest-first. Round 2 keeps
 * the bound but counts UNIQUE jobs (jobs coalesce by fileId), raises the cap to
 * 256, drops the oldest PREFETCH-ONLY job first and serves FIFO by first
 * enqueue. Abort-on-unmount already removes a fling's stale jobs, so FIFO is
 * the correct order for what is left; a dropped job is CANCELLED, never
 * "no thumbnail".
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

const { THUMBNAIL_LOAD_CANCELLED } = await import('./thumbnail-load-outcome');
const {
  MAX_WAITING_THUMBNAIL_JOBS,
  clearThumbnailQueue,
  enqueueThumbnailLoad,
  thumbnailQueueStats,
} = await import('./thumbnail-cache');

describe('task 2233 A3/P1-2 — bounded FIFO queue over unique jobs', () => {
  beforeEach(() => {
    clearThumbnailQueue();
  });

  test('300 enqueues: at most 256 wait, the oldest waiting are dropped (CANCELLED), the rest run FIFO', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loader = async (id: string) => {
      started.push(id);
      await gate;
      return `uri://${id}`;
    };

    const promises: Array<Promise<string | null>> = [];
    for (let i = 0; i < 300; i++) promises.push(enqueueThumbnailLoad(`id-${i}`, loader));

    // 6 slots started immediately; every other job waits.
    expect(started).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5']);
    expect(MAX_WAITING_THUMBNAIL_JOBS).toBe(256);
    expect(thumbnailQueueStats().waiting).toBe(MAX_WAITING_THUMBNAIL_JOBS);
    // 294 waited at some point; the OLDEST 38 lost their slot.
    expect(thumbnailQueueStats().dropped).toBe(300 - 6 - MAX_WAITING_THUMBNAIL_JOBS);

    release();
    const results = await Promise.all(promises);

    // FIFO by first enqueue: id-44 is the oldest job that kept its slot.
    expect(started[6]).toBe('id-44');
    expect(started.slice(6)).toEqual(
      Array.from({ length: MAX_WAITING_THUMBNAIL_JOBS }, (_, k) => `id-${44 + k}`),
    );

    const dropped = results
      .map((uri, i) => [uri, `id-${i}`] as const)
      .filter(([uri]) => uri === THUMBNAIL_LOAD_CANCELLED)
      .map(([, id]) => id);
    expect(dropped).toEqual(Array.from({ length: 38 }, (_, k) => `id-${6 + k}`));
    expect(results.filter((uri) => uri !== THUMBNAIL_LOAD_CANCELLED).length).toBe(6 + 256);
  });

  test('a mounted cell job survives overflow; the oldest prefetch-only job is dropped first', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const loader = async (id: string) => {
      started.push(id);
      await gate;
      return `uri://${id}`;
    };

    // Saturate the slots, then fill the waiting set with prefetch jobs.
    for (let i = 0; i < 6; i++) void enqueueThumbnailLoad(`block-${i}`, loader);
    const prefetch: Array<Promise<string | null>> = [];
    for (let i = 0; i < MAX_WAITING_THUMBNAIL_JOBS; i++) {
      prefetch.push(enqueueThumbnailLoad(`prefetch-${i}`, loader, undefined, { prefetch: true }));
    }
    expect(thumbnailQueueStats().waiting).toBe(MAX_WAITING_THUMBNAIL_JOBS);
    const droppedBefore = thumbnailQueueStats().dropped;

    // One more cell job overflows: the oldest prefetch-only job loses.
    const cell = enqueueThumbnailLoad('cell-new', loader);
    expect(thumbnailQueueStats().waiting).toBe(MAX_WAITING_THUMBNAIL_JOBS);
    expect(thumbnailQueueStats().dropped).toBe(droppedBefore + 1);

    release();
    const cellUri = await cell;
    expect(cellUri).toBe('uri://cell-new');
    const prefetchResults = await Promise.all(prefetch);
    expect(prefetchResults[0]).toBe(THUMBNAIL_LOAD_CANCELLED); // dropped
    expect(prefetchResults[1]).toBe('uri://prefetch-1');
    expect(started.slice(6)[0]).toBe('cell-new'); // cell jobs go first
  });
});
