/**
 * Task 1667 — JS owners of an open handle on a file the native storage purge
 * (`purgePlaintextStorage`) touches.
 *
 * The camera-roll backup manifest (`Documents/SQLite/beebeeb-backup.db`) is
 * open in two places: the native engine and `BackupDatabase.ts`'s expo-sqlite
 * connection. Before 1667 the sign-out purge unlinked it under both; the
 * process kept reading "everything uploaded" from the deleted inode until the
 * next cold launch, which then started from an empty manifest and uploaded
 * every photo again (`_qa-evidence/1962/sim-dup/00-summary.txt`).
 *
 * A participant closes its handle and blocks new opens until the purge is
 * done (`suspend`), and gets a `resume` callback afterwards; the next use
 * reopens lazily. Only a module that has actually loaded registers, so a
 * module that never opened its handle costs nothing here.
 *
 * Dependency-free on purpose: account-cleanup.ts imports it, and every test
 * that loads account-cleanup must not have to mock expo-sqlite for it.
 */

export type StoragePurgeParticipant = () => Promise<() => void>;

const participants = new Set<StoragePurgeParticipant>();

/** Returns an unregister function. */
export function registerStoragePurgeParticipant(suspend: StoragePurgeParticipant): () => void {
  participants.add(suspend);
  return () => {
    participants.delete(suspend);
  };
}

/**
 * close every registered handle -> run `purge` -> let them reopen lazily.
 * A participant that fails to suspend does not stop the purge (sign-out must
 * never be blocked); `resume` always runs, even when `purge` throws.
 */
export async function withStoragePurgeParticipantsSuspended<T>(purge: () => Promise<T>): Promise<T> {
  const resumes: Array<() => void> = [];
  for (const suspend of [...participants]) {
    try {
      resumes.push(await suspend());
    } catch {
      // Best-effort: the native side still empties the manifest in place.
    }
  }
  try {
    return await purge();
  } finally {
    for (const resume of resumes) {
      try {
        resume();
      } catch {
        // never break sign-out
      }
    }
  }
}

/** Test seam. */
export function storagePurgeParticipantCount(): number {
  return participants.size;
}
