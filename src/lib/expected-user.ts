/**
 * Task 1594 fix 4 — the id of the account the UNLOCKED master key is bound to,
 * sent as `X-Beebeeb-Expected-User` on authenticated mutations (server task
 * 1554, `auth.rs` `check_expected_user`: a mismatch against the session's user
 * is refused with 409 `account_mismatch` before the handler runs).
 *
 * Mirrors web's `setExpectedUserProvider` / `expectedUserHeaders`
 * (`packages/shared/src/api/config.ts`): mutating requests only, absent when no
 * key is unlocked (an absent header is accepted by every server version).
 *
 * Deliberately dependency-free: `api.ts` reads it on every request and
 * `crypto-context.tsx` writes it on unlock/lock, so it must not pull either
 * module's tree into the other.
 */

let expectedUserId: string | null = null;

/** Set by CryptoProvider when a key bound to `userId` is unlocked; null on lock. */
export function setExpectedUserId(userId: string | null): void {
  expectedUserId = userId && userId.length > 0 ? userId : null;
}

export function getExpectedUserId(): string | null {
  return expectedUserId;
}

/** Header to merge into an authenticated MUTATING request (never a GET/HEAD). */
export function expectedUserHeaders(): Record<string, string> {
  return expectedUserId ? { 'X-Beebeeb-Expected-User': expectedUserId } : {};
}

export function isMutatingMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}
