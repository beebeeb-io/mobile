// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory AsyncStorage so the queue + persistence is testable without the
// native module. Exposed to the test so we can simulate a "prior process".
const store = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
    getAllKeys: async () => [...store.keys()],
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
    multiRemove: async (keys: string[]) => {
      for (const k of keys) store.delete(k);
    },
  },
}));

// Tracing is pure but references the RN __DEV__ global; stub it so the test is
// hermetic.
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => null }));

const {
  setPendingShareKey,
  consumeShareKey,
  consumeShareKeyAsync,
  hydrateShareKeys,
  __setClockForTest,
  __resetShareKeyStoreForTest,
} = await import('./share-key-store');

const PFX = 'beebeeb.pendingShareKey.';
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store.clear();
  __resetShareKeyStoreForTest();
});

describe('share-key-store (0710 pending-key queue)', () => {
  test('queues multiple tokens without clobbering (the single-slot bug)', () => {
    setPendingShareKey('tokA', 'keyA');
    setPendingShareKey('tokB', 'keyB');
    expect(consumeShareKey('tokA')).toBe('keyA');
    expect(consumeShareKey('tokB')).toBe('keyB');
  });

  test('consume-once: a second sync consume returns null', () => {
    setPendingShareKey('t', 'k');
    expect(consumeShareKey('t')).toBe('k');
    expect(consumeShareKey('t')).toBeNull();
  });

  test('miss returns null', () => {
    expect(consumeShareKey('nope')).toBeNull();
  });

  test('expired entry past the TTL returns null', () => {
    let t = 1_000_000;
    __setClockForTest(() => t);
    setPendingShareKey('t', 'k');
    t += 11 * 60 * 1000; // 11 min > 10 min TTL
    expect(consumeShareKey('t')).toBeNull();
  });

  test('write-through persists each token to AsyncStorage', async () => {
    setPendingShareKey('t', 'k');
    await tick();
    expect(store.get(`${PFX}t`)).toBeTruthy();
  });

  test('async fallback recovers a fragment persisted by a prior process', async () => {
    store.set(`${PFX}t`, JSON.stringify({ shareKey: 'k', capturedAtMs: Date.now() }));
    expect(consumeShareKey('t')).toBeNull(); // not in fresh memory
    expect(await consumeShareKeyAsync('t')).toBe('k'); // found in storage
    expect(await consumeShareKeyAsync('t')).toBeNull(); // consume-once across storage
    expect(store.has(`${PFX}t`)).toBe(false);
  });

  test('a sync consume MISS does not clobber a storage-only entry', async () => {
    store.set(`${PFX}t`, JSON.stringify({ shareKey: 'k', capturedAtMs: Date.now() }));
    expect(consumeShareKey('t')).toBeNull();
    expect(store.get(`${PFX}t`)).toBeTruthy(); // survives the miss
    expect(await consumeShareKeyAsync('t')).toBe('k');
  });

  test('hydrate loads fresh entries into the sync path and prunes expired', async () => {
    const t = 5_000_000;
    __setClockForTest(() => t);
    store.set(`${PFX}fresh`, JSON.stringify({ shareKey: 'kf', capturedAtMs: t - 1000 }));
    store.set(`${PFX}old`, JSON.stringify({ shareKey: 'ko', capturedAtMs: t - 11 * 60 * 1000 }));
    await hydrateShareKeys();
    expect(consumeShareKey('fresh')).toBe('kf'); // now reachable by the sync path
    expect(store.has(`${PFX}old`)).toBe(false); // expired pruned
  });

  test('async fallback drops an expired storage entry', async () => {
    const t = 9_000_000;
    __setClockForTest(() => t);
    store.set(`${PFX}t`, JSON.stringify({ shareKey: 'k', capturedAtMs: t - 11 * 60 * 1000 }));
    expect(await consumeShareKeyAsync('t')).toBeNull();
    expect(store.has(`${PFX}t`)).toBe(false); // removed even though expired
  });

  test('corrupt storage value is ignored, not thrown', async () => {
    store.set(`${PFX}t`, '{not valid json');
    expect(await consumeShareKeyAsync('t')).toBeNull();
  });
});
