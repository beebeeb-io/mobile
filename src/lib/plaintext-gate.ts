/**
 * Task 1593 round 3 (#141 Codex P1 x3) — the ONE gate every plaintext writer
 * passes through, and the purge that closes it.
 *
 * Round 2 made the sign-out purge sweep every registered plaintext location
 * once. Codex showed that a single sweep is not a guarantee: a decrypt that
 * is still running (a slow native job, a replacement queued behind an aborted
 * one, SharedViewScreen's download → decrypt → write) can write its plaintext
 * AFTER the sweep returned. A sweep only means something if nothing can write
 * behind it, so:
 *
 *  - Every writer of decrypted / pre-encryption plaintext (the registry in
 *    `caches-plaintext-registry.ts` + the JS writers of the native registry)
 *    holds a LEASE from this gate for the whole async span that ends in a
 *    write, and re-checks `lease.valid` right before (and after) writing.
 *  - `purge(sweep)` CLOSES the gate (no new lease; every held lease becomes
 *    invalid and its `signal` aborts), DRAINS the held leases (waits for each
 *    writer to settle, bounded by `drainTimeoutMs`), and only then runs the
 *    sweep. A writer that settles after the bound still finds its lease
 *    invalid and discards its own output (see `writePlaintext`).
 *  - The gate stays CLOSED after the purge until a new session is established
 *    (`open()`, called by the sign-in path) — a caller arriving in between is
 *    refused instead of queueing a fresh decrypt behind the purge.
 */

/** Hard upper bound on how long a purge waits for held leases to settle. */
export const PLAINTEXT_DRAIN_TIMEOUT_MS = 15_000;

export class PlaintextGateClosedError extends Error {
  constructor(label?: string) {
    super(label ? `Signed out — ${label} was discarded.` : 'Signed out — plaintext writes are closed.');
    // AbortError: every caller already treats a cancelled load as silent.
    this.name = 'AbortError';
  }
}

export function isPlaintextGateClosed(error: unknown): boolean {
  return error instanceof PlaintextGateClosedError;
}

export interface PlaintextLease {
  readonly label: string;
  /** Aborts the moment a purge closes the gate. */
  readonly signal: AbortSignal;
  /** False once a purge closed the gate after this lease was taken, or once released. */
  readonly valid: boolean;
  /** Throws `PlaintextGateClosedError` when the lease is no longer valid. */
  assertValid(): void;
  /** Idempotent. */
  release(): void;
}

export interface PlaintextGate {
  isOpen(): boolean;
  /** Throws `PlaintextGateClosedError` while the gate is closed. */
  acquire(label: string): PlaintextLease;
  /** Close → drain → sweep. The gate stays closed afterwards until `open()`. */
  purge<T>(sweep: () => Promise<T>): Promise<T>;
  /** A new session was established: accept writers again (after any running purge). */
  open(): void;
  /** Resolves when no purge is running. */
  idle(): Promise<void>;
  /** Leases currently held (diagnostics / tests). */
  held(): number;
}

export interface PlaintextGateOptions {
  drainTimeoutMs?: number;
}

export function createPlaintextGate(options: PlaintextGateOptions = {}): PlaintextGate {
  const drainTimeoutMs = options.drainTimeoutMs ?? PLAINTEXT_DRAIN_TIMEOUT_MS;
  let closed = false;
  let purging = 0;
  let reopenAfterPurge = false;
  let epochController = new AbortController();
  const holders = new Set<{ settle: () => void; done: Promise<void> }>();
  let idleWaiters: Array<() => void> = [];

  function acquire(label: string): PlaintextLease {
    if (closed) throw new PlaintextGateClosedError(label);
    const signal = epochController.signal;
    let released = false;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const holder = { settle, done };
    holders.add(holder);
    const lease: PlaintextLease = {
      label,
      signal,
      get valid() {
        return !released && !signal.aborted;
      },
      assertValid() {
        if (!lease.valid) throw new PlaintextGateClosedError(label);
      },
      release() {
        if (released) return;
        released = true;
        holders.delete(holder);
        holder.settle();
      },
    };
    return lease;
  }

  async function drain(): Promise<void> {
    const pending = Array.from(holders, (h) => h.done);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, drainTimeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async function purge<T>(sweep: () => Promise<T>): Promise<T> {
    purging += 1;
    closed = true;
    // Invalidate every lease held now; later leases cannot exist while closed.
    epochController.abort();
    epochController = new AbortController();
    try {
      await drain();
      return await sweep();
    } finally {
      purging -= 1;
      if (purging === 0) {
        if (reopenAfterPurge) {
          reopenAfterPurge = false;
          closed = false;
        }
        const waiters = idleWaiters;
        idleWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    }
  }

  return {
    isOpen: () => !closed,
    acquire,
    purge,
    open() {
      if (purging > 0) reopenAfterPurge = true;
      else closed = false;
    },
    idle() {
      if (purging === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
    held: () => holders.size,
  };
}

/** The app-wide gate. */
export const plaintextGate: PlaintextGate = createPlaintextGate();

/**
 * Run `fn` holding a lease; the lease is released however `fn` ends. Rejects
 * with `PlaintextGateClosedError` without running `fn` while the gate is closed.
 */
export async function withPlaintextLease<T>(
  label: string,
  fn: (lease: PlaintextLease) => Promise<T>,
  gate: PlaintextGate = plaintextGate,
): Promise<T> {
  const lease = gate.acquire(label);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}

export interface DiscardFs {
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

/**
 * Perform ONE plaintext write under `lease`: refuse before it when the gate
 * has closed, and — when a purge closed the gate while the write was running —
 * delete what it wrote and throw. `uri` is the path (file or directory) the
 * write produces.
 */
export async function writePlaintext<T>(
  lease: PlaintextLease,
  uri: string,
  fs: DiscardFs,
  write: () => Promise<T>,
): Promise<T> {
  lease.assertValid();
  const result = await write();
  if (!lease.valid) {
    await fs.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw new PlaintextGateClosedError(lease.label);
  }
  return result;
}

/**
 * One self-contained plaintext write under its own lease — for writers whose
 * plaintext is already in hand (the async span that matters is the write).
 */
export function gatedPlaintextWrite<T>(
  label: string,
  uri: string,
  fs: DiscardFs,
  write: () => Promise<T>,
  gate: PlaintextGate = plaintextGate,
): Promise<T> {
  return withPlaintextLease(label, (lease) => writePlaintext(lease, uri, fs, write), gate);
}
