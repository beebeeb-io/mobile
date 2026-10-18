// @ts-nocheck
// 1302 follow-up (Codex review on PR #103, "Tie the cached tree to the
// persisted sync cursor") — CachedFileIndex now carries an optional `seq`
// stamp so SyncClient's catch-up (sync-client.ts) can prove a cache is not
// older than the CRDT sync cursor before trusting it as a seed. These tests
// cover the storage primitive's round-trip of that field in isolation from
// the sync-tree logic (covered separately in sync-client.test.ts).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const asyncStore = new Map<string, string>();
let holdWrites = false;
const writePending: Array<() => void> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (holdWrites) await new Promise<void>((resolve) => writePending.push(resolve));
      asyncStore.set(key, value);
    },
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
// Task 1959 round 2. Absent before the fix.
const epoch = await import('./account-epoch').catch(() => null);

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
  holdWrites = false;
  writePending.length = 0;
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

// Task 1959 round 2 (Codex P1 on PR #181): a cache write that belongs to an
// account that has since signed out must never land after the sign-out's clear
// (the next account would read the previous account's rows from disk).
describe('cache writes across a sign-out (task 1959 round 2)', () => {
  test('a write bound to an account epoch that ended before it ran is dropped', async () => {
    const bound = epoch ? epoch.accountEpoch() : { generation: 0, accountId: null };
    await clearCachedFileIndex(); // sign-out
    await saveCachedFileIndex('hash-A', [fileEntry({ id: 'a1' })], 1000, undefined, { epoch: bound });
    expect(await loadCachedFileIndex()).toBeNull();
  });

  test('a clear issued while a write is in flight leaves no cache behind', async () => {
    holdWrites = true;
    const write = saveCachedFileIndex('hash-A', [fileEntry({ id: 'a1' })], 1000);
    await new Promise((r) => setTimeout(r, 1));
    const clear = clearCachedFileIndex();
    holdWrites = false;
    for (const r of writePending.splice(0)) r();
    await Promise.all([write, clear]);
    expect(await loadCachedFileIndex()).toBeNull();
  });

  test('a write bound to the current epoch still lands', async () => {
    const bound = epoch ? epoch.accountEpoch() : { generation: 0, accountId: null };
    await saveCachedFileIndex('hash-B', [fileEntry({ id: 'b1' })], 1000, undefined, { epoch: bound });
    expect((await loadCachedFileIndex())?.hash).toBe('hash-B');
  });
});
