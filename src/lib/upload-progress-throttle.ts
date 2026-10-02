/**
 * Task 1685 — upload progress throttle.
 *
 * FilesScreen's `setUpload` used to run on EVERY progress event — the native
 * engine reports byte-level progress polled every ~150 ms (api.ts), the JS
 * fallback once per chunk — re-rendering the 5,400-line screen and its
 * FlatList on every tick for every concurrent upload. That render churn is the
 * mid-upload jank/crash surface of task 1685.
 *
 * This throttle decides, per sample, whether the sample is worth surfacing to
 * React state:
 * - the FIRST sample is always allowed (immediate feedback, no blank card);
 * - a phase CHANGE (preparing → uploading → finalizing) is always allowed —
 *   stage transitions must never be swallowed or the card shows the wrong
 *   stage for up to one interval;
 * - everything else is allowed at most once per `minIntervalMs` (≈4 Hz at the
 *   250 ms default). The final percent is not lost: `finalizing` is a phase
 *   change, so the completing sample always surfaces.
 *
 * Pure and synchronous (no timers): the caller injects `now` in tests and gets
 * deterministic behaviour. The native progress pipeline itself is untouched.
 */

export const UPLOAD_PROGRESS_MIN_INTERVAL_MS = 250;

export interface UploadProgressLike {
  phase: string;
}

export interface ProgressThrottle {
  /** True when this sample should be surfaced to React state. */
  allow(progress: UploadProgressLike): boolean;
}

export function createProgressThrottle(
  minIntervalMs: number,
  now: () => number = Date.now,
): ProgressThrottle {
  let lastEmittedAt = -Infinity;
  let lastPhase: string | null = null;

  return {
    allow(progress: UploadProgressLike): boolean {
      const phaseChanged = lastPhase === null || progress.phase !== lastPhase;
      const elapsed = now() - lastEmittedAt;
      if (!phaseChanged && elapsed < minIntervalMs) return false;
      lastEmittedAt = now();
      lastPhase = progress.phase;
      return true;
    },
  };
}