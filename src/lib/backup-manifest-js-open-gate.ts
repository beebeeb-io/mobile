/**
 * Task 1667 round 10 (review of mobile#182 at 060bfeb0, findings 5 + 7).
 *
 * The camera-roll backup manifest (`Documents/SQLite/beebeeb-backup.db`) is
 * owned by the native engine; `BackupDatabase.ts` opens it too, through
 * expo-sqlite, which bundles its OWN copy of SQLite. Two rules follow, and
 * this gate is how JS keeps them:
 *
 * 1. JS never opens the file while a native sign-out reset is still pending.
 *    When a sign-out's reset and its recovery both failed
 *    (`finishBackupManifestPurge` -> `ok: 0`), the file still holds the
 *    outgoing account's rows. Before round 10 JS reopened lazily and served
 *    them to the next account (its reconcile then re-queued them as orphans).
 *    The native gate applies the pending reset first, on its own connection,
 *    while JS holds none, and admits JS only when nothing is pending.
 * 2. Native never closes or checkpoints a connection while JS may hold the
 *    file outside the purge hold. The gate is how native learns that JS holds
 *    the file (admitted) or holds nothing (`priorHandlesClosed`).
 *
 * Dependency-free on purpose (like storage-purge-participants.ts): the native
 * wrapper cannot be imported in bun tests, so the gate is registered by
 * `account-cleanup.ts` (which App.tsx imports at the top) and looked up here.
 * With NO gate registered, `BackupDatabase` refuses to open: fail closed.
 */

export interface BackupManifestJsOpenVerdict {
  /** 1 = JS may open the file now. */
  ok: number;
  /** The native reason when not (`pending_reset_deferred`, `purge_in_flight`, ...). */
  reason: string | null;
}

export type BackupManifestJsOpenGate = (priorHandlesClosed: boolean) => Promise<BackupManifestJsOpenVerdict>;

let gate: BackupManifestJsOpenGate | null = null;

/** Registers the native gate (account-cleanup.ts). A non-function clears it. */
export function registerBackupManifestJsOpenGate(fn: BackupManifestJsOpenGate | null | undefined): void {
  gate = typeof fn === 'function' ? fn : null;
}

export function backupManifestJsOpenGate(): BackupManifestJsOpenGate | null {
  return gate;
}

/** Thrown by `BackupDatabase` when the gate did not admit an open. Retryable. */
export class BackupManifestNotReadyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`backup manifest not ready for JS (${reason})`);
    this.name = 'BackupManifestNotReadyError';
    this.reason = reason;
  }
}

/** The native reason that means: a pending reset waits for JS to close every handle. */
export const PENDING_RESET_DEFERRED = 'pending_reset_deferred';
