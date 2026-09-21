// @ts-nocheck
// 1302 follow-up (Codex review on PR #103, "Tie the cached tree to the
// persisted sync cursor") — CachedFileIndex now carries an optional `seq`
// stamp so SyncClient's catch-up (sync-client.ts) can prove a cache is not
// older than the CRDT sync cursor before trusting it as a seed. These tests
// cover the storage primitive's round-trip of that field in isolation from
// the sync-tree logic (covered separately in sync-client.test.ts).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const asyncStore = new Map<string, string>();

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStore.get(key) ?? null,
    setItem: async (key: string, value: string) => { asyncStore.set(key, value); },
    removeItem: async (key: string) => { asyncStore.delete(key); },
  },
}));

// No `documentDirectory` — file-index-cache.ts falls through to the
// AsyncStorage path for both read and write, which is enough to exercise the
// `seq` round-trip without simulating a real filesystem.
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: undefined,
}));

mock.module('./plaintext-storage', () => ({
  notePlaintextPathCreated: () => {},
}));

const { loadCachedFileIndex, saveCachedFileIndex, clearCachedFileIndex } =
  await import('./file-index-cache');

function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name_encrypted: 'enc-name-1',
    size_bytes: 1234,
    is_folder: false,
    chunk_count: 3,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  asyncStore.clear();
});

describe('CachedFileIndex.seq round-trip (task 1302 follow-up)', () => {
  test('a write with a seq round-trips through a fresh load', async () => {
    await saveCachedFileIndex('hash-1', [fileEntry()], 1000, 42);

    const loaded = await loadCachedFileIndex();
    expect(loaded?.seq).toBe(42);
    expect(loaded?.hash).toBe('hash-1');
  });

  test('a write with no seq round-trips as undefined, not 0 or null', async () => {
    await saveCachedFileIndex('hash-2', [fileEntry()]);

    const loaded = await loadCachedFileIndex();
    expect(loaded?.seq).toBeUndefined();
  });

  test('a later write without seq clears a previously-stamped one — the cache always reflects only what THIS write actually wrote', async () => {
    await saveCachedFileIndex('hash-3', [fileEntry()], 1000, 7);
    let loaded = await loadCachedFileIndex();
    expect(loaded?.seq).toBe(7);

    // e.g. FilesScreen's own REST-driven fetchFiles overwrote the cache
    // later in the same session — it has no sync cursor to stamp.
    await saveCachedFileIndex('hash-3', [fileEntry()], 2000);
    loaded = await loadCachedFileIndex();
    expect(loaded?.seq).toBeUndefined();
  });

  test('clearCachedFileIndex removes the seq along with everything else', async () => {
    await saveCachedFileIndex('hash-4', [fileEntry()], 1000, 9);
    await clearCachedFileIndex();

    const loaded = await loadCachedFileIndex();
    expect(loaded).toBeNull();
  });
});
