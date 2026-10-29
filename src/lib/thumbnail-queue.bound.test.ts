// @ts-nocheck
/**
 * Task 2233 item 1 (A3, adversarial case 3) — the thumbnail queue is bounded
 * and newest-first.
 *
 * Today the queue is an unbounded FIFO: a 500-photo fling leaves the landing
 * viewport's tiles behind every stale job. Required: at most 96 waiting, the
 * oldest waiting job resolves `null` on overflow, and the last enqueued job
 * is the first one served.
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

const {
  MAX_WAITING_THUMBNAIL_JOBS,
  clearThumbnailQueue,
  enqueueThumbnailLoad,
  thumbnailQueueStats,
} = await import('./thumbnail-cache');

describe('task 2233 A3 — bounded, newest-first thumbnail queue', () => {
  beforeEach(() => {
    clearThumbnailQueue();
  });

  test('200 enqueues: at most 96 wait, the oldest are dropped, the newest is served first', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loader = async (id: string) => {
      started.push(id);
      await gate;
      return `uri://${id}`;
    };

    const promises: Array<Promise<string | null>> = [];
    for (let i = 0; i < 200; i++) promises.push(enqueueThumbnailLoad(`id-${i}`, loader));

    // 6 slots started immediately; every other job waits.
    expect(started).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5']);
    const waiting = thumbnailQueueStats().waiting;
    expect(waiting).toBeLessThanOrEqual(MAX_WAITING_THUMBNAIL_JOBS);
    expect(waiting).toBe(MAX_WAITING_THUMBNAIL_JOBS);
    // 194 waited at some point; the oldest 98 lost their slot.
    expect(thumbnailQueueStats().dropped).toBe(200 - 6 - MAX_WAITING_THUMBNAIL_JOBS);

    release();
    const results = await Promise.all(promises);

    // Newest-first: the first job picked after the gate opens is the last enqueued.
    expect(started[6]).toBe('id-199');
    expect(started.slice(6)).toEqual(
      Array.from({ length: MAX_WAITING_THUMBNAIL_JOBS }, (_, k) => `id-${199 - k}`),
    );

    const servedIds = results
      .map((uri, i) => [uri, `id-${i}`] as const)
      .filter(([uri]) => uri !== null)
      .map(([, id]) => id);
    expect(servedIds).toContain('id-199');
    expect(servedIds).toContain('id-104'); // the oldest id that kept its slot
    expect(servedIds).not.toContain('id-103'); // dropped by the bound
    expect(servedIds).not.toContain('id-6'); // dropped by the bound
    expect(servedIds.length).toBe(6 + MAX_WAITING_THUMBNAIL_JOBS);
  });
});
