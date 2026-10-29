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
 * A participant holds its own work until the purge is done (`suspend`: no
 * new call starts, every call already running has finished) and gets a
 * `resume` callback afterwards. It must NOT close a handle the native side
 * keeps (expo-sqlite bundles its own SQLite; its close deletes the WAL under
 * the engine's connection — see BackupDatabase.suspendForStoragePurge).
 * `closeHandle` exists for the one case the native side asks for it: its
 * in-place reset failed and it has closed its own handle (round 2, Codex P1
 * "Reopen the JS database after a reset failure"). Only a module that has
 * actually loaded registers.
 *
 * Dependency-free on purpose: account-cleanup.ts imports it, and every test
 * that loads account-cleanup must not have to mock expo-sqlite for it.
 */

export interface StoragePurgeHold {
  /** Lift the hold; work queued meanwhile runs (on a reopened handle if closed). */
  resume: () => void;
  /** Close the handle for good. Resolves true when it is closed (or none was open). */
  closeHandle: () => Promise<boolean>;
}

export type StoragePurgeParticipant = () => Promise<StoragePurgeHold>;

const participants = new Set<StoragePurgeParticipant>();

/** Returns an unregister function. */
export function registerStoragePurgeParticipant(suspend: StoragePurgeParticipant): () => void {
  participants.add(suspend);
  return () => {
    participants.delete(suspend);
  };
}

export interface StoragePurgeControl {
  /**
   * Close every participant's handle (still under the hold). Resolves true
   * only when every participant reported its handle closed: a participant
   * that could not even be held, or whose close failed, makes it false, and
   * the caller must then not unlink anything that handle may point at.
   */
  closeHandles: () => Promise<boolean>;
}

// Round 4 (Codex P1 "Serialize overlapping database purge holds"): the tail
// of the purge queue. Purges run one at a time: two native resets of the same
// manifest at once (Sign out tapped twice; a sign-out racing the
// signed-out-surface purge) would each see the other's half-done state.
let purgeQueue: Promise<unknown> = Promise.resolve();

/**
 * hold every participant -> run `purge` -> resume them.
 * A participant that fails to suspend does not stop the purge (sign-out must
 * never be blocked); `resume` always runs, even when `purge` throws.
 *
 * Round 4: serialized. A call made while another purge runs starts after it
 * has finished (and resumed its participants); a failed purge does not stop
 * the next one.
 */
export function withStoragePurgeParticipantsSuspended<T>(
  purge: (control: StoragePurgeControl) => Promise<T>,
): Promise<T> {
  const run = purgeQueue.then(() => holdAndPurge(purge));
  purgeQueue = run.catch(() => undefined);
  return run;
}

async function holdAndPurge<T>(
  purge: (control: StoragePurgeControl) => Promise<T>,
): Promise<T> {
  const holds: StoragePurgeHold[] = [];
  let unheld = 0;
  for (const suspend of [...participants]) {
    try {
      holds.push(await suspend());
    } catch {
      // Best-effort: the native side still empties the manifest in place.
      unheld += 1;
    }
  }
  const control: StoragePurgeControl = {
    closeHandles: async () => {
      let allClosed = unheld === 0;
      for (const hold of holds) {
        try {
          if (!(await hold.closeHandle())) allClosed = false;
        } catch {
          allClosed = false;
        }
      }
      return allClosed;
    },
  };
  try {
    return await purge(control);
  } finally {
    for (const hold of holds) {
      try {
        hold.resume();
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
