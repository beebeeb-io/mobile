/**
 * LD-0002 round 2 (TestFlight 258, `RUNNINGBOARD 0xdead10cc`): what the JS side
 * does with a refused write to the File Provider cache.
 *
 * iOS kills an app that holds a lock on a file in an app-group container when it
 * suspends it. The cache database is such a file, so once the app's background
 * time has ended the native side opens no connection and answers
 * `{status: 'not_now'}`: NOTHING was written. That is never a crash and never a
 * silent drop: the write is queued here and run again, in order, when the app is
 * foreground. (Before, the call could be inside `sqlite3_step` when iOS suspended
 * the app.)
 *
 * No `react-native` import: this file is driven in plain `bun test`, and the
 * foreground signal is injected (`file-provider-mount.ts` passes `AppState`).
 */

/** The rows written/removed, or `'not_now'` when the native side refused. Accepts the answer of an older native build (a bare number or boolean) too. */
export function cacheWriteCount(raw: unknown): number | 'not_now' {
  if (raw && typeof raw === 'object') {
    const answer = raw as { status?: unknown; count?: unknown };
    if (answer.status === 'not_now') return 'not_now';
    return typeof answer.count === 'number' ? answer.count : 0;
  }
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  return 0;
}

export interface DeferredCacheWrite {
  /** A write with the same key replaces the one queued before it (the later push is the newer truth). */
  key?: string;
  /** Runs the write again. true = applied, or no longer wanted; false = refused again, keep it. A throw drops it (a sign-out closed the plaintext gate, or the native call failed outright). */
  run: () => Promise<boolean>;
}

export interface DeferredCacheWrites {
  defer(write: DeferredCacheWrite): void;
  /** Runs the queue in order; stops at the first write the native side refuses again. */
  replay(): Promise<void>;
  readonly size: number;
}

export const MAX_DEFERRED_CACHE_WRITES = 200;

export function createDeferredCacheWrites(deps: {
  /** Calls `onForeground` every time the app becomes foreground. */
  subscribeToForeground: (onForeground: () => void) => void;
  /** Called with the write that fell off the front of a full queue. */
  onOverflow?: (dropped: DeferredCacheWrite) => void;
  onReplayError?: (error: unknown) => void;
  max?: number;
}): DeferredCacheWrites {
  const pending: DeferredCacheWrite[] = [];
  const max = deps.max ?? MAX_DEFERRED_CACHE_WRITES;
  let subscribed = false;
  let replaying: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const next = pending[0];
      let applied: boolean;
      try {
        applied = await next.run();
      } catch (error) {
        deps.onReplayError?.(error);
        applied = true;
      }
      if (!applied) return;
      // `defer` may have replaced or reordered the queue while `run` awaited.
      const index = pending.indexOf(next);
      if (index >= 0) pending.splice(index, 1);
    }
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
      if (write.key !== undefined) {
        const index = pending.findIndex((queued) => queued.key === write.key);
        if (index >= 0) pending.splice(index, 1);
      }
      pending.push(write);
      while (pending.length > max) {
        const dropped = pending.shift();
        if (dropped) deps.onOverflow?.(dropped);
      }
      if (!subscribed) {
        subscribed = true;
        deps.subscribeToForeground(() => {
          void replay();
        });
      }
    },
    replay,
    get size() {
      return pending.length;
    },
  };
}
