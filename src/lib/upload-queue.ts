/**
 * Task 1685 — bounded concurrency queue for fire-and-forget upload-side jobs.
 *
 * The bulk-crash prime suspect (task 1685, recon 2026-10-02): FilesScreen fired
 * `void Promise.allSettled([mediumThumb, largeThumb])` PER picked asset with no
 * cap — 64 images ⇒ up to 128 concurrent full-image decodes + blurhash encodes
 * ⇒ jetsam (the task 1669 crash class). Every fire-and-forget job that decodes
 * a full image now goes through this queue instead.
 *
 * Semantics:
 * - FIFO: jobs start in the order they were submitted, once a slot frees.
 * - The cap bounds CONCURRENTLY RUNNING jobs, pending ones are just closures.
 * - A rejecting job must never stall the queue: its promise rejects, the slot
 *   frees, the next job starts.
 * - `pendingCount()` exposes how many jobs are queued-but-not-started; callers
 *   (and tests) use it to prove nothing is silently lost.
 *
 * This is deliberately a separate primitive from thumbnail-cache.ts's
 * `enqueueThumbnailLoad`: that one is Android-only (it throws on iOS, where the
 * BeebeebThumbnails native service owns LOAD-side concurrency) and its cap is
 * about download/decrypt of server blobs — the UPLOAD-side generation queue has
 * different bounds and must also work on iOS.
 */

export const THUMBNAIL_UPLOAD_CONCURRENCY = 2;

export interface BoundedQueue {
  /** Submit a job. It runs when a concurrency slot frees (immediately if one is open). */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Jobs submitted but not yet started. */
  pendingCount(): number;
}

export function createBoundedQueue(concurrency: number): BoundedQueue {
  const cap = Math.max(1, Math.floor(concurrency));
  const pending: Array<() => void> = [];
  let active = 0;

  const drain = (): void => {
    while (active < cap && pending.length > 0) {
      const start = pending.shift();
      if (!start) break;
      active += 1;
      start();
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const begin = (): void => {
          // `active` was incremented by drain and MUST stay occupied while the
          // task runs — decrement only when the task settles, then refill.
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
        };
        pending.push(begin);
        drain();
      });
    },
    pendingCount(): number {
      return pending.length;
    },
  };
}

/**
 * The process-wide queue for upload-generated encrypted thumbnails (medium +
 * large variants, one job per variant). Two concurrent decodes: one asset's
 * pair runs together, the next asset's pair waits — worst case is 2 full-image
 * decodes + 1 blurhash encode in flight, regardless of batch size.
 */
export const thumbnailUploadQueue = createBoundedQueue(THUMBNAIL_UPLOAD_CONCURRENCY);