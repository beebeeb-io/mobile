// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 round 4 (security re-review of #141, P1-1) — the JS File Provider
 * name writers (`populateFileProviderCache`'s BFS walk and its shared push,
 * `syncDecryptedEntriesToFileProvider`) must run under the plaintext gate so a
 * walk in flight cannot recreate the native `file-provider-cache.sqlite`
 * (decrypted names) after a sign-out purge resets it.
 *
 * `./file-provider-mount` imports `react-native` (Flow syntax bun's parser
 * rejects — see mobile/CLAUDE.md "Tests") and `../../modules/beebeeb-crypto`
 * (the native bridge), so this file mocks both itself, plus `./api`,
 * `./encrypted-metadata`, `./device-owner-auth` and `./lock-state`. Static
 * `import` statements are hoisted above `mock.module` calls regardless of
 * source order, so `./file-provider-mount` is loaded via a dynamic `await
 * import(...)` below the mocks (same pattern as `account-cleanup.test.ts`).
 * `./plaintext-gate` has no problematic imports and is loaded directly — this
 * file drives the REAL shared `plaintextGate` singleton, same as production.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const nativeCalls: Array<{ fn: string; args: unknown[] }> = [];
let onSyncFileProviderCache: ((entries: unknown[], prune: boolean, pruneParents: unknown) => void) | null = null;

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorSessionToAppGroup: async () => {},
  mountFileProviderAccess: async () => ({ registered: true, cacheDatabaseReady: true }),
  removeFileProviderAccess: async () => ({ registered: false }),
  removeFileProviderEntries: async () => 0,
  syncFileProviderCache: async (entries: unknown[], prune: boolean, pruneParents: unknown) => {
    nativeCalls.push({ fn: 'syncFileProviderCache', args: [entries, prune, pruneParents] });
    onSyncFileProviderCache?.(entries, prune, pruneParents);
    return (entries as unknown[]).length;
  },
}));

type FolderPlan = Record<string, Array<{ id: string; is_folder: boolean; name_encrypted: string; parent_id: string | null }>>;
let listAllFilesPlan: FolderPlan = {};
const listAllFilesCalls: Array<string | null> = [];

mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'tok',
  listAllFiles: async (parentId?: string) => {
    const key = parentId ?? 'root';
    listAllFilesCalls.push(key);
    return listAllFilesPlan[key] ?? [];
  },
}));

mock.module('./encrypted-metadata', () => ({
  encryptedMetadataPayloadToBytes: () => null,
}));

mock.module('./device-owner-auth', () => ({
  requestDeviceOwnerAuth: async () => ({ ok: true }),
}));

mock.module('./lock-state', () => ({
  wasRecentlyUnlocked: () => true,
}));

const { populateFileProviderCache, syncDecryptedEntriesToFileProvider } = await import('./file-provider-mount');
const { plaintextGate } = await import('./plaintext-gate');
const decryptMetadata = async () => 'unused';

afterEach(() => {
  // Tests below close the shared singleton gate; never leak that into the
  // next test (mirrors plaintext-gate's own "after a purge... until open()").
  if (!plaintextGate.isOpen()) plaintextGate.open();
  nativeCalls.length = 0;
  listAllFilesCalls.length = 0;
  listAllFilesPlan = {};
  onSyncFileProviderCache = null;
});

describe('syncDecryptedEntriesToFileProvider (task 1593 round 4)', () => {
  test('pushes to native when the gate is open', async () => {
    const n = await syncDecryptedEntriesToFileProvider(
      [{ id: 'f1', is_folder: false, name_encrypted: 'a', size_bytes: 1, chunk_count: 1, created_at: '', updated_at: '' }],
      {},
      null,
    );
    expect(n).toBe(1);
    expect(nativeCalls.length).toBe(1);
  });

  test('a closed gate refuses the push: returns 0, calls native ZERO times', async () => {
    await plaintextGate.purge(async () => {});
    const n = await syncDecryptedEntriesToFileProvider(
      [{ id: 'f1', is_folder: false, name_encrypted: 'a', size_bytes: 1, chunk_count: 1, created_at: '', updated_at: '' }],
      {},
      null,
    );
    expect(n).toBe(0);
    expect(nativeCalls.length).toBe(0);
  });
});

describe('populateFileProviderCache (task 1593 round 4 — walk holds ONE lease for its whole span)', () => {
  test('a gate already closed before the walk starts: no listAllFiles call, no native push', async () => {
    await plaintextGate.purge(async () => {});
    const n = await populateFileProviderCache(decryptMetadata);
    expect(n).toBe(0);
    expect(listAllFilesCalls.length).toBe(0);
    expect(nativeCalls.length).toBe(0);
  });

  test('baseline: an open gate walks every folder (proves the harness itself finds folders)', async () => {
    listAllFilesPlan = {
      root: [
        { id: 'folderA', is_folder: true, name_encrypted: 'FolderA', parent_id: null },
        { id: 'folderB', is_folder: true, name_encrypted: 'FolderB', parent_id: null },
      ],
      folderA: [{ id: 'leafA', is_folder: false, name_encrypted: 'leafA.txt', parent_id: 'folderA' }],
      folderB: [{ id: 'leafB', is_folder: false, name_encrypted: 'leafB.txt', parent_id: 'folderB' }],
    };
    await populateFileProviderCache(decryptMetadata);
    expect(listAllFilesCalls.sort()).toEqual(['folderA', 'folderB', 'root']);
    expect(nativeCalls.length).toBe(3); // root, folderA, folderB
  });

  test('a lease invalidated mid-walk (a sign-out purge starts) pushes NO further folders', async () => {
    listAllFilesPlan = {
      root: [
        { id: 'folderA', is_folder: true, name_encrypted: 'FolderA', parent_id: null },
        { id: 'folderB', is_folder: true, name_encrypted: 'FolderB', parent_id: null },
      ],
      folderA: [{ id: 'leafA', is_folder: false, name_encrypted: 'leafA.txt', parent_id: 'folderA' }],
      // The walk must never reach folderB — if it did, this would seed the
      // native mock and the assertions below would still pass by accident,
      // so leave it registered but never populate a plan entry consumed
      // silently: an unplanned key already returns [] from the mock, so we
      // instead assert directly on nativeCalls/listAllFilesCalls below.
      folderB: [{ id: 'leafB', is_folder: false, name_encrypted: 'leafB.txt', parent_id: 'folderB' }],
    };

    let sweepRan = false;
    // Fire a real purge() as a side effect of the SECOND native push
    // (folderA's) — synchronous: `purge()` aborts the epoch (invalidating
    // both the walk's lease and folderA's own push lease) BEFORE it awaits
    // drain(), so by the time this call returns, the walk's lease is already
    // invalid. We don't await it here — `drain()` is waiting on the walk's
    // own lease, which only releases once the walk (below) notices and stops.
    let purged: Promise<void> | null = null;
    onSyncFileProviderCache = (_entries, _prune, _pruneParents) => {
      if (nativeCalls.length === 2 && !purged) {
        purged = plaintextGate.purge(async () => { sweepRan = true; });
      }
    };

    const n = await populateFileProviderCache(decryptMetadata);

    // Exactly root + folderA were pushed; folderB was never listed or pushed.
    expect(nativeCalls.length).toBe(2);
    expect(listAllFilesCalls).toEqual(['root', 'folderA']);
    expect(n).toBe(3); // root push (2 entries: folderA + folderB) + folderA's push (1 entry: leafA)

    // The purge's drain() was waiting on the walk's own lease; it only
    // resolves — and only then runs its sweep — once populateFileProviderCache
    // actually stopped and released it.
    expect(purged).not.toBeNull();
    await purged;
    expect(sweepRan).toBe(true);
    expect(plaintextGate.isOpen()).toBe(false); // stays closed until open()
  });
});
