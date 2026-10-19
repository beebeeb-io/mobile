/**
 * Task 1667 round 4 (Codex P1 "Serialize overlapping database purge holds").
 *
 * Wraps an async action so that at most one run is in flight: a call made
 * while a run is in progress gets that run's promise instead of starting a
 * second one. Once the run settles (resolved or rejected) the next call
 * starts a new run.
 *
 * App.tsx wraps `signOut` in it: Sign out tapped twice (two confirmation
 * alerts, or two screens asking at once) must be ONE flush, ONE logout and
 * ONE storage purge, not two interleaved ones.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    // `run` starts on the next microtask, so `current` is assigned before the
    // `finally` below can ever read it (a synchronous throw included).
    const current: Promise<T> = Promise.resolve()
      .then(run)
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };
}
