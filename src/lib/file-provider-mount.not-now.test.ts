// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * LD-0002 round 2 (TestFlight 258, `RUNNINGBOARD 0xdead10cc`) — the JS side of
 * the "not now" answer. Once the app's background time has ended the native
 * side opens no connection to the File Provider cache and answers
 * `{status: 'not_now'}`, writing NOTHING. The write must then wait for the next
 * foreground and run again, in order: never a crash, never a silent drop.
 *
 * Same mocking pattern as `file-provider-mount.test.ts`: `react-native` and the
 * native bridge are mocked, `./file-provider-mount` is imported dynamically below
 * the mocks, and the REAL `plaintextGate` and the REAL deferral queue run.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

const foregroundListeners: Array<(state: string) => void> = [];
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      foregroundListeners.push(listener);
      return { remove: () => {} };
    },
  },
}));

const nativeCalls: Array<{ fn: string; args: unknown[] }> = [];
/** What the native side answers next, per function; the last entry repeats. */
const answers: Record<string, unknown[]> = {};
function answer(fn: string): unknown {
  const queue = answers[fn] ?? [];
  const next = queue.length > 1 ? queue.shift() : queue[0];
  return typeof next === 'function' ? (next as () => unknown)() : next;
}

mock.module('../../modules/beebeeb-crypto', () => ({
  syncFileProviderCache: async (entries: unknown[], prune: boolean, pruneParents: unknown) => {
    nativeCalls.push({ fn: 'syncFileProviderCache', args: [entries, prune, pruneParents] });
    return answer('syncFileProviderCache');
  },
  removeFileProviderEntries: async (ids: string[]) => {
    nativeCalls.push({ fn: 'removeFileProviderEntries', args: [ids] });
    return answer('removeFileProviderEntries');
  },
  setFileProviderProtectedFolder: async (id: string | null) => {
    nativeCalls.push({ fn: 'setFileProviderProtectedFolder', args: [id] });
    return answer('setFileProviderProtectedFolder');
  },
  signalFileProviderTrashEnumerator: async () => {
    nativeCalls.push({ fn: 'signalFileProviderTrashEnumerator', args: [] });
    return true;
  },
}));

const listCalls: string[] = [];
let listPlan: Record<string, unknown[]> = {};
mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'tok',
  listAllFiles: async (parentId?: string) => {
    listCalls.push(parentId ?? 'root');
    return listPlan[parentId ?? 'root'] ?? [];
  },
}));
mock.module('./encrypted-metadata', () => ({ encryptedMetadataPayloadToBytes: () => null }));
mock.module('./device-owner-auth', () => ({ requestDeviceOwnerAuth: async () => ({ ok: true }) }));
mock.module('./lock-state', () => ({ wasRecentlyUnlocked: () => true }));

const {
  populateFileProviderCache,
  syncDecryptedEntriesToFileProvider,
  removeFromFileProviderCache,
  setFileProviderProtectedBackupsRoot,
  deferredFileProviderCacheWrites,
} = await import('./file-provider-mount');
const { plaintextGate } = await import('./plaintext-gate');
const { advanceAccountEpoch } = await import('./account-epoch');

const NOT_NOW = { status: 'not_now' };
const ok = (count: number) => ({ status: 'ok', count });
const file = (id: string) => ({ id, is_folder: false, name_encrypted: 'a', size_bytes: 1, chunk_count: 1, created_at: '', updated_at: '' });

/** The app comes back to the foreground: JS `AppState` says 'active' (the real subscription replays the queue); wait for it to settle. */
async function foreground(): Promise<void> {
  for (const listener of foregroundListeners) listener('active');
  await new Promise((resolve) => setTimeout(resolve, 5));
}

afterEach(async () => {
  if (!plaintextGate.isOpen()) plaintextGate.open();
  // Anything a test left queued must not leak into the next one.
  answers.syncFileProviderCache = [ok(1)];
  answers.removeFileProviderEntries = [ok(1)];
  answers.setFileProviderProtectedFolder = [ok(1)];
  await foreground();
  nativeCalls.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
});

describe('a refused File Provider cache write waits for the foreground (LD-0002 round 2)', () => {
  test('j0: the queue subscribes to AppState once, and only an "active" state replays it', async () => {
    answers.syncFileProviderCache = [NOT_NOW, NOT_NOW, ok(1)];
    await syncDecryptedEntriesToFileProvider([file('f1')], {}, null);
    await syncDecryptedEntriesToFileProvider([file('f2')], {}, null);
    expect(foregroundListeners.length).toBe(1);
    nativeCalls.length = 0;
    foregroundListeners[0]('background');
    foregroundListeners[0]('inactive');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(nativeCalls.length).toBe(0);
    expect(deferredFileProviderCacheWrites.size).toBe(2);
    await foreground();
    expect(deferredFileProviderCacheWrites.size).toBe(0);
  });

  test('j1: sync answered not_now: nothing is lost, the same push runs again on foreground', async () => {
    answers.syncFileProviderCache = [NOT_NOW, ok(2)];
    const n = await syncDecryptedEntriesToFileProvider([file('f1'), file('f2')], { f1: 'one.txt' }, 'parent-1', { prune: true, pruneParents: ['parent-1'] });
    expect(n).toBe(0);
    expect(nativeCalls.map((c) => c.fn)).toEqual(['syncFileProviderCache']);
    expect(deferredFileProviderCacheWrites.size).toBe(1);

    await foreground();

    expect(nativeCalls.map((c) => c.fn)).toEqual(['syncFileProviderCache', 'syncFileProviderCache']);
    expect(nativeCalls[1].args).toEqual(nativeCalls[0].args); // the identical push, names and prune set included
    expect(deferredFileProviderCacheWrites.size).toBe(0);
  });

  test('j2: refused again on the foreground event: it stays queued and runs on the next one', async () => {
    answers.syncFileProviderCache = [NOT_NOW, NOT_NOW, ok(1)];
    await syncDecryptedEntriesToFileProvider([file('f1')], {}, null);
    await foreground();
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    await foreground();
    expect(deferredFileProviderCacheWrites.size).toBe(0);
    expect(nativeCalls.filter((c) => c.fn === 'syncFileProviderCache').length).toBe(3);
  });

  test('j3: queued writes run in the order they were refused, across kinds', async () => {
    answers.syncFileProviderCache = [NOT_NOW, ok(1)];
    answers.removeFileProviderEntries = [NOT_NOW, ok(1)];
    await syncDecryptedEntriesToFileProvider([file('f1')], {}, null);
    await removeFromFileProviderCache(['f2']);
    nativeCalls.length = 0;

    await foreground();

    // Writes of different ids keep the order they were refused in.
    expect(nativeCalls.map((c) => c.fn)).toEqual(['syncFileProviderCache', 'removeFileProviderEntries']);
  });

  test('j4: a later complete listing of the same parent replaces the queued one', async () => {
    answers.syncFileProviderCache = [NOT_NOW, NOT_NOW, ok(1)];
    await syncDecryptedEntriesToFileProvider([file('old')], {}, 'p', { prune: true, pruneParents: ['p'] });
    await syncDecryptedEntriesToFileProvider([file('new')], {}, 'p', { prune: true, pruneParents: ['p'] });
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    nativeCalls.length = 0;

    await foreground();

    expect(nativeCalls.length).toBe(1);
    expect(nativeCalls[0].args[0].map((e) => e.id)).toEqual(['new']);
  });

  test('j5: a sign-out between the refusal and the foreground drops the queued names: native is never called', async () => {
    answers.syncFileProviderCache = [NOT_NOW];
    await syncDecryptedEntriesToFileProvider([file('f1')], { f1: 'secret-name.txt' }, null);
    await plaintextGate.purge(async () => {});
    nativeCalls.length = 0;

    await foreground();

    expect(nativeCalls.length).toBe(0);
    expect(deferredFileProviderCacheWrites.size).toBe(0);
  });

  test('j6: a local trash answered not_now is removed on foreground, not left in Files', async () => {
    answers.removeFileProviderEntries = [NOT_NOW, ok(1)];
    await removeFromFileProviderCache(['gone-1', 'gone-2']);
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    nativeCalls.length = 0;

    await foreground();

    expect(nativeCalls).toEqual([{ fn: 'removeFileProviderEntries', args: [['gone-1', 'gone-2']] }]);
  });

  test('j7: the protected Backups root is published again on foreground, and only the latest id', async () => {
    answers.setFileProviderProtectedFolder = [NOT_NOW, NOT_NOW, ok(1)];
    await setFileProviderProtectedBackupsRoot('root-1');
    await setFileProviderProtectedBackupsRoot(null);
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    nativeCalls.length = 0;

    await foreground();

    expect(nativeCalls).toEqual([{ fn: 'setFileProviderProtectedFolder', args: [null] }]);
  });

  test('j8: an ok answer is the rows written and is never queued', async () => {
    answers.syncFileProviderCache = [ok(3)];
    answers.removeFileProviderEntries = [ok(1)];
    answers.setFileProviderProtectedFolder = [ok(1)];
    expect(await syncDecryptedEntriesToFileProvider([file('f1')], {}, null)).toBe(3);
    await removeFromFileProviderCache(['x']);
    await setFileProviderProtectedBackupsRoot('r');
    expect(deferredFileProviderCacheWrites.size).toBe(0);
  });

  test('j9: a restore push that was refused still signals Trash once, and again after the retry applied it', async () => {
    answers.syncFileProviderCache = [NOT_NOW, ok(1)];
    await syncDecryptedEntriesToFileProvider([file('restored')], {}, null, { trashChanged: true });
    expect(nativeCalls.map((c) => c.fn)).toEqual(['syncFileProviderCache', 'signalFileProviderTrashEnumerator']);
    nativeCalls.length = 0;

    await foreground();

    expect(nativeCalls.map((c) => c.fn)).toEqual(['syncFileProviderCache', 'signalFileProviderTrashEnumerator']);
  });

  test('j10: a complete listing that lands directly replaces the queued older one: its stale keep-set never runs', async () => {
    answers.syncFileProviderCache = [NOT_NOW, ok(1)];
    await syncDecryptedEntriesToFileProvider([file('old')], {}, 'p', { prune: true, pruneParents: ['p'] });
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    nativeCalls.length = 0;

    await syncDecryptedEntriesToFileProvider([file('new')], {}, 'p', { prune: true, pruneParents: ['p'] });
    expect(deferredFileProviderCacheWrites.size).toBe(0);
    await foreground();

    expect(nativeCalls.length).toBe(1);
    expect(nativeCalls[0].args[0].map((e) => e.id)).toEqual(['new']);
  });

  test('j11: a sign-in or sign-out (an account boundary) empties the queue: nothing queued for the old account is written', async () => {
    answers.syncFileProviderCache = [NOT_NOW];
    answers.removeFileProviderEntries = [NOT_NOW];
    answers.setFileProviderProtectedFolder = [NOT_NOW];
    await syncDecryptedEntriesToFileProvider([file('a1')], { a1: 'account-a-secret.txt' }, null);
    await removeFromFileProviderCache(['a2']);
    await setFileProviderProtectedBackupsRoot('a-root');
    expect(deferredFileProviderCacheWrites.size).toBe(3);
    nativeCalls.length = 0;

    advanceAccountEpoch();
    expect(deferredFileProviderCacheWrites.size).toBe(0); // dropped at the boundary itself, not only when replayed
    await foreground();

    expect(nativeCalls.map((c) => c.fn).filter((f) => f !== 'signalFileProviderTrashEnumerator')).toEqual([]);
    expect(deferredFileProviderCacheWrites.size).toBe(0);
  });

  test('j12: a trash that was refused, then a restore that succeeds: the replay never removes the restored rows', async () => {
    answers.removeFileProviderEntries = [NOT_NOW, ok(1)];
    answers.syncFileProviderCache = [ok(1)];
    await removeFromFileProviderCache(['file-1', 'file-2']);
    expect(deferredFileProviderCacheWrites.size).toBe(1);

    // Undo: file-1 comes back (a partial push of the restored row, as FilesScreen does).
    await syncDecryptedEntriesToFileProvider([file('file-1')], {}, null);
    nativeCalls.length = 0;
    await foreground();

    expect(nativeCalls).toEqual([{ fn: 'removeFileProviderEntries', args: [['file-2']] }]);
    // and when the restore covers every queued id, nothing is replayed at all
    answers.removeFileProviderEntries = [NOT_NOW, ok(1)];
    await removeFromFileProviderCache(['file-3']);
    await syncDecryptedEntriesToFileProvider([file('file-3')], {}, null);
    nativeCalls.length = 0;
    await foreground();
    expect(nativeCalls.filter((c) => c.fn === 'removeFileProviderEntries')).toEqual([]);
  });

  test('j13: an older protected-root id never overwrites a newer one that was published directly', async () => {
    answers.setFileProviderProtectedFolder = [NOT_NOW, ok(1)];
    await setFileProviderProtectedBackupsRoot('old-root');
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    await setFileProviderProtectedBackupsRoot('new-root'); // succeeds directly
    expect(deferredFileProviderCacheWrites.size).toBe(0);
    nativeCalls.length = 0;
    await foreground();
    expect(nativeCalls).toEqual([]);
  });

  test('j14: a multi-parent write-through refused in the background, then a later batch for one of its parents succeeds: only the other parents are replayed', async () => {
    answers.syncFileProviderCache = [NOT_NOW, ok(1), ok(1)];
    const inA = { ...file('a1'), parent_id: 'A' };
    const inB = { ...file('b1'), parent_id: 'B' };
    await syncDecryptedEntriesToFileProvider([inA, inB], {}, null, { prune: true, pruneParents: ['A', 'B'] });
    expect(deferredFileProviderCacheWrites.size).toBe(1);

    // an SSE batch adds f to parent A and succeeds directly
    const added = { ...file('a2'), parent_id: 'A' };
    await syncDecryptedEntriesToFileProvider([inA, added], {}, null, { prune: true, pruneParents: ['A'] });
    nativeCalls.length = 0;

    await foreground();

    expect(nativeCalls.length).toBe(1);
    const [entries, prune, pruneParents] = nativeCalls[0].args;
    expect(entries.map((e) => e.id)).toEqual(['b1']);
    expect(prune).toBe(true);
    expect(pruneParents).toEqual(['B']); // A is NOT re-pruned with the old keep-set: a2 survives
  });

  test('j15: queued writes hold plain data: no listing and no name map are kept alive', async () => {
    answers.syncFileProviderCache = [NOT_NOW];
    const names = { f1: 'name-that-must-not-be-retained.txt' };
    await syncDecryptedEntriesToFileProvider([file('f1')], names, null);
    const [queued] = deferredFileProviderCacheWrites.queued;
    expect(Object.keys(queued).sort()).toEqual(['entries', 'epoch', 'kind', 'prune', 'pruneParents', 'seq', 'trashChanged']);
  });

  test('j16: a listing refused after a newer listing of the same parent landed is not queued over it', async () => {
    // A is issued first and its native call is still pending; B (issued after A) lands; then A answers not_now.
    let releaseA: () => void = () => {};
    answers.syncFileProviderCache = [() => new Promise((resolve) => { releaseA = () => resolve(NOT_NOW); }), ok(1)];
    const a = syncDecryptedEntriesToFileProvider([file('old1'), file('old2')], {}, 'P', { prune: true, pruneParents: ['P'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await syncDecryptedEntriesToFileProvider([file('new1')], {}, 'P', { prune: true, pruneParents: ['P'] });
    releaseA();
    await a;
    expect(deferredFileProviderCacheWrites.size).toBe(0);
    nativeCalls.length = 0;
    await foreground();
    expect(nativeCalls).toEqual([]); // the older listing never replays over the newer one
  });

  test('j17: a newer write that FAILS puts back what it trimmed from the queue', async () => {
    answers.removeFileProviderEntries = [NOT_NOW];
    await removeFromFileProviderCache(['x', 'y']);
    expect(deferredFileProviderCacheWrites.queued[0].ids).toEqual(['x', 'y']);

    answers.syncFileProviderCache = [() => { throw new Error('native failure'); }];
    await expect(syncDecryptedEntriesToFileProvider([file('x')], {}, null)).rejects.toThrow('native failure');

    expect(deferredFileProviderCacheWrites.queued[0].ids).toEqual(['x', 'y']); // x was not restored after all
  });

  test('j18: a queued complete listing loses a parent that a newer partial write touched: the replay never deletes the fresh row', async () => {
    answers.syncFileProviderCache = [NOT_NOW, ok(1), ok(1)];
    const a1 = { ...file('a1'), parent_id: 'A' };
    const b1 = { ...file('b1'), parent_id: 'B' };
    await syncDecryptedEntriesToFileProvider([a1, b1], {}, null, { prune: true, pruneParents: ['A', 'B'] });
    // an upload of x into A (a partial push) lands
    await syncDecryptedEntriesToFileProvider([{ ...file('x'), parent_id: 'A' }], {}, null);
    nativeCalls.length = 0;
    await foreground();
    expect(nativeCalls.length).toBe(1);
    const [entries, prune, pruneParents] = nativeCalls[0].args;
    expect(entries.map((e) => e.id)).toEqual(['b1']);
    expect(pruneParents).toEqual(['B']); // A is not pruned with a keep-set that lacks x
  });

  test('j19: the mount walk stops at the first refusal: it does not list and decrypt the rest after background time ended', async () => {
    listPlan = {
      root: [{ id: 'a', is_folder: true, name_encrypted: 'a', parent_id: null }, { id: 'b', is_folder: true, name_encrypted: 'b', parent_id: null }],
      a: [{ id: 'a1', is_folder: false, name_encrypted: 'a1', parent_id: 'a' }],
      b: [{ id: 'b1', is_folder: false, name_encrypted: 'b1', parent_id: 'b' }],
    };
    listCalls.length = 0;
    answers.syncFileProviderCache = [NOT_NOW, ok(1)];
    await populateFileProviderCache(async () => 'unused');
    expect(listCalls).toEqual(['root']); // a and b were never listed
    expect(deferredFileProviderCacheWrites.size).toBe(1); // the root listing waits for the foreground
    listPlan = {};
  });

  test('j20: a write that FAILS (not a refusal) is an error: not landed, nothing queued, what it trimmed is put back', async () => {
    answers.removeFileProviderEntries = [NOT_NOW];
    await removeFromFileProviderCache(['x', 'y']);
    answers.syncFileProviderCache = [{ status: 'failed' }];
    await expect(syncDecryptedEntriesToFileProvider([file('x')], {}, null)).rejects.toThrow(/failed \(rolled back\)/);
    expect(deferredFileProviderCacheWrites.queued.map((w) => w.ids)).toEqual([['x', 'y']]);
    // and it was NOT recorded as landed: a later refusal of an older write for x is still queued
    answers.syncFileProviderCache = [ok(1)];
  });

  test('j21: the walk stops on the writer\'s own refusal even when the queue does not grow (the refusal trims a queued write to net zero)', async () => {
    answers.syncFileProviderCache = [NOT_NOW, NOT_NOW, ok(1)];
    // a queued listing of the root; the walk's own root listing supersedes it and is refused too: size 1 before, 1 after
    await syncDecryptedEntriesToFileProvider([file('r1')], {}, null, { prune: true, pruneParents: [null] });
    expect(deferredFileProviderCacheWrites.size).toBe(1);
    listPlan = {
      root: [{ id: 'a', is_folder: true, name_encrypted: 'a', parent_id: null }],
      a: [{ id: 'a1', is_folder: false, name_encrypted: 'a1', parent_id: 'a' }],
    };
    listCalls.length = 0;
    await populateFileProviderCache(async () => 'unused');
    expect(listCalls).toEqual(['root']);
    listPlan = {};
  });
});
