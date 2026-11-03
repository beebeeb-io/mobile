/**
 * The one way the app moves files to Trash (Drive single and multi-select, Photos, preview,
 * search). The rows leave the list at once, the server request runs behind, and a toast offers
 * Undo and View Trash. If the server refuses some or all of the items they come back with a
 * plain error.
 *
 * Dependency-injected so it can be tested without React Native; screens pass their own list
 * setters, the API calls and the toast.
 */
import type { BulkTrashResult, RestoreFileResult } from './api';
import type { ToastAction, ToastType } from './toast-context';
import { BACKUPS_PROTECTED_MESSAGE, partitionProtectedBackupsRoot } from './protected-folders';

export interface TrashToast {
  key?: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
}

export interface MoveToTrashDeps {
  trashFiles: (ids: string[]) => Promise<BulkTrashResult>;
  restoreFile: (id: string) => Promise<RestoreFileResult>;
  removeFromFileProviderCache: (ids: string[]) => Promise<void>;
  /** Rebuild/re-add File Provider rows after Undo. */
  restoreFileProviderCache?: (ids: string[]) => Promise<void>;
  /** Refresh the read-only Trash listing after a restore is accepted. */
  signalFileProviderTrashChanged?: () => Promise<void>;
  showToast: (toast: TrashToast) => void;
  openTrash: () => void;
  /** Optimistically take the rows out of the visible list. */
  hide: (ids: string[]) => void;
  /** Put rows back (failure, or Undo). */
  unhide: (ids: string[]) => void;
  /** Expand trashed folders to every descendant id (for the cache and derived stores). */
  collectSubtreeIds?: (ids: string[]) => string[];
  /** Fan confirmed trash out to derived stores (search index, thumbnails, ...). */
  onTrashed?: (subtreeIds: string[]) => void | Promise<void>;
  /** Remove rows the server says were already gone from derived stores. */
  onMissing?: (ids: string[]) => void | Promise<void>;
  /** Re-add screen-local/search state after a successful Undo. */
  onRestored?: (ids: string[]) => void;
  /** After Undo: refetch so the restored rows are fresh and the Files app sees them again. */
  refreshAfterRestore?: (ids: string[]) => void;
  /** Trash contents changed (the Drive root row's count). */
  notifyTrashChanged?: () => void;
  /** Apply the optimistic delta to the Drive root count, one per top-level Trash row. */
  changeTrashCount?: (delta: number) => void;
  /** Display name when a single item is trashed. */
  singleName?: string;
  /** Runtime timing hook; fields never include ids or names. */
  trace?: (name: string, fields: Record<string, unknown>) => void;
}

export interface MoveToTrashOutcome {
  /** All restorable rows: newly trashed plus rows already in Trash. */
  trashed: string[];
  newlyTrashed: string[];
  alreadyTrashed: string[];
  missing: string[];
  failed: string[];
  skippedProtected: boolean;
}

const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
let operationSequence = 0;

export function trashedToastMessage(count: number, singleName?: string): string {
  if (count === 1 && singleName) return `"${singleName}" moved to Trash`;
  return `${items(count)} moved to Trash`;
}

export function trashFailureMessage(count: number): string {
  return `Couldn't move ${items(count)} to Trash. Try again.`;
}

function sentenceJoin(parts: string[]): string {
  return parts.reduce((message, part) => {
    if (!message) return part;
    return `${message}${/[.!?]$/.test(message) ? ' ' : '. '}${part}`;
  }, '');
}

function reconciledMessage(outcome: MoveToTrashOutcome, singleName?: string): string {
  const parts: string[] = [];
  if (outcome.newlyTrashed.length > 0) {
    parts.push(trashedToastMessage(outcome.newlyTrashed.length, singleName));
  }
  if (outcome.alreadyTrashed.length > 0) {
    const n = outcome.alreadyTrashed.length;
    parts.push(`${items(n)} ${n === 1 ? 'was' : 'were'} already in Trash`);
  }
  if (outcome.missing.length > 0) {
    const n = outcome.missing.length;
    parts.push(`${items(n)} ${n === 1 ? 'was' : 'were'} already gone`);
  }
  if (outcome.failed.length > 0) parts.push(trashFailureMessage(outcome.failed.length));
  if (outcome.skippedProtected) parts.push(BACKUPS_PROTECTED_MESSAGE);
  const message = sentenceJoin(parts);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

export function moveToTrashWithUndo(ids: string[], deps: MoveToTrashDeps): Promise<MoveToTrashOutcome> {
  const unique = Array.from(new Set(ids));
  const { allowed, skippedProtected } = partitionProtectedBackupsRoot(unique);
  if (allowed.length === 0) {
    if (skippedProtected) deps.showToast({ type: 'info', message: BACKUPS_PROTECTED_MESSAGE });
    return Promise.resolve({
      trashed: [],
      newlyTrashed: [],
      alreadyTrashed: [],
      missing: [],
      failed: [],
      skippedProtected,
    });
  }

  const startedAt = Date.now();
  const toastKey = `trash-${++operationSequence}`;
  const optimisticTrashCount = allowed.length;
  deps.hide(allowed);
  deps.changeTrashCount?.(optimisticTrashCount);
  deps.trace?.('trash.optimistic_hidden', {
    count: allowed.length,
    trashCountDelta: optimisticTrashCount,
    elapsedMs: 0,
  });

  let completion!: Promise<MoveToTrashOutcome>;
  let undoPromise: Promise<void> | null = null;
  const requestUndo = (): Promise<void> => {
    if (!undoPromise) {
      deps.trace?.('trash.undo_requested', { count: allowed.length, elapsedMs: Date.now() - startedAt });
      undoPromise = completion.then((outcome) => undoTrash(outcome.trashed, deps, startedAt));
    }
    return undoPromise;
  };
  const actions = {
    action: { label: 'Undo', onPress: requestUndo },
    secondaryAction: { label: 'View Trash', onPress: deps.openTrash },
  };
  deps.showToast({
    key: toastKey,
    type: 'success',
    message: sentenceJoin([
      trashedToastMessage(allowed.length, deps.singleName),
      ...(skippedProtected ? [BACKUPS_PROTECTED_MESSAGE] : []),
    ]),
    ...actions,
  });

  completion = reconcileTrash(
    allowed,
    optimisticTrashCount,
    skippedProtected,
    toastKey,
    actions,
    deps,
    startedAt,
  );
  return completion;
}

async function reconcileTrash(
  allowed: string[],
  optimisticTrashCount: number,
  skippedProtected: boolean,
  toastKey: string,
  actions: { action: ToastAction; secondaryAction: ToastAction },
  deps: MoveToTrashDeps,
  startedAt: number,
): Promise<MoveToTrashOutcome> {
  deps.trace?.('trash.server_start', { count: allowed.length, elapsedMs: Date.now() - startedAt });
  let result: BulkTrashResult;
  try {
    result = await deps.trashFiles(allowed);
  } catch {
    deps.unhide(allowed);
    deps.changeTrashCount?.(-optimisticTrashCount);
    deps.showToast({ key: toastKey, type: 'error', message: trashFailureMessage(allowed.length) });
    deps.trace?.('trash.server_failed', { count: allowed.length, elapsedMs: Date.now() - startedAt });
    return {
      trashed: [],
      newlyTrashed: [],
      alreadyTrashed: [],
      missing: [],
      failed: allowed,
      skippedProtected,
    };
  }

  const newlySet = new Set(result.trashed);
  const alreadySet = new Set(result.already_trashed);
  const missingSet = new Set(result.missing);
  const explicitFailedSet = new Set(result.failed ?? []);
  const newlyTrashed = allowed.filter((id) => newlySet.has(id));
  const alreadyTrashed = allowed.filter((id) => !newlySet.has(id) && alreadySet.has(id));
  const landedSet = new Set([...newlyTrashed, ...alreadyTrashed]);
  const missing = allowed.filter((id) => !landedSet.has(id) && !explicitFailedSet.has(id) && missingSet.has(id));
  const failed = allowed.filter((id) => !landedSet.has(id) && (explicitFailedSet.has(id) || !missingSet.has(id)));
  const trashed = allowed.filter((id) => landedSet.has(id));
  const outcome: MoveToTrashOutcome = {
    trashed,
    newlyTrashed,
    alreadyTrashed,
    missing,
    failed,
    skippedProtected,
  };
  deps.trace?.('trash.server_response', {
    requested: allowed.length,
    trashed: newlyTrashed.length,
    alreadyTrashed: alreadyTrashed.length,
    missing: missing.length,
    failed: failed.length,
    elapsedMs: Date.now() - startedAt,
  });

  if (failed.length > 0) deps.unhide(failed);
  // Trash lists only the requested top-level rows. Descendants still expand for
  // cache cleanup below, but never contribute to the Drive row's count.
  const countCorrection = optimisticTrashCount - newlyTrashed.length;
  if (countCorrection > 0) deps.changeTrashCount?.(-countCorrection);

  if (trashed.length > 0) {
    const subtree = deps.collectSubtreeIds ? deps.collectSubtreeIds(trashed) : trashed;
    deps.trace?.('trash.cache_remove_start', { count: subtree.length, elapsedMs: Date.now() - startedAt });
    await deps.removeFromFileProviderCache(subtree).catch(() => {});
    await deps.onTrashed?.(subtree);
    deps.trace?.('trash.cache_remove_complete', { count: subtree.length, elapsedMs: Date.now() - startedAt });
    await deps.signalFileProviderTrashChanged?.().catch(() => {});
  }
  if (missing.length > 0) await deps.onMissing?.(missing);
  if (trashed.length > 0 || missing.length > 0) deps.notifyTrashChanged?.();

  const isStraightSuccess = newlyTrashed.length === allowed.length
    && alreadyTrashed.length === 0
    && missing.length === 0
    && failed.length === 0;
  if (!isStraightSuccess) {
    deps.showToast({
      key: toastKey,
      type: failed.length > 0 ? 'error' : newlyTrashed.length > 0 ? 'success' : 'info',
      message: reconciledMessage(outcome, allowed.length === 1 ? deps.singleName : undefined),
      ...(trashed.length > 0 ? actions : {}),
    });
  }

  deps.trace?.('trash.background_complete', {
    requested: allowed.length,
    trashed: newlyTrashed.length,
    alreadyTrashed: alreadyTrashed.length,
    missing: missing.length,
    failed: failed.length,
    elapsedMs: Date.now() - startedAt,
  });
  return outcome;
}

async function undoTrash(ids: string[], deps: MoveToTrashDeps, startedAt: number): Promise<void> {
  if (ids.length === 0) return;
  const settled = await Promise.allSettled(ids.map((id) => deps.restoreFile(id)));
  const restored = ids.filter((_, index) => {
    const outcome = settled[index];
    return outcome.status === 'fulfilled' && outcome.value.complete;
  });
  const pending = ids.filter((_, index) => {
    const outcome = settled[index];
    return outcome.status === 'fulfilled' && !outcome.value.complete;
  });
  const stuck = ids.length - restored.length - pending.length;
  if (restored.length > 0) {
    deps.unhide(restored);
    deps.onRestored?.(restored);
    if (deps.restoreFileProviderCache) {
      await deps.restoreFileProviderCache(restored).catch(() => {});
    }
    deps.changeTrashCount?.(-restored.length);
  }
  if (restored.length > 0 || pending.length > 0) {
    await deps.signalFileProviderTrashChanged?.().catch(() => {});
    deps.refreshAfterRestore?.([...restored, ...pending]);
    deps.notifyTrashChanged?.();
  }
  deps.trace?.('trash.undo_complete', {
    restored: restored.length,
    pending: pending.length,
    failed: stuck,
    elapsedMs: Date.now() - startedAt,
  });
  if (stuck > 0) {
    deps.showToast({ type: 'error', message: `Couldn't restore ${items(stuck)}. ${stuck === 1 ? "It's" : "They're"} still in Trash.` });
  } else if (pending.length > 0) {
    const prefix = restored.length > 0 ? `${items(restored.length)} restored. ` : '';
    const pendingCopy = restored.length > 0
      ? `${items(pending.length)} ${pending.length === 1 ? 'is' : 'are'} still restoring in the background.`
      : `Restore started for ${items(pending.length)}. It is finishing in the background.`;
    deps.showToast({ type: 'info', message: `${prefix}${pendingCopy}` });
  } else {
    deps.showToast({ type: 'success', message: `${items(restored.length)} restored` });
  }
}
