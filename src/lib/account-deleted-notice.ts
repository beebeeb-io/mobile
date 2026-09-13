/**
 * Task 1405 — in-memory handoff for the account_deleted notice.
 *
 * When an already-signed-in device's account gets deleted elsewhere (web,
 * another device, an admin action), `api.ts`'s central `request()` fires the
 * account-deleted handler registered by App.tsx: it clears the token and
 * signs the user out locally. That leaves LoginScreen about to mount with no
 * way to know WHY — this module is the handoff. App.tsx stashes the notice
 * the instant it signs the user out; LoginScreen consumes (reads + clears)
 * it on mount.
 *
 * A plain module-level variable is enough here — unlike the web client
 * (task 1404, which uses sessionStorage because a full page navigation can
 * intervene), React Native never reloads the JS process between sign-out and
 * the next screen mount, so there's no persistence boundary to cross.
 */

export interface AccountDeletedNotice {
  deletedAt: string;
  shredAfter: string;
}

let pending: AccountDeletedNotice | null = null;

/** Called by App.tsx's account-deleted handler right before signing out. */
export function stashAccountDeletedNotice(notice: AccountDeletedNotice): void {
  pending = notice;
}

/** Called by LoginScreen on mount. Reads and clears — shown at most once. */
export function consumeAccountDeletedNotice(): AccountDeletedNotice | null {
  const notice = pending;
  pending = null;
  return notice;
}
