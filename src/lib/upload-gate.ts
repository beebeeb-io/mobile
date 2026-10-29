/**
 * Task 1685 review should-fixes — upload serialization gate + Resume offer rule.
 *
 * Should-fix 1: `onAddAction` dispatched pickAndUploadPhotos with no guard, so
 * a second pick during a running batch started a SECOND concurrent serial
 * loop — two writers on the single `upload` card state (either loop's
 * setUpload(null) could vanish the other's card mid-upload) and 2 concurrent
 * encrypted streams. `createUploadGate` serializes every upload entry point:
 * a task submitted while busy WAITS behind the running one (the AC's
 * "appendable mid-flight" — queued, not rejected), and `isBusy()` lets callers
 * say so honestly.
 *
 * Should-fix 2: `handlePendingUpload` offered "Resume" for a row that was
 * uploading right now → duplicate chunk PUTs / double finalize.
 * `canOfferResume` is the pure decision: a resume pointer must exist, nothing
 * may be in flight, and the row must not be the active upload itself.
 *
 * Deliberately NOT a restructure of upload-queue.ts (thumbnail jobs keep their
 * own 2-slot queue) — this is a separate, single-lane gate for whole upload
 * LOOPS.
 */

export interface UploadGate {
  /**
   * Submit an upload loop. It starts only after every previously submitted
   * task settled. The returned promise is the task's own — a rejection there
   * is the caller's to handle and never stalls the gate.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** True while any submitted task has not settled yet (running OR queued). */
  isBusy(): boolean;
}

export function createUploadGate(): UploadGate {
  let tail: Promise<void> = Promise.resolve();
  // Submitted-but-not-settled count. NOT a boolean: with a queued task behind
  // a running one, the first task settling must not flip busy off.
  let outstanding = 0;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      outstanding += 1;
      const result = tail.then(task);
      tail = result.then(
        () => { outstanding -= 1; },
        () => { outstanding -= 1; },
      );
      return result;
    },
    isBusy(): boolean {
      return outstanding > 0;
    },
  };
}

/**
 * Should-fix 2 — whether a pending-upload row may be offered "Resume".
 * `resumeInfo` is the per-file resume pointer (api.ts), `activeUploadFileId`
 * the in-flight upload's fileId (FilesScreen ref), `rowFileId` the tapped
 * row's id, `uploadInFlight` whether ANY upload loop is running.
 */
export function canOfferResume(
  resumeInfo: unknown,
  activeUploadFileId: string | null,
  rowFileId: string,
  uploadInFlight: boolean,
): boolean {
  if (!resumeInfo) return false;
  if (uploadInFlight) return false;
  return activeUploadFileId !== rowFileId;
}