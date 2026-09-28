import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Plan, Subscription } from './api';

/**
 * Last-known billing snapshot for instant-paint / stale-while-revalidate on the
 * Storage & Plan screen. We persist the raw `getSubscription` + `getPlans`
 * payloads so the screen can render immediately on a warm open, then refresh in
 * the background. Best-effort — a read/write failure must never block the UI.
 *
 * Staleness note: `subscription` here carries `used_bytes`/`quota_bytes`, i.e.
 * the on-screen storage usage is painted from cache before the network confirms
 * it. This is acceptable for a glanceable usage bar (the network value lands a
 * moment later), but it does mean a brief stale figure can show.
 *
 * Task 1601, root cause 4: this key used to be global
 * (`beebeeb:billing-cache:v1`, no user id anywhere in it) and was never
 * cleared on sign-out — so account B's very first open of Storage & Plan
 * could instant-paint account A's plan/quota straight from disk, for one
 * frame or, offline, indefinitely. Fixed two ways, matching the ruling
 * (scope AND clear, not either alone):
 *  - every entry is keyed by the signed-in user's id (`cacheKeyFor`) — a
 *    write under user A's id is never readable under user B's id, so cross-
 *    account leakage can't happen even if the clear below is ever skipped;
 *  - `clearCachedBilling()` is called from `api.ts`'s `clearToken()`, the
 *    same central sign-out/forced-sign-out cleanup point that already clears
 *    the other per-account cache (`clearCachedFileIndex`) — covering sign-
 *    out, a forced 401 sign-out, and an account switch (sign-out then a
 *    different sign-in) alike.
 */

const BILLING_CACHE_KEY = 'beebeeb:billing-cache:v1';

function cacheKeyFor(userId: string): string {
  return `${BILLING_CACHE_KEY}:${userId}`;
}

export interface CachedBilling {
  subscription: Subscription | null;
  /** Raw, unfiltered plan list as returned by `getPlans()`. */
  plans: Plan[];
  cachedAt: number;
}

/** A read with no signed-in user id returns nothing — there is nothing to key it by. */
export async function loadCachedBilling(userId: string | null | undefined): Promise<CachedBilling | null> {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(cacheKeyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedBilling> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.plans)) return null;
    // `subscription` is legitimately null for an errored/unknown state; only a
    // wrong-typed value is rejected.
    const subscription =
      parsed.subscription && typeof parsed.subscription === 'object'
        ? (parsed.subscription as Subscription)
        : null;
    return {
      subscription,
      plans: parsed.plans as Plan[],
      cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function saveCachedBilling(
  subscription: Subscription | null,
  plans: Plan[],
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  try {
    const payload: CachedBilling = { subscription, plans, cachedAt: Date.now() };
    await AsyncStorage.setItem(cacheKeyFor(userId), JSON.stringify(payload));
  } catch {
    // Best-effort: a failed cache write must never break the screen.
  }
}

/**
 * Sign-out / forced-sign-out / account-switch cleanup. Wipes every cached
 * billing entry on the device (not just the outgoing user's) — with no
 * bounded list of user ids the app has ever signed into on this device kept
 * anywhere, scanning for every `beebeeb:billing-cache:v1:*` key and removing
 * them all is the only way to guarantee no stale entry is left behind.
 * Never throws — called from `clearToken()`, which must never fail a
 * sign-out over a cache-cleanup error.
 */
export async function clearCachedBilling(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const prefix = `${BILLING_CACHE_KEY}:`;
    const match = keys.filter((k) => k.startsWith(prefix));
    if (match.length > 0) await AsyncStorage.multiRemove(match);
  } catch {
    // Best-effort — see doc comment.
  }
}
