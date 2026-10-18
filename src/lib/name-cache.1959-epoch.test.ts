// @ts-nocheck
/**
 * Task 1959 round 3: every write into the persistent decrypted-name cache is
 * bound to the account epoch its caller started under (`account-epoch.ts`).
 *
 * The case: the backup reconcile (or the delete cascade) calls
 * `pruneNameCache()` under account A. The prune reads the cache file, A signs
 * out while the read is pending (the sign-out sweep deletes the file), B signs
 * in, and the prune then wrote A's remaining DECRYPTED names back to disk for
 * B's Files screen to seed from. The plaintext gate did not stop it: the
 * prune's write took its lease after B's sign-in had reopened the gate.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const DOC = 'file:///tmp/docs/';
const CACHE_FILE = `${DOC}beebeeb-name-cache-v1.json`;

const files = new Map<string, string>();
let holdRead = false;
const readPending: Array<() => void> = [];

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: DOC,
  getInfoAsync: async (uri: string) => ({ exists: files.has(uri) }),
  readAsStringAsync: async (uri: string) => {
    const value = files.get(uri);
    if (holdRead) await new Promise<void>((resolve) => readPending.push(resolve));
    if (value === undefined) throw new Error('no such file');
    return value;
  },
  writeAsStringAsync: async (uri: string, value: string) => { files.set(uri, value); },
  deleteAsync: async (uri: string) => { files.delete(uri); },
}));
mock.module('./plaintext-storage', () => ({ notePlaintextPathCreated: () => {} }));
mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => null }));

const { pruneNameCache, saveNameCacheNow, scheduleSaveNameCache, clearNameCache, loadNameCache } =
  await import('./name-cache');
const { accountEpoch, advanceAccountEpoch } = await import('./account-epoch');

const tick = () => new Promise((r) => setTimeout(r, 1));

const A_NAMES = {
  a1: { name: 'A tax return 2025.pdf', mime: 'application/pdf', version: 1 },
  a2: { name: 'A passport scan.jpg', mime: 'image/jpeg', version: 1 },
};

beforeEach(() => {
  files.clear();
  holdRead = false;
  readPending.length = 0;
});

describe('name cache writes are bound to the caller\'s account epoch (task 1959 round 3)', () => {
  test('a prune that started under A and finished after A signed out and B signed in writes nothing', async () => {
    files.set(CACHE_FILE, JSON.stringify(A_NAMES));
    const underA = accountEpoch();

    holdRead = true;
    const prune = pruneNameCache(['a1'], underA);
    await tick(); // the prune is reading A's cache

    advanceAccountEpoch(); // clearToken()
    await clearNameCache(); // the sign-out sweep
    advanceAccountEpoch(); // setToken(B)

    holdRead = false;
    for (const r of readPending.splice(0)) r();
    await prune;

    expect(files.has(CACHE_FILE)).toBe(false);
    expect(await loadNameCache()).toEqual({});
  });

  test('saveNameCacheNow bound to an epoch that has ended writes nothing', async () => {
    const underA = accountEpoch();
    advanceAccountEpoch();
    await saveNameCacheNow({ ...A_NAMES }, underA);
    expect(files.has(CACHE_FILE)).toBe(false);
  });

  test('a debounced save scheduled under A that fires after the epoch moved writes nothing', async () => {
    const underA = accountEpoch();
    scheduleSaveNameCache({ ...A_NAMES }, underA);
    advanceAccountEpoch();
    await new Promise((r) => setTimeout(r, 1_700));
    expect(files.has(CACHE_FILE)).toBe(false);
  });

  test('writes under the current epoch still land (prune and save)', async () => {
    const now = accountEpoch();
    await saveNameCacheNow({ ...A_NAMES }, now);
    expect(Object.keys(await loadNameCache()).sort()).toEqual(['a1', 'a2']);
    expect(await pruneNameCache(['a1'], now)).toBe(1);
    expect(Object.keys(await loadNameCache())).toEqual(['a2']);
  });
});
