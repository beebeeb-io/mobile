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
  return queue.length > 1 ? queue.shift() : queue[0];
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

mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'tok',
  listAllFiles: async () => [],
}));
mock.module('./encrypted-metadata', () => ({ encryptedMetadataPayloadToBytes: () => null }));
mock.module('./device-owner-auth', () => ({ requestDeviceOwnerAuth: async () => ({ ok: true }) }));
mock.module('./lock-state', () => ({ wasRecentlyUnlocked: () => true }));

const {
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
    await removeFromFileProviderCache(['f1']);
    nativeCalls.length = 0;

    await foreground();

    // A restored file pushed, then removed again: the removal must come second.
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

  test('j8: an answer from an older native build (a bare number or boolean) is an ok, never queued', async () => {
    answers.syncFileProviderCache = [3];
    answers.removeFileProviderEntries = [1];
    answers.setFileProviderProtectedFolder = [true];
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
});
