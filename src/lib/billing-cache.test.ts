// @ts-nocheck
/**
 * Task 1601, root cause 4 — the billing cache used to be one global,
 * never-cleared AsyncStorage key (`beebeeb:billing-cache:v1`). Guus's
 * report: "Could it be an issue related to previous logged in account?" —
 * after switching accounts, the Storage & Plan screen's instant-paint could
 * show the PREVIOUS account's plan/quota from disk, for one frame or,
 * offline, indefinitely.
 *
 * Fix, tested here:
 *  - every entry is keyed by user id — a write under user A is never
 *    readable under user B;
 *  - `clearCachedBilling()` (called from `api.ts`'s `clearToken()` on
 *    sign-out) removes every cached entry the device holds;
 *  - a read with no signed-in user id returns nothing.
 *
 * Same isolated-per-file AsyncStorage mock pattern as file-index-cache.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const asyncStore = new Map<string, string>();

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStore.get(key) ?? null,
    setItem: async (key: string, value: string) => { asyncStore.set(key, value); },
    removeItem: async (key: string) => { asyncStore.delete(key); },
    getAllKeys: async () => Array.from(asyncStore.keys()),
    multiRemove: async (keys: string[]) => { for (const k of keys) asyncStore.delete(k); },
  },
}));

const { loadCachedBilling, saveCachedBilling, clearCachedBilling, resetLegacyBillingCacheKeyRemovalForTests } =
  await import('./billing-cache');

function plan(overrides: Record<string, unknown> = {}) {
  return { id: 'pro', name: 'Pro', price_cents: 999, storage_bytes: 1_000_000_000, is_active: true, ...overrides };
}

beforeEach(() => {
  asyncStore.clear();
  resetLegacyBillingCacheKeyRemovalForTests();
});

describe('billing-cache — per-user scoping (task 1601 root cause 4)', () => {
  test('write as user A, read as user B -> null (never returns A\'s cached plan to B)', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');

    const forB = await loadCachedBilling('user-B');
    expect(forB).toBeNull();
  });

  test('write as user A, read as user A -> the cached snapshot round-trips', async () => {
    const sub = { plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null };
    await saveCachedBilling(sub, [plan()], 'user-A');

    const forA = await loadCachedBilling('user-A');
    expect(forA?.subscription?.plan).toBe('pro');
    expect(forA?.plans).toHaveLength(1);
  });

  test('two users cached side by side never collide', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');
    await saveCachedBilling({ plan: 'free', billing_cycle: null, status: 'active', current_period_end: null }, [], 'user-B');

    expect((await loadCachedBilling('user-A'))?.subscription?.plan).toBe('pro');
    expect((await loadCachedBilling('user-B'))?.subscription?.plan).toBe('free');
  });
});

describe('billing-cache — no signed-in user (task 1601)', () => {
  test('a read with no signed-in user id (null) returns nothing', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');
    expect(await loadCachedBilling(null)).toBeNull();
  });

  test('a read with no signed-in user id (undefined) returns nothing', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');
    expect(await loadCachedBilling(undefined)).toBeNull();
  });

  test('a write with no signed-in user id is a no-op — nothing is ever readable back', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], null);
    expect(asyncStore.size).toBe(0);
  });
});

describe('billing-cache — clearCachedBilling (sign-out cleanup)', () => {
  test('sign-out clears a cached entry — it is unreadable afterward even by its own owner', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');
    expect(await loadCachedBilling('user-A')).not.toBeNull();

    await clearCachedBilling();

    expect(await loadCachedBilling('user-A')).toBeNull();
  });

  test('sign-out clears every cached user\'s entry, not just one', async () => {
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');
    await saveCachedBilling({ plan: 'business', billing_cycle: 'annual', status: 'active', current_period_end: null }, [plan()], 'user-B');

    await clearCachedBilling();

    expect(await loadCachedBilling('user-A')).toBeNull();
    expect(await loadCachedBilling('user-B')).toBeNull();
  });

  test('clearCachedBilling never throws when there is nothing cached', async () => {
    await expect(clearCachedBilling()).resolves.toBeUndefined();
  });

  test('clearCachedBilling leaves unrelated AsyncStorage keys untouched', async () => {
    asyncStore.set('beebeeb:some-other-cache:v1', 'unrelated');
    await saveCachedBilling({ plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null }, [plan()], 'user-A');

    await clearCachedBilling();

    expect(asyncStore.get('beebeeb:some-other-cache:v1')).toBe('unrelated');
  });
});

describe('billing-cache — legacy unscoped key cleanup (lead review follow-up, task 1601)', () => {
  test('legacy key present -> clearCachedBilling() removes it', async () => {
    asyncStore.set('beebeeb:billing-cache:v1', JSON.stringify({
      subscription: { plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null },
      plans: [plan()],
      cachedAt: 0,
    }));

    await clearCachedBilling();

    expect(asyncStore.has('beebeeb:billing-cache:v1')).toBe(false);
  });

  test('legacy key present -> after a load it is gone', async () => {
    asyncStore.set('beebeeb:billing-cache:v1', JSON.stringify({
      subscription: { plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null },
      plans: [plan()],
      cachedAt: 0,
    }));

    await loadCachedBilling('user-A');

    expect(asyncStore.has('beebeeb:billing-cache:v1')).toBe(false);
  });

  test('legacy key present -> after a save it is gone', async () => {
    asyncStore.set('beebeeb:billing-cache:v1', JSON.stringify({
      subscription: { plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null },
      plans: [plan()],
      cachedAt: 0,
    }));

    await saveCachedBilling({ plan: 'free', billing_cycle: null, status: 'active', current_period_end: null }, [], 'user-A');

    expect(asyncStore.has('beebeeb:billing-cache:v1')).toBe(false);
  });

  test('a per-user entry for the current user survives the one-time legacy removal', async () => {
    asyncStore.set('beebeeb:billing-cache:v1', JSON.stringify({
      subscription: { plan: 'pro', billing_cycle: 'monthly', status: 'active', current_period_end: null },
      plans: [plan()],
      cachedAt: 0,
    }));
    await saveCachedBilling({ plan: 'business', billing_cycle: 'annual', status: 'active', current_period_end: null }, [plan()], 'user-A');

    // A second load (which also attempts the now-already-gone legacy removal)
    // must not disturb the per-user entry it just wrote.
    const result = await loadCachedBilling('user-A');

    expect(asyncStore.has('beebeeb:billing-cache:v1')).toBe(false);
    expect(result?.subscription?.plan).toBe('business');
  });
});
