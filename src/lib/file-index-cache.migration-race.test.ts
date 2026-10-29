// @ts-nocheck
/**
 * Task 1959 round 3 (Codex P1 on mobile PR #181, file-index-cache.ts:72
 * "Bind legacy cache migration to its starting account").
 *
 * The legacy migration reads an old AsyncStorage copy of the index and moves
 * it into the documents-directory file. When the read starts under account A
 * and A signs out (clearCachedFileIndex) before AsyncStorage answers, the
 * migration's write used to capture the generation AFTER the clear, pass its
 * own check, and recreate A's rows on disk for account B's next load.
 *
 * A real documents directory is modelled (iOS: `documentDirectory` is set),
 * so the migration writes the file, as it does on device.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const DOC = 'file:///tmp/docs/';
const LEGACY_KEY = 'beebeeb:file-index-cache:v1';
const CACHE_FILE = `${DOC}beebeeb-file-index-cache-v1.json`;

const asyncStore = new Map<string, string>();
const files = new Map<string, string>();
let holdGetItem = false;
const getItemPending: Array<() => void> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      // The native read has the value as of the call; it only ANSWERS later.
      const value = asyncStore.get(key) ?? null;
      if (holdGetItem) await new Promise<void>((resolve) => getItemPending.push(resolve));
      return value;
    },
    setItem: async (key: string, value: string) => { asyncStore.set(key, value); },
    removeItem: async (key: string) => { asyncStore.delete(key); },
  },
}));

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: DOC,
  makeDirectoryAsync: async () => {},
  getInfoAsync: async (uri: string) => ({ exists: files.has(uri) }),
  readAsStringAsync: async (uri: string) => {
    const value = files.get(uri);
    if (value === undefined) throw new Error('no such file');
    return value;
  },
  writeAsStringAsync: async (uri: string, value: string) => { files.set(uri, value); },
  deleteAsync: async (uri: string) => { files.delete(uri); },
}));

mock.module('./plaintext-storage', () => ({
  notePlaintextPathCreated: () => {},
}));

const cacheModule = await import('./file-index-cache');
const { loadCachedFileIndex, clearCachedFileIndex } = cacheModule;
const { advanceAccountEpoch } = await import('./account-epoch');

function fileEntry(id: string) {
  return {
    id,
    name_encrypted: `enc-${id}`,
    size_bytes: 1,
    is_folder: false,
    chunk_count: 1,
    created_at: '2026-10-18T00:00:00.000Z',
    updated_at: '2026-10-18T00:00:00.000Z',
  };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

function releaseGetItem() {
  holdGetItem = false;
  for (const r of getItemPending.splice(0)) r();
}

beforeEach(() => {
  asyncStore.clear();
  files.clear();
  holdGetItem = false;
  getItemPending.length = 0;
});

describe('legacy AsyncStorage migration across a sign-out (task 1959 round 3)', () => {
  test('a migration that started under A and lost the race to a sign-out leaves nothing on disk, and B never reads A\'s rows', async () => {
    asyncStore.set(LEGACY_KEY, JSON.stringify({ hash: 'hash-A', files: [fileEntry('a1')], storedAt: 1000 }));

    holdGetItem = true;
    const loadForA = loadCachedFileIndex();
    await tick(); // A's migration is waiting on AsyncStorage.getItem

    // Sign-out: clearToken() advances the epoch, then clears the cache.
    advanceAccountEpoch();
    await clearCachedFileIndex();
    // Sign-in as B.
    advanceAccountEpoch();

    releaseGetItem();
    expect(await loadForA).toBeNull();
    // Let any write the migration queued run to completion.
    await tick();

    expect(files.has(CACHE_FILE)).toBe(false);
    const loadForB = await loadCachedFileIndex();
    expect(loadForB).toBeNull();
  });

  test('the same race without the epoch advance (a bare cache clear) also leaves nothing behind', async () => {
    asyncStore.set(LEGACY_KEY, JSON.stringify({ hash: 'hash-A', files: [fileEntry('a1')], storedAt: 1000 }));
    holdGetItem = true;
    const load = loadCachedFileIndex();
    await tick();
    await clearCachedFileIndex();
    releaseGetItem();
    expect(await load).toBeNull();
    await tick();
    expect(files.has(CACHE_FILE)).toBe(false);
    expect(await loadCachedFileIndex()).toBeNull();
  });

  test('an undisturbed migration still moves the legacy copy to disk and returns it', async () => {
    asyncStore.set(LEGACY_KEY, JSON.stringify({ hash: 'hash-A', files: [fileEntry('a1')], storedAt: 1000, seq: 5 }));
    const loaded = await loadCachedFileIndex();
    expect(loaded?.hash).toBe('hash-A');
    expect(loaded?.seq).toBe(5);
    expect(files.has(CACHE_FILE)).toBe(true);
    expect(asyncStore.has(LEGACY_KEY)).toBe(false);
    expect((await loadCachedFileIndex())?.hash).toBe('hash-A');
  });
});
