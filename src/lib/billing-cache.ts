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
 */

const BILLING_CACHE_KEY = 'beebeeb:billing-cache:v1';

export interface CachedBilling {
  subscription: Subscription | null;
  /** Raw, unfiltered plan list as returned by `getPlans()`. */
  plans: Plan[];
  cachedAt: number;
}

export async function loadCachedBilling(): Promise<CachedBilling | null> {
  try {
    const raw = await AsyncStorage.getItem(BILLING_CACHE_KEY);
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
): Promise<void> {
  try {
    const payload: CachedBilling = { subscription, plans, cachedAt: Date.now() };
    await AsyncStorage.setItem(BILLING_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort: a failed cache write must never break the screen.
  }
}
