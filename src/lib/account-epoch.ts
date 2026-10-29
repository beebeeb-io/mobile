/**
 * account-epoch — which signed-in account a piece of async work belongs to.
 *
 * Task 1959 round 2 (Codex P1 on mobile PR #181). Work that starts under one
 * account and finishes after a sign-out / sign-in must not hand its result to
 * the next account. The concrete case: account A signs out while
 * GET /files/index is pending, account B opens Photos before it settles, and
 * the file-index loader gave B A's rows; a forced backup reconcile then
 * compared B's local backup state against A's ids and re-queued B's uploads
 * as orphans.
 *
 * The epoch has two parts:
 *   - `generation`: moved synchronously at the very start of `setToken()` and
 *     `clearToken()` in api.ts (every sign-in and sign-out), and by
 *     `clearCachedFileIndex()`. A different generation is a different session.
 *   - `accountId`: the account the unlocked master key is bound to
 *     (`expected-user.ts`), or null while locked. Two epochs whose ids are
 *     both known and differ are different accounts even at the same
 *     generation. A null id (locked) is not a different account: locking the
 *     app must not cancel the signed-in account's own work.
 *
 * Callers capture `accountEpoch()` when work starts, re-check
 * `isCurrentAccountEpoch(captured)` after every await that precedes a write or
 * a hand-off, and throw `StaleAccountError` when it no longer holds.
 *
 * Deliberately dependency-free apart from `expected-user.ts` (itself
 * dependency-free): api.ts, file-index-cache.ts, sync-client.ts and the
 * loader all import it.
 */

import { getExpectedUserId } from './expected-user';

export interface AccountEpoch {
  generation: number;
  accountId: string | null;
}

let generation = 0;
const listeners = new Set<() => void>();

export function accountEpoch(): AccountEpoch {
  return { generation, accountId: getExpectedUserId() };
}

/**
 * A sign-in or sign-out boundary. Synchronous, and listeners run before it
 * returns, so in-memory state of the previous account is dropped before the
 * first await of the sign-out.
 */
export function advanceAccountEpoch(): void {
  generation += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener must never break sign-in / sign-out.
    }
  }
}

/** Called on every epoch advance. Returns an unsubscribe function. */
export function onAccountEpochAdvance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sameAccountEpoch(a: AccountEpoch, b: AccountEpoch): boolean {
  if (a.generation !== b.generation) return false;
  if (a.accountId !== null && b.accountId !== null && a.accountId !== b.accountId) return false;
  return true;
}

export function isCurrentAccountEpoch(captured: AccountEpoch): boolean {
  return sameAccountEpoch(captured, accountEpoch());
}

/**
 * Thrown (or rejected with) when work that started under one account settles
 * under another. Callers treat it as "this result no longer belongs to
 * anyone on screen": no error UI, no retry, no state change.
 */
export class StaleAccountError extends Error {
  constructor(what: string) {
    super(`${what}: the account changed while it ran; result discarded`);
    this.name = 'StaleAccountError';
  }
}

export function isStaleAccountError(err: unknown): boolean {
  return err instanceof Error && err.name === 'StaleAccountError';
}
