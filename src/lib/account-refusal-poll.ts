/** Foreground-only, serial retry loop for a refused backup account. */
export function startAccountRefusalPoll(
  tick: () => Promise<{ shouldStopPolling: boolean }>,
  initiallyActive: boolean,
  timers = { setTimeout, clearTimeout },
): { setActive(active: boolean): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = initiallyActive;
  let stopped = false;
  let running = false;
  let foregroundPending = false;
  let delay = 15_000;
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const run = async () => {
    if (stopped || !active || running) return;
    running = true;
    let done = false;
    try { done = (await tick()).shouldStopPolling; } catch { /* retry with backoff */ }
    running = false;
    if (done) stopped = true;
    if (stopped || !active) return;
    if (foregroundPending) {
      foregroundPending = false;
      void run();
      return;
    }
    timer = timers.setTimeout(() => { timer = null; void run(); }, delay);
    delay = Math.min(delay * 2, 60_000);
  };
  void run();
  return {
    setActive(next) {
      if (stopped || active === next) return;
      clear();
      active = next;
      foregroundPending = false;
      if (next) {
        delay = 15_000;
        if (running) foregroundPending = true;
        else void run();
      }
    },
    stop() { stopped = true; clear(); },
  };
}
