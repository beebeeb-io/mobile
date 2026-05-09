// Shared lock-state timestamp.
//
// Both the global AppState listener and screens that transiently switch the
// foreground (Face ID enable prompt, password step-up) can stamp this value
// so the next background→active transition does not surprise-lock the user
// who just authenticated. Module-level mutable state is intentional — this
// state must be reachable from any screen without prop drilling.

const GRACE_WINDOW_MS = 10_000

let lastUnlockedAt = 0

export function markUnlocked(): void {
  lastUnlockedAt = Date.now()
}

export function wasRecentlyUnlocked(now: number = Date.now()): boolean {
  return lastUnlockedAt > 0 && now - lastUnlockedAt < GRACE_WINDOW_MS
}
