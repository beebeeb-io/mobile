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
      /** Issue order, stamped by `issue()`; a write that lands later has a higher number. */
      seq: number;
    }
  | { kind: 'remove'; ids: string[]; epoch: AccountEpoch; seq: number }
  | { kind: 'protected-root'; id: string | null; epoch: AccountEpoch; seq: number };

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
  /** Queues a write the native side refused, minus whatever a NEWER write already landed for. */
  defer(write: CacheWrite): void;
  /**
   * A write is being issued (call BEFORE sending it): stamps its `seq`, and trims every
   * queued write it overlaps. Returns an undo that puts the trimmed data back, for when
   * the write then FAILS (throws): the queued data was not superseded after all.
   */
  issue(write: CacheWrite): () => void;
  /** The native side applied `write`: remember it, so an older write refused later is not queued over it. */
  landed(write: CacheWrite): void;
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
  let nextSeq = 0;
  let clearGeneration = 0;
  /** target -> seq of the newest write that LANDED for it ('id:x', 'parent:p', 'protected-root'). */
  const landedSeq = new Map<string, number>();
  const LANDED_CAP = 20_000;
  const appliedWrites = new WeakSet<CacheWrite>();

  function targetsOf(write: CacheWrite): string[] {
    if (write.kind === 'protected-root') return ['protected-root'];
    const targets = [...idsOf(write)].map((id) => `id:${id}`);
    for (const parent of prunedParentsOf(write)) targets.push(`parent:${parent}`);
    return targets;
  }
  const landedAfter = (target: string, seq: number): boolean => (landedSeq.get(target) ?? -1) > seq;

  function recordLanded(write: CacheWrite): void {
    const targets = targetsOf(write);
    // Any sync touches the parents of its entries: a complete listing of one of them that is older than this
    // write was made without these rows and must not prune them (see `issue`).
    if (write.kind === 'sync') for (const entry of write.entries) targets.push(`touched:${parentKey(entry.parent_id)}`);
    for (const target of targets) {
      if ((landedSeq.get(target) ?? -1) < write.seq) landedSeq.set(target, write.seq);
    }
    while (landedSeq.size > LANDED_CAP) {
      const oldest = landedSeq.keys().next().value;
      if (oldest === undefined) break;
      landedSeq.delete(oldest);
    }
  }

  /** Drops from `write` whatever a newer write already landed for. */
  function trimAgainstLanded(write: CacheWrite): void {
    if (write.kind === 'protected-root') return;
    if (write.kind === 'remove') {
      write.ids = write.ids.filter((id) => !landedAfter(`id:${id}`, write.seq));
      return;
    }
    // The parents this write prunes that a NEWER write has landed for (a listing, or any write under them): leave them out.
    const dropped = new Set<string>();
    if (write.prune) {
      for (const parent of prunedParentsOf(write)) {
        if (landedAfter(`parent:${parent}`, write.seq) || landedAfter(`touched:${parent}`, write.seq)) dropped.add(parent);
      }
    }
    write.entries = write.entries.filter(
      (e) =>
        !landedAfter(`id:${e.id}`, write.seq) &&
        !landedAfter(`parent:${parentKey(e.parent_id)}`, write.seq) &&
        !dropped.has(parentKey(e.parent_id)),
    );
    if (write.prune) {
      write.pruneParents = (write.pruneParents ?? []).filter((p) => !dropped.has(parentKey(p)) && !landedAfter(`parent:${parentKey(p)}`, write.seq));
      if (write.pruneParents.length === 0) write.pruneParents = write.entries.length > 0 ? null : [];
    }
  }

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
      // A newer write may have landed since this one was queued or restored.
      trimAgainstLanded(next);
      if (isEmpty(next)) {
        pending.shift();
        continue;
      }
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
      // `issue`/`clear` may have changed the queue while `run` awaited.
      const index = pending.indexOf(next);
      if (index >= 0) pending.splice(index, 1);
      appliedWrites.add(next);
      recordLanded(next);
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
      // A newer write for the same target may have landed while this one was refused (an app switch).
      trimAgainstLanded(write);
      if (isEmpty(write) || (write.kind === 'protected-root' && landedAfter('protected-root', write.seq))) return;
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
    landed(write) {
      recordLanded(write);
    },
    issue(newer) {
      nextSeq += 1;
      newer.seq = nextSeq;
      const generation = clearGeneration;
      // What this call changed, so a failed write can put it back: only the writes it really trimmed, and only the
      // fields it replaced (the old arrays are kept by reference; trimming assigns new ones, it never edits in place).
      type Before = { write: CacheWrite; index: number; entries?: FileProviderCacheEntry[]; pruneParents?: (string | null)[] | null; ids?: string[] };
      const changed: Before[] = [];
      const undo = () => {
        if (generation !== clearGeneration) return; // an account boundary emptied the queue: nothing to restore
        for (const before of [...changed].sort((x, y) => x.index - y.index)) {
          const { write } = before;
          if (appliedWrites.has(write)) continue; // already applied by a replay
          if (before.entries !== undefined && write.kind === 'sync') write.entries = before.entries;
          if (before.pruneParents !== undefined && write.kind === 'sync') write.pruneParents = before.pruneParents;
          if (before.ids !== undefined && write.kind === 'remove') write.ids = before.ids;
          // Writes that landed since this one was issued win over what is put back.
          trimAgainstLanded(write);
          if (isEmpty(write)) continue;
          if (!pending.includes(write)) pending.splice(Math.min(before.index, pending.length), 0, write);
        }
      };
      if (pending.length === 0) return undo;
      if (newer.kind === 'protected-root') {
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].kind === 'protected-root') {
            changed.push({ write: pending[i], index: i });
            pending.splice(i, 1);
          }
        }
        return undo;
      }
      const newerIds = idsOf(newer);
      const newerPruned = prunedParentsOf(newer);
      // The parents a newer sync touches at all: a queued COMPLETE listing of one of them was made without
      // the newer write's rows, and the native prune would delete them. It cannot be replayed with a keep-set
      // that lacks them (and replaying their stale entries would overwrite the fresh rows), so that parent
      // leaves the queued listing; the next full listing of it reconciles.
      const newerTouched = new Set<string>(newerPruned);
      if (newer.kind === 'sync') for (const entry of newer.entries) newerTouched.add(parentKey(entry.parent_id));
      for (let i = pending.length - 1; i >= 0; i--) {
        const queued = pending[i];
        const before: Before = { write: queued, index: i };
        let touchedQueued = false;
        if (queued.kind === 'remove') {
          const kept = queued.ids.filter((id) => !newerIds.has(id));
          if (kept.length !== queued.ids.length) {
            before.ids = queued.ids;
            queued.ids = kept;
            touchedQueued = true;
          }
        } else if (queued.kind === 'sync') {
          const droppedParents = new Set<string>();
          for (const parent of prunedParentsOf(queued)) if (newerTouched.has(parent)) droppedParents.add(parent);
          // A newer complete listing of a parent replaces that parent's older upserts too; a newer write of an id (or its removal) replaces the older write of that id.
          const keptEntries = queued.entries.filter(
            (e) => !newerIds.has(e.id) && !newerPruned.has(parentKey(e.parent_id)) && !droppedParents.has(parentKey(e.parent_id)),
          );
          let keptParents = queued.pruneParents;
          if (queued.prune) {
            keptParents = (queued.pruneParents ?? []).filter((p) => !droppedParents.has(parentKey(p)));
            if (keptParents.length === 0 && keptEntries.length > 0) keptParents = null;
          }
          if (keptEntries.length !== queued.entries.length || keptParents !== queued.pruneParents) {
            before.entries = queued.entries;
            before.pruneParents = queued.pruneParents;
            queued.entries = keptEntries;
            queued.pruneParents = keptParents;
            touchedQueued = true;
          }
        }
        if (touchedQueued) changed.push(before);
        if (isEmpty(queued)) pending.splice(i, 1);
      }
      return undo;
    },
    replay,
    clear() {
      pending.length = 0;
      landedSeq.clear();
      clearGeneration += 1;
    },
    get size() {
      return pending.length;
    },
    get queued() {
      return pending;
    },
  };
}
