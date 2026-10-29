// @ts-nocheck
/**
 * Task 1594 round 6 (reviewer follow-up) — App.tsx's `handleNavigationStateChange`
 * independently polls `hasToken()` on every navigation event and calls
 * `refreshAuth()` itself the moment a token exists and `user` is still null.
 * SignupScreen sets the session token (inside `opaqueRegistrationFinish`)
 * BEFORE its own `crypto.unlock(recovery.phrase)` resolves — so that poll,
 * left unguarded, can flip `user` (remounting `CryptoProvider`) while
 * signup's own `storeMasterKey` write for the BRAND NEW account is still
 * mid-flight, and the abandoned write can then purge the key material signup
 * just created (see `crypto-context.tsx`'s `lastPersistedGeneration` doc
 * comment for the mechanics of that purge).
 *
 * `shouldPollForAuthToken` is the exact decision `handleNavigationStateChange`
 * makes, pulled out as a pure predicate so this is testable without
 * rendering `App.tsx`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { beginSignupUnlock, endSignupUnlock, isSignupUnlockInProgress, shouldPollForAuthToken } from './signup-unlock-guard';

beforeEach(() => {
  // The module holds a single mutable flag — reset it between tests so one
  // test's `beginSignupUnlock()` can never leak into the next.
  endSignupUnlock();
});

describe('1594 round 6 — signup-unlock-guard', () => {
  test('no signup in flight, no user yet → polls (the normal login/startup path, unchanged)', () => {
    expect(isSignupUnlockInProgress()).toBe(false);
    expect(shouldPollForAuthToken(false)).toBe(true);
  });

  test('no signup in flight, user already set → never polls (nothing to do)', () => {
    expect(shouldPollForAuthToken(true)).toBe(false);
  });

  test('signup unlock in flight, no user yet → does NOT poll (the fix: the exact race window)', () => {
    beginSignupUnlock();
    expect(isSignupUnlockInProgress()).toBe(true);

    expect(shouldPollForAuthToken(false)).toBe(false);
  });

  test('ending the signup unlock re-enables the poll', () => {
    beginSignupUnlock();
    expect(shouldPollForAuthToken(false)).toBe(false);

    endSignupUnlock();

    expect(isSignupUnlockInProgress()).toBe(false);
    expect(shouldPollForAuthToken(false)).toBe(true);
  });

  test('a signup that already set `user` by the time the guard is checked still does not poll (defense in depth)', () => {
    beginSignupUnlock();
    expect(shouldPollForAuthToken(true)).toBe(false);
  });
});
