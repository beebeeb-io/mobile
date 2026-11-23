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

/** A 429 `ApiError`, matched structurally so this module stays native-free. */
function as429(err: unknown): { retryAfterSeconds?: number } | null {
  if (err instanceof Error && err.name === 'ApiError' && (err as { status?: unknown }).status === 429) {
    const secs = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return { retryAfterSeconds: typeof secs === 'number' && Number.isFinite(secs) && secs >= 0 ? secs : undefined };
  }
  return null;
}

/** Longest Retry-After the cold launch waits out; above it the 429 is thrown to the caller. */
export const STARTUP_MAX_RETRY_AFTER_SECONDS = 60;
/** Retries after a 429 (the first attempt is not counted). */
export const STARTUP_MAX_429_RETRIES = 4;
const STARTUP_JITTER_MAX_FRACTION = 0.25;

/**
 * The cold launch's profile fetch (moved from App.tsx's `retryGetMe`).
 * Retries transient failures; a 401 is definitive (the API client clears the
 * invalid token) and is rethrown. Returns null only when every attempt failed
 * for network/timeout reasons. A 429 is remembered across later timeouts: it
 * waits its Retry-After (+0-25 % jitter, at most ${STARTUP_MAX_429_RETRIES} retries) and, when the
 * Retry-After is above 60 s or the attempts run out, the 429 `ApiError` is
 * thrown, so the caller can tell "rate limited" from "offline".
 * `getMe` is the caller's owner-naming call (`getMeNamingKeyOwner`).
 */
export async function retryStartupGetMe<T>(
  getMe: () => Promise<T>,
  isUnauthorized: (err: unknown) => boolean,
  options: { delaysMs?: number[]; timeoutMs?: number; random?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T | null> {
  const delays = options.delaysMs ?? [1000, 3000, 5000];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last429: unknown = null;
  for (let attempt = 0; ; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitMs: number;
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
      const limited = as429(err);
      if (limited) last429 = err;
      if (limited && limited.retryAfterSeconds !== undefined) {
        if (limited.retryAfterSeconds > STARTUP_MAX_RETRY_AFTER_SECONDS) throw err;
        waitMs = limited.retryAfterSeconds * 1000 * (1 + random() * STARTUP_JITTER_MAX_FRACTION);
      } else {
        waitMs = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      }
      const retriesLeft = last429 ? attempt < STARTUP_MAX_429_RETRIES : attempt < delays.length - 1;
      if (!retriesLeft) {
        if (last429) throw last429;
        return null; // all retries failed with network/timeout failures
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await sleep(waitMs);
  }
}
