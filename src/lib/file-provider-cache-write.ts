/**
 * LD-0002 round 2 (TestFlight 258, `RUNNINGBOARD 0xdead10cc`): what the JS side
 * does with a refused write to the File Provider cache.
 *
 * iOS kills an app that holds a lock on a file in an app-group container when it
 * suspends it. The cache database is such a file, so once the app's background
 * time has ended the native side opens no connection and answers
 * `{status: 'not_now'}`: NOTHING was written. That is never a crash and never a
 * silent drop: the write is queued here as plain DATA and run again, in order,
 * when the app is foreground.
 *
 * A queued write must never land over a NEWER one. `supersede(newer)` is called
 * when a newer write is ISSUED (the native queue is FIFO, so a write issued later
 * lands later) and trims every queued write that overlaps its targets: the same
 * ids, or the parents whose complete listing it carries. A queued write is read
 * when it runs, so a trim also reaches a replay that has started but not yet
 * called native.
 *
 * No `react-native` import: this file is driven in plain `bun test`, and the
 * foreground signal is injected (`file-provider-mount.ts` passes `AppState`).
 */
import type { FileProviderCacheEntry } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';
import type { AccountEpoch } from './account-epoch';

/** What a queued write holds: its arguments and the account it was made for. Nothing else (no listing, no name map). */
export type CacheWrite =
  | {
      kind: 'sync';
      entries: FileProviderCacheEntry[];
      prune: boolean;
      pruneParents: (string | null)[] | null;
      trashChanged: boolean;
      epoch: AccountEpoch;
    }
  | { kind: 'remove'; ids: string[]; epoch: AccountEpoch }
  | { kind: 'protected-root'; id: string | null; epoch: AccountEpoch };

const ROOT_PARENT = '\u0000root';
const parentKey = (parent: string | null | undefined): string => (parent === null || parent === undefined ? ROOT_PARENT : parent);

/** The ids a write puts in, or takes out. */
function idsOf(write: CacheWrite): Set<string> {
  if (write.kind === 'sync') return new Set(write.entries.map((e) => e.id));
  if (write.kind === 'remove') return new Set(write.ids);
  return new Set();
}

/** The parents whose COMPLETE child set a write carries: the native side prunes every one of them. */
function prunedParentsOf(write: CacheWrite): Set<string> {
  if (write.kind !== 'sync' || !write.prune) return new Set();
  const parents = new Set<string>((write.pruneParents ?? []).map(parentKey));
  for (const entry of write.entries) parents.add(parentKey(entry.parent_id));
  return parents;
}

function isEmpty(write: CacheWrite): boolean {
  if (write.kind === 'sync') return write.entries.length === 0 && !(write.prune && (write.pruneParents?.length ?? 0) > 0);
  if (write.kind === 'remove') return write.ids.length === 0;
  return false;
}

export interface DeferredCacheWrites {
  defer(write: CacheWrite): void;
  /** A newer write is being issued: trim every queued write it overlaps (call BEFORE issuing it). */
  supersede(newer: CacheWrite): void;
  /** Runs the queue in order; stops at the first write the native side refuses again. */
  replay(): Promise<void>;
  /** An account boundary (sign-in or sign-out): nothing queued under the old account may run. */
  clear(): void;
  readonly size: number;
  /** The queued writes, in order (tests, diagnostics). */
  readonly queued: ReadonlyArray<CacheWrite>;
}

export const MAX_DEFERRED_CACHE_WRITES = 200;
export const REPLAY_BASE_DELAY_MS = 1000;
export const REPLAY_MAX_DELAY_MS = 30_000;
export const REPLAY_MAX_RETRIES = 8;

export function createDeferredCacheWrites(deps: {
  /** Runs one write: true = applied (or no longer wanted); false = refused again, keep it. A throw drops it. Reads the write's fields when it calls native, so a trim in between is honoured. */
  run: (write: CacheWrite) => Promise<boolean>;
  /** Calls `onForeground` every time the app becomes foreground. */
  subscribeToForeground: (onForeground: () => void) => void;
  /** Called with the write that fell off the front of a full queue. */
  onOverflow?: (dropped: CacheWrite) => void;
  onReplayError?: (error: unknown) => void;
  /** True while the app is already foreground. A write refused then (it was in flight across an app switch, or the gate was not yet claimed) gets no 'active' event: it is retried with backoff instead. */
  isForeground?: () => boolean;
  scheduleReplay?: (run: () => void, delayMs: number) => void;
  max?: number;
}): DeferredCacheWrites {
  const pending: CacheWrite[] = [];
  const max = deps.max ?? MAX_DEFERRED_CACHE_WRITES;
  const schedule = deps.scheduleReplay ?? ((run, delayMs) => void setTimeout(run, delayMs));
  let subscribed = false;
  let replaying: Promise<void> | null = null;
  let retries = 0;
  let retryScheduled = false;

  function scheduleRetry(): void {
    if (pending.length === 0 || retryScheduled || retries >= REPLAY_MAX_RETRIES || !deps.isForeground?.()) return;
    retryScheduled = true;
    const delay = Math.min(REPLAY_BASE_DELAY_MS * 2 ** retries, REPLAY_MAX_DELAY_MS);
    retries += 1;
    schedule(() => {
      retryScheduled = false;
      void replay();
    }, delay);
  }

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const next = pending[0];
      let applied: boolean;
      try {
        applied = await deps.run(next);
      } catch (error) {
        deps.onReplayError?.(error);
        applied = true;
      }
      if (!applied) {
        scheduleRetry();
        return;
      }
      // `supersede`/`clear` may have changed the queue while `run` awaited.
      const index = pending.indexOf(next);
      if (index >= 0) pending.splice(index, 1);
    }
    retries = 0;
  }

  function replay(): Promise<void> {
    // One replay at a time; a foreground that arrives during one waits for it, then re-checks the queue.
    if (replaying) return replaying.then(() => (pending.length > 0 ? replay() : undefined));
    replaying = drain().finally(() => {
      replaying = null;
    });
    return replaying;
  }

  return {
    defer(write) {
      if (isEmpty(write)) return;
      pending.push(write);
      while (pending.length > max) {
        const dropped = pending.shift();
        if (dropped) deps.onOverflow?.(dropped);
      }
      if (!subscribed) {
        subscribed = true;
        deps.subscribeToForeground(() => {
          retries = 0;
          void replay();
        });
      }
      scheduleRetry();
    },
    supersede(newer) {
      if (pending.length === 0) return;
      if (newer.kind === 'protected-root') {
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].kind === 'protected-root') pending.splice(i, 1);
        return;
      }
      const newerIds = idsOf(newer);
      const newerParents = prunedParentsOf(newer);
      for (let i = pending.length - 1; i >= 0; i--) {
        const queued = pending[i];
        if (queued.kind === 'remove') {
          queued.ids = queued.ids.filter((id) => !newerIds.has(id));
        } else if (queued.kind === 'sync') {
          // A newer complete listing of a parent replaces that parent's older one; a newer write of an id (or its removal) replaces the older write of that id.
          queued.entries = queued.entries.filter((e) => !newerIds.has(e.id) && !newerParents.has(parentKey(e.parent_id)));
          if (queued.prune) {
            queued.pruneParents = (queued.pruneParents ?? []).filter((p) => !newerParents.has(parentKey(p)));
            if (queued.pruneParents.length === 0 && queued.entries.length > 0) {
              // What remains is a set of upserts whose parents were not superseded: the native side prunes each parent that appears in `entries`.
              queued.pruneParents = null;
            }
          }
        }
        if (isEmpty(queued)) pending.splice(i, 1);
      }
    },
    replay,
    clear() {
      pending.length = 0;
    },
    get size() {
      return pending.length;
    },
    get queued() {
      return pending;
    },
  };
}
