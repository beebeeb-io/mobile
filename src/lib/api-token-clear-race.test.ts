// @ts-nocheck
/**
 * Task 1962 Bug 2 (tracked with 1667) — `getToken()` running while
 * `clearToken()` is still awaiting must not bring the signed-out token back.
 *
 * `clearToken()` bumps the session generation and nulls the in-memory token
 * synchronously, then awaits the native App-Group clear BEFORE it removes the
 * token from the secure store. A `getToken()` that starts inside that window
 * reads the OLD token from the store, sees an unchanged generation, and used
 * to cache it again: after sign-out the process still held (and sent) the
 * revoked token.
 *
 * Mocks follow api-client-session.test.ts (isolated runner: every native
 * module this file's graph needs is mocked here).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let mirrorGate: Promise<void> | null = null;
let deleteGate: Promise<void> | null = null;

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => {
    if (deleteGate && key === 'beebeeb_session_token') await deleteGate;
    store.delete(key);
  },
}));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  // The clear path awaits this FIRST, before the secure-store removal — the
  // test holds it open to land a getToken() inside the window.
  mirrorSessionToAppGroup: async () => {
    if (mirrorGate) await mirrorGate;
    return true;
  },
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
}));
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }));
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string) => { throw new Error(`unexpected fetch: ${url}`); },
}));

const TOKEN_KEY = 'beebeeb_session_token';

async function loadFreshApi() {
  return import(`./api?tokenClearRace=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  mirrorGate = null;
  deleteGate = null;
});

describe('clearToken / getToken race (1962 Bug 2)', () => {
  test('a getToken() that starts while clearToken() is awaiting returns null and does not re-cache the old token', async () => {
    const { getToken, setToken, clearToken } = await loadFreshApi();
    // setToken itself awaits mirrorSessionToAppGroup; leave the gate open for it.
    await setToken('old-token');
    expect(store.get(TOKEN_KEY)).toBe('old-token');

    let openGate!: () => void;
    mirrorGate = new Promise<void>((resolve) => { openGate = resolve; });
    const clearing = clearToken();
    // clearToken is now parked on the native mirror clear; the secure store
    // still holds the old token.
    await Promise.resolve();
    expect(store.get(TOKEN_KEY)).toBe('old-token');

    const during = await getToken();
    openGate();
    await clearing;

    expect(during).toBeNull();
    expect(store.has(TOKEN_KEY)).toBe(false);
    // The bug: the read above cached 'old-token', so this returned it.
    expect(await getToken()).toBeNull();
  });

  test('a getToken() while the secure-store delete itself is pending also returns null', async () => {
    const { getToken, setToken, clearToken } = await loadFreshApi();
    await setToken('old-token');
    let openDelete!: () => void;
    deleteGate = new Promise<void>((resolve) => { openDelete = resolve; });
    const clearing = clearToken();
    // Let clearToken get past the native mirror clear and park on the delete.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(store.get(TOKEN_KEY)).toBe('old-token');
    const during = await getToken();
    openDelete();
    await clearing;
    expect(during).toBeNull();
    expect(await getToken()).toBeNull();
  });

  test('a sign-in that lands after the clear is still served from memory', async () => {
    const { getToken, setToken, clearToken } = await loadFreshApi();
    await setToken('old-token');
    let openGate!: () => void;
    mirrorGate = new Promise<void>((resolve) => { openGate = resolve; });
    const clearing = clearToken();
    await Promise.resolve();
    openGate();
    await clearing;
    mirrorGate = null;
    await setToken('new-token');
    expect(await getToken()).toBe('new-token');
  });
});
