// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { moveToTrashWithUndo, trashedToastMessage } from './trash-with-undo';
import { setProtectedBackupsRootId, BACKUPS_PROTECTED_MESSAGE } from './protected-folders';

function harness(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const visible = new Set(['a', 'b', 'c', 'backups']);
  const toasts: any[] = [];
  const cacheRemovals: string[][] = [];
  const cacheRestores: string[][] = [];
  const countChanges: number[] = [];
  const restored: string[] = [];
  const refreshed: string[][] = [];
  let fileProviderTrashSignals = 0;
  let trashChanged = 0;
  let openedTrash = 0;
  const deps = {
    trashFiles: async (ids: string[]) => {
      log.push(`trash:${ids.join(',')}`);
      // The list must already be empty when the request goes out.
      log.push(`visibleDuringRequest:${[...visible].filter((id) => ids.includes(id)).length}`);
      return { trashed: ids, already_trashed: [], missing: [] };
    },
    restoreFile: async (id: string) => {
      restored.push(id);
      return { complete: true, restored_count: 1, remaining: 0, rehomed_to_root: false };
    },
    removeFromFileProviderCache: async (ids: string[]) => { cacheRemovals.push(ids); },
    collectSubtreeIds: (ids: string[]) => [...ids, ...ids.filter((id) => id === 'a').map(() => 'a-child')],
    refreshAfterRestore: (ids: string[]) => { refreshed.push(ids); },
    restoreFileProviderCache: async (ids: string[]) => { cacheRestores.push(ids); },
    signalFileProviderTrashChanged: async () => { fileProviderTrashSignals += 1; },
    changeTrashCount: (delta: number) => { countChanges.push(delta); },
    showToast: (t: any) => { toasts.push(t); },
    openTrash: () => { openedTrash += 1; },
    hide: (ids: string[]) => { ids.forEach((id) => visible.delete(id)); },
    unhide: (ids: string[]) => { ids.forEach((id) => visible.add(id)); },
    notifyTrashChanged: () => { trashChanged += 1; },
    ...overrides,
  };
  return { deps, log, visible, toasts, cacheRemovals, cacheRestores, countChanges, restored, refreshed, get fileProviderTrashSignals() { return fileProviderTrashSignals; }, get trashChanged() { return trashChanged; }, get openedTrash() { return openedTrash; } };
}

describe('moveToTrashWithUndo', () => {
  test('removes the items before the server answers, then confirms with Undo and View Trash', async () => {
    setProtectedBackupsRootId(null);
    const h = harness();
    const outcome = await moveToTrashWithUndo(['a', 'b'], h.deps);
    expect(h.log).toEqual(['trash:a,b', 'visibleDuringRequest:0']);
    expect([...h.visible].sort()).toEqual(['backups', 'c']);
    expect(outcome.trashed).toEqual(['a', 'b']);
    expect(h.cacheRemovals).toEqual([['a', 'b', 'a-child']]);
    expect(h.fileProviderTrashSignals).toBe(1);
    expect(h.trashChanged).toBe(1);
    expect(h.toasts).toHaveLength(1);
    const toast = h.toasts[0];
    expect(toast.type).toBe('success');
    expect(toast.message).toBe('2 items moved to Trash');
    expect(toast.action.label).toBe('Undo');
    expect(toast.secondaryAction.label).toBe('View Trash');
    expect(toast.key).toMatch(/^trash-/);
    toast.secondaryAction.onPress();
    expect(h.openedTrash).toBe(1);
  });

  test('shows the actionable toast synchronously while the server request is still pending', async () => {
    setProtectedBackupsRootId(null);
    let finish: (result: { trashed: string[]; already_trashed: string[]; missing: string[] }) => void = () => {};
    const h = harness({
      trashFiles: () => new Promise((resolve) => { finish = resolve; }),
    });

    const completion = moveToTrashWithUndo(['a', 'b'], h.deps);
    expect([...h.visible].sort()).toEqual(['backups', 'c']);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toBe('2 items moved to Trash');
    // The Drive row counts top-level Trash rows. Descendants are expanded only
    // for cache cleanup, so a and b contribute one each.
    expect(h.countChanges).toEqual([2]);

    finish({ trashed: ['a', 'b'], already_trashed: [], missing: [] });
    await completion;
  });

  test('a full failure puts every item back with a plain error', async () => {
    setProtectedBackupsRootId(null);
    const h = harness({ trashFiles: async () => { throw new Error('offline'); } });
    const outcome = await moveToTrashWithUndo(['a', 'b'], h.deps);
    expect([...h.visible].sort()).toEqual(['a', 'b', 'backups', 'c']);
    expect(outcome.failed).toEqual(['a', 'b']);
    expect(h.cacheRemovals).toEqual([]);
    expect(h.countChanges).toEqual([2, -2]);
    expect(h.toasts.at(-1)).toMatchObject({ type: 'error', message: "Couldn't move 2 items to Trash. Try again." });
    expect(h.toasts.at(-1).key).toBe(h.toasts[0].key);
  });

  test('a partial result is reflected exactly', async () => {
    setProtectedBackupsRootId(null);
    const h = harness({
      // 'c' is not reported at all: the server refused it.
      trashFiles: async () => ({ trashed: ['a'], already_trashed: ['b'], missing: [] }),
    });
    const outcome = await moveToTrashWithUndo(['a', 'b', 'c'], h.deps);
    expect(outcome.trashed).toEqual(['a', 'b']);
    expect(outcome.failed).toEqual(['c']);
    expect([...h.visible].sort()).toEqual(['backups', 'c']);
    expect(h.cacheRemovals).toEqual([['a', 'b', 'a-child']]);
    expect(h.toasts.at(-1).message).toBe("1 item moved to Trash. 1 item was already in Trash. Couldn't move 1 item to Trash. Try again.");
    expect(h.countChanges).toEqual([3, -2]);
  });

  test('missing items stay out of the list (they are already gone)', async () => {
    setProtectedBackupsRootId(null);
    const h = harness({ trashFiles: async () => ({ trashed: ['a'], already_trashed: [], missing: ['b'] }) });
    const outcome = await moveToTrashWithUndo(['a', 'b'], h.deps);
    expect(outcome.missing).toEqual(['b']);
    expect(h.visible.has('b')).toBe(false);
    expect(h.cacheRemovals).toEqual([['a', 'a-child']]);
    expect(h.toasts.at(-1).message).toBe('1 item moved to Trash. 1 item was already gone.');
    expect(h.countChanges).toEqual([2, -1]);
  });

  test('Undo restores the items, puts them back and refreshes the Files app view', async () => {
    setProtectedBackupsRootId(null);
    const h = harness();
    await moveToTrashWithUndo(['a', 'b'], h.deps);
    await h.toasts[0].action.onPress();
    expect(h.restored.sort()).toEqual(['a', 'b']);
    expect([...h.visible].sort()).toEqual(['a', 'b', 'backups', 'c']);
    expect(h.refreshed).toEqual([['a', 'b']]);
    expect(h.cacheRestores).toEqual([['a', 'b']]);
    expect(h.fileProviderTrashSignals).toBe(2);
    expect(h.countChanges).toEqual([2, -2]);
    expect(h.trashChanged).toBe(2);
    expect(h.toasts[1]).toEqual({ type: 'success', message: '2 items restored' });
  });

  test('Undo pressed before the slow trash request finishes restores only after cache removal', async () => {
    setProtectedBackupsRootId(null);
    let finish: (result: { trashed: string[]; already_trashed: string[]; missing: string[] }) => void = () => {};
    const events: string[] = [];
    const h = harness({
      trashFiles: () => new Promise((resolve) => { finish = resolve; }),
      removeFromFileProviderCache: async () => { events.push('cache-remove'); },
      restoreFile: async (id: string) => {
        events.push(`restore:${id}`);
        return { complete: true, restored_count: 1, remaining: 0, rehomed_to_root: false };
      },
      restoreFileProviderCache: async () => { events.push('cache-refresh'); },
    });

    const completion = moveToTrashWithUndo(['a'], h.deps);
    h.toasts[0].action.onPress();
    expect(events).toEqual([]);
    finish({ trashed: ['a'], already_trashed: [], missing: [] });
    await completion;
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['cache-remove', 'restore:a', 'cache-refresh']);
    expect(h.visible.has('a')).toBe(true);
  });

  test('Undo that partly fails reports what stayed in Trash', async () => {
    setProtectedBackupsRootId(null);
    const h = harness({
      restoreFile: async (id: string) => {
        if (id === 'b') throw new Error('nope');
        return { complete: true, restored_count: 1, remaining: 0, rehomed_to_root: false };
      },
    });
    await moveToTrashWithUndo(['a', 'b'], h.deps);
    await h.toasts[0].action.onPress();
    expect(h.visible.has('a')).toBe(true);
    expect(h.visible.has('b')).toBe(false);
    expect(h.countChanges).toEqual([2, -1]);
    expect(h.toasts[1]).toEqual({ type: 'error', message: "Couldn't restore 1 item. It's still in Trash." });
  });

  test('Undo does not claim or reveal an asynchronous restore before it completes', async () => {
    setProtectedBackupsRootId(null);
    const h = harness({
      restoreFile: async () => ({
        complete: false,
        restored_count: 500,
        remaining: 25,
        job_id: 'restore-job-1',
        rehomed_to_root: false,
      }),
    });

    await moveToTrashWithUndo(['a'], h.deps);
    await h.toasts[0].action.onPress();

    expect(h.visible.has('a')).toBe(false);
    expect(h.cacheRestores).toEqual([]);
    expect(h.countChanges).toEqual([1]);
    expect(h.refreshed).toEqual([['a']]);
    expect(h.fileProviderTrashSignals).toBe(2);
    expect(h.trashChanged).toBe(2);
    expect(h.toasts[1]).toEqual({
      type: 'info',
      message: 'Restore started for 1 item. It is finishing in the background.',
    });
  });

  test('the protected Backups root is skipped with its note', async () => {
    setProtectedBackupsRootId('backups');
    const h = harness();
    const outcome = await moveToTrashWithUndo(['a', 'backups'], h.deps);
    expect(h.log[0]).toBe('trash:a');
    expect(h.visible.has('backups')).toBe(true);
    expect(outcome.skippedProtected).toBe(true);
    expect(h.toasts[0].message).toBe(`1 item moved to Trash. ${BACKUPS_PROTECTED_MESSAGE}`);
  });

  test('only the protected root selected: nothing is sent', async () => {
    setProtectedBackupsRootId('backups');
    const h = harness();
    await moveToTrashWithUndo(['backups'], h.deps);
    expect(h.log).toEqual([]);
    expect(h.toasts).toEqual([{ type: 'info', message: BACKUPS_PROTECTED_MESSAGE }]);
    setProtectedBackupsRootId(null);
  });

  test('toast wording', () => {
    expect(trashedToastMessage(1)).toBe('1 item moved to Trash');
    expect(trashedToastMessage(1, 'Notes.txt')).toBe('"Notes.txt" moved to Trash');
    expect(trashedToastMessage(5)).toBe('5 items moved to Trash');
  });
});
