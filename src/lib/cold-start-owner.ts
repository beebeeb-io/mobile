/**
 * Task 1667 round 14/15: which account a 403 `account_deleted` names when
 * the app has no signed-in user yet.
 *
 * `request()` calls the account-deleted handler INSIDE `getMe()`, before any
 * user is set, so `currentUserIdRef` is still null there. The handler then
 * names the stored key's owner (`readKeyOwner`), the same owner native trusts
 * for the signed-in account (`confirmMasterKeyHandle`). It is held in `owner`
 * only while that `getMe()` runs.
 *
 * Round 15 (review of mobile#182 at dd97f2ac, item 4): round 14 set it only in
 * `refreshAuth` (the sign-in path). A real cold launch runs `runStartup` ->
 * `retryGetMe` -> `getMe` and never read it, so a cold-launch 403 named no one
 * and native discarded every account's kept marks. Both paths now go through
 * `getMeNamingKeyOwner`; the cold launch through `retryStartupGetMe`.
 */

export interface OwnerRef {
  current: string | null;
}

/** Per `owner`: the call that set it last (an earlier call never clears a later one's value). */
const generations = new WeakMap<OwnerRef, number>();

/**
 * Runs `getMe` with `owner.current` set to the stored key's owner while no
 * user is signed in (`signedInUserId` null), and cleared when it settles.
 * A failed owner read leaves it null (the handler then names no one, fail
 * closed).
 */
export async function getMeNamingKeyOwner<T>(deps: {
  owner: OwnerRef;
  signedInUserId: string | null;
  readKeyOwner: () => Promise<string | null>;
  getMe: () => Promise<T>;
}): Promise<T> {
  const generation = (generations.get(deps.owner) ?? 0) + 1;
  generations.set(deps.owner, generation);
  const keyOwner = deps.signedInUserId ? null : await deps.readKeyOwner().catch(() => null);
  if (generations.get(deps.owner) === generation) deps.owner.current = keyOwner;
  try {
    return await deps.getMe();
  } finally {
    if (generations.get(deps.owner) === generation) deps.owner.current = null;
  }
}

/**
 * The cold launch's profile fetch (moved from App.tsx's `retryGetMe` in
 * round 15; the one change is that the timeout timer is cleared once the
 * race settles). Retries transient failures; a 401 is definitive
 * (the API client clears the invalid token) and is rethrown. Returns null
 * when every attempt failed transiently. `getMe` is the caller's
 * owner-naming call (`getMeNamingKeyOwner`).
 */
export async function retryStartupGetMe<T>(
  getMe: () => Promise<T>,
  isUnauthorized: (err: unknown) => boolean,
  options: { delaysMs?: number[]; timeoutMs?: number } = {},
): Promise<T | null> {
  const delays = options.delaysMs ?? [1000, 3000, 5000];
  const timeoutMs = options.timeoutMs ?? 10_000;
  for (const delay of delays) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        getMe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch (err) {
      if (isUnauthorized(err)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return null; // all retries failed with transient failures
}
