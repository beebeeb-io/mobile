// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory SecureStore so the canonical-id migration is testable without the
// native keychain module. The module under test imports `* as SecureStore`.
const store = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

// react-native's Platform — default to a native platform (not 'web') so the
// SecureStore branch is exercised.
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const SYNC_KEY = 'bb_sync_device_id';
const BACKUP_KEY = 'beebeeb_device_id';

// Fresh module instance per test so the in-module `_inFlight` coalescing cache
// can't leak a resolved id across cases.
async function loadFresh() {
  const mod = await import(`./device-identity?bust=${Math.random()}`);
  return mod;
}

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  store.clear();
});

describe('getDeviceId — canonical device identity (0863)', () => {
  test('steady state: returns the existing sync id unchanged (no churn)', async () => {
    store.set(SYNC_KEY, 'sync-uuid-existing');
    const { getDeviceId } = await loadFresh();
    expect(await getDeviceId()).toBe('sync-uuid-existing');
    // Did not overwrite the canonical key.
    expect(store.get(SYNC_KEY)).toBe('sync-uuid-existing');
  });

  test('sync id wins over a legacy backup id (PhotoKit-dedup anchor preserved)', async () => {
    store.set(SYNC_KEY, 'sync-uuid');
    store.set(BACKUP_KEY, 'backup-uuid');
    const { getDeviceId } = await loadFresh();
    expect(await getDeviceId()).toBe('sync-uuid');
  });

  test('no sync id but a legacy backup id exists: carry it forward (manifest stays stable)', async () => {
    store.set(BACKUP_KEY, 'backup-uuid-legacy');
    const { getDeviceId } = await loadFresh();
    const id = await getDeviceId();
    expect(id).toBe('backup-uuid-legacy');
    // The legacy backup id is now promoted to the canonical key.
    expect(store.get(SYNC_KEY)).toBe('backup-uuid-legacy');
  });

  test('fresh install: mints one UUID and persists it under the canonical key', async () => {
    const { getDeviceId } = await loadFresh();
    const id = await getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(store.get(SYNC_KEY)).toBe(id);
  });

  test('idempotent: repeated calls return the same value', async () => {
    const { getDeviceId } = await loadFresh();
    const a = await getDeviceId();
    const b = await getDeviceId();
    expect(a).toBe(b);
  });

  test('concurrent first-run callers coalesce to a single minted id', async () => {
    const { getDeviceId } = await loadFresh();
    const [a, b, c] = await Promise.all([getDeviceId(), getDeviceId(), getDeviceId()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Exactly one value persisted.
    expect(store.get(SYNC_KEY)).toBe(a);
  });
});
