/**
 * Serial work queue for compare-view sample encodes.
 *
 * - At most one `run` at a time (native encodes are heavy).
 * - `prioritize(key)` puts a key at the front of the waiting line; a key that
 *   is already running is not queued again, and its result is delivered when
 *   it lands, whatever happened to the caller's UI in the meantime.
 * - A key is run at most once per queue lifetime (failures count as done).
 * - `clear()` drops waiting keys only; the running one still reports.
 */
export interface EncodeQueue {
  /** Add to the back of the line (no-op when waiting, running or done). */
  enqueue(key: string): void;
  /** Add or move to the front of the line (no-op when running or done). */
  prioritize(key: string): void;
  /** Drop every waiting key (a running one still finishes and reports). */
  clear(): void;
  /** Forget which keys are done, e.g. after the cache they refer to is gone. */
  forgetDone(): void;
  readonly running: string | null;
  readonly waiting: readonly string[];
}

export function createEncodeQueue<T>(
  run: (key: string) => Promise<T>,
  onResult: (key: string, outcome: { ok: true; value: T } | { ok: false }) => void,
): EncodeQueue {
  let waiting: string[] = [];
  let running: string | null = null;
  const done = new Set<string>();

  const pump = () => {
    if (running !== null) return;
    const key = waiting.shift();
    if (key === undefined) return;
    running = key;
    run(key).then(
      (value) => finish(key, { ok: true, value }),
      () => finish(key, { ok: false }),
    );
  };

  const finish = (key: string, outcome: { ok: true; value: T } | { ok: false }) => {
    running = null;
    done.add(key);
    try {
      onResult(key, outcome);
    } finally {
      pump();
    }
  };

  const known = (key: string) => done.has(key) || running === key;

  return {
    enqueue(key) {
      if (known(key) || waiting.includes(key)) return;
      waiting.push(key);
      pump();
    },
    prioritize(key) {
      if (known(key)) return;
      waiting = [key, ...waiting.filter((k) => k !== key)];
      pump();
    },
    clear() {
      waiting = [];
    },
    forgetDone() {
      done.clear();
    },
    get running() {
      return running;
    },
    get waiting() {
      return waiting;
    },
  };
}
