/**
 * Share ONE in-flight async job between every caller asking for the same key,
 * with per-caller cancellation.
 *
 * Task 1593 (#141 review P2): `decryptToTempFile` writes the plaintext to a
 * fixed path (`preview/<fileId>.<ext>`). Two callers for the same file at
 * once — the preview and "Prove it", or a swipe back and forth — each started
 * their own download + decrypt into that SAME path. Worse, the second caller's
 * cache check could see the first caller's half-written file (non-empty) and
 * return it as a finished cache hit. Now the second caller joins the first
 * job instead.
 *
 * Cancellation is per caller: a caller whose `signal` aborts is rejected with
 * an `AbortError` at once, but the shared job is only aborted when EVERY
 * caller that joined it has aborted — closing "Prove it" must not kill the
 * preview's decrypt of the same file. A caller arriving after the job was
 * aborted (but before it finished cleaning up) waits for that job to settle
 * and then starts a fresh one, so the doomed job's cleanup (deleting its
 * partial output) can never delete the fresh job's output.
 *
 * Task 1593 round 3 (#141 Codex P1): with a `gate`, every job holds a
 * plaintext-writer lease for its whole life. A purge closing the gate aborts
 * every job, and — the part `abortAll()` alone could not guarantee — `run()`
 * then REFUSES new work (rejects with `PlaintextGateClosedError`) instead of
 * queueing a replacement decrypt behind the aborted one, until the gate
 * reopens for a new session.
 */
import type { PlaintextGate, PlaintextLease } from './plaintext-gate';

export type JobStart<T> = (signal: AbortSignal) => Promise<T>;

interface Entry<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

export interface SharedResult<T> {
  value: T;
  /** True when this caller joined a job another caller had already started. */
  joined: boolean;
}

function abortError(): Error {
  const error = new Error('Preview load cancelled.');
  error.name = 'AbortError';
  return error;
}

export interface InFlightShareOptions {
  /** Plaintext-writer gate (task 1593 round 3); each job holds one lease. */
  gate?: PlaintextGate;
  /** Lease label, for the refusal message. */
  label?: string;
}

export function createInFlightShare<T>(options: InFlightShareOptions = {}) {
  const inFlight = new Map<string, Entry<T>>();
  const { gate, label = 'decrypt' } = options;

  function launch(key: string, start: JobStart<T>, after?: Promise<unknown>): Entry<T> {
    // Throws while a purge has the gate closed — nothing is queued.
    const lease: PlaintextLease | undefined = gate?.acquire(label);
    const controller = new AbortController();
    if (lease) {
      if (lease.signal.aborted) controller.abort();
      else lease.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const entry: Entry<T> = {
      controller,
      waiters: 0,
      settled: false,
      promise: undefined as unknown as Promise<T>,
    };
    const run = after
      ? after.then(() => undefined, () => undefined).then(() => {
          if (controller.signal.aborted) throw abortError();
          return start(controller.signal);
        })
      : start(controller.signal);
    entry.promise = run.finally(() => {
      entry.settled = true;
      lease?.release();
      if (inFlight.get(key) === entry) inFlight.delete(key);
    });
    // The shared promise must never surface as an unhandled rejection when
    // every caller has already walked away from it.
    entry.promise.catch(() => {});
    inFlight.set(key, entry);
    return entry;
  }

  function run(key: string, start: JobStart<T>, signal?: AbortSignal): Promise<SharedResult<T>> {
    if (signal?.aborted) return Promise.reject(abortError());
    let entry = inFlight.get(key);
    let joined = false;
    if (entry && !entry.controller.signal.aborted) {
      joined = true;
    } else {
      // No job, or a job every caller abandoned that is still cleaning up:
      // start a fresh one, sequenced after the doomed one.
      try {
        entry = launch(key, start, entry?.promise);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const shared = entry;
    shared.waiters += 1;

    return new Promise<SharedResult<T>>((resolve, reject) => {
      let done = false;
      const release = () => {
        signal?.removeEventListener('abort', onAbort);
        shared.waiters -= 1;
        if (shared.waiters === 0 && !shared.settled) shared.controller.abort();
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        release();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort);
      shared.promise.then(
        (value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          shared.waiters -= 1;
          resolve({ value, joined });
        },
        (error) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          shared.waiters -= 1;
          reject(error);
        },
      );
    });
  }

  /**
   * Abort every job in flight (sign-out: nothing may finish writing a
   * plaintext file after the purge) and resolve once they have all settled.
   * Callers waiting on them are rejected with whatever the job rejects with.
   */
  function abortAll(): Promise<void> {
    const entries = Array.from(inFlight.values());
    for (const entry of entries) entry.controller.abort();
    return Promise.allSettled(entries.map((entry) => entry.promise)).then(() => undefined);
  }

  return {
    run,
    abortAll,
    /** Test/diagnostic helper: how many keys have a job in flight. */
    size: () => inFlight.size,
  };
}
