/**
 * Task 1594 round 6 (reviewer follow-up — grep signup for a path that sets
 * the user / remounts the provider before `crypto.unlock` finishes).
 *
 * `SignupScreen.handleSignup` calls `crypto.unlock(recovery.phrase)` on the
 * transient 'signed-out'-keyed `CryptoProvider` instance BEFORE it calls
 * `refreshAuth()` itself — it needs the freshly-derived key stored
 * immediately (the recovery phrase is shown from this same flow, right
 * after). This is NOT how login works: `LoginScreen` never unlocks the
 * pre-remount instance at all (see its own comment, "Token is stored by
 * opaqueLoginFinish. App.tsx auth state will pick it up.") — the actual vault
 * unlock always happens on the POST-remount instance there, via the
 * fire-and-forget "post-login vault unlock" effect.
 *
 * `App.tsx`'s `handleNavigationStateChange` independently polls `hasToken()`
 * on every navigation state change and calls `refreshAuth()` itself the
 * moment a token exists and `user` is still null — a mechanism LOGIN's
 * ordering relies on (the comment above says so explicitly), but which, for
 * SIGNUP, can fire in the window between `opaqueRegistrationFinish` (which
 * sets the session token via `setSessionCredentials`, `api.ts`) and
 * `crypto.unlock(recovery.phrase)` resolving. `refreshAuth()` calls
 * `setUser(me)`, which flips `<CryptoProvider key={user?.user_id ??
 * 'signed-out'}>` (App.tsx) and remounts it — tearing down the OLD
 * ('signed-out'-keyed) instance while ITS OWN `storeMasterKey` write for the
 * BRAND NEW account can still be mid-flight. That abandoned write then finds
 * itself stale at its next `stillCurrent()` check and — unless a strictly
 * newer generation has already persisted (see `lastPersistedGeneration` in
 * `crypto-context.tsx`, which nothing has at this point: the new instance's
 * own post-login unlock cannot even start meaningfully racing it yet) —
 * purges the very key material signup just created, moments after creating
 * it.
 *
 * This flag brackets the exact dangerous window: `SignupScreen` sets it
 * before calling `opaqueRegistrationFinish` (before any token exists) and
 * clears it once `crypto.unlock()` has settled (success or failure), in a
 * `finally`. `handleNavigationStateChange` skips its own independent
 * `refreshAuth()` poll while this is set, so `SignupScreen`'s own explicit,
 * sequential `await refreshAuth()` (which runs only AFTER `crypto.unlock()`
 * has already resolved) remains the only thing that flips `user` during
 * signup — closing the window without changing login's existing, already-safe
 * ordering at all.
 */
let signupUnlockInProgress = false;

export function beginSignupUnlock(): void {
  signupUnlockInProgress = true;
}

export function endSignupUnlock(): void {
  signupUnlockInProgress = false;
}

export function isSignupUnlockInProgress(): boolean {
  return signupUnlockInProgress;
}

/**
 * The exact decision `App.tsx`'s `handleNavigationStateChange` makes, pulled
 * out as a pure predicate so the fix is unit-testable without rendering
 * `App.tsx` itself. `hasUser` is `!!user` at call time.
 */
export function shouldPollForAuthToken(hasUser: boolean): boolean {
  return !hasUser && !signupUnlockInProgress;
}
