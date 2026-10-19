// @ts-nocheck
/**
 * Task 1667 round 15 (review of mobile#182 at dd97f2ac, items 4 and 5).
 *
 * Item 4: a REAL cold launch runs runStartup -> retryGetMe -> getMe. Round 14
 * read the stored key's owner only in refreshAuth (the sign-in path), so a
 * cold-launch 403 account_deleted reached the handler with no account named,
 * and native discarded every account's kept marks (another account's
 * unmarked photos then uploaded a second time).
 *
 * Driven here through the shipped cold-launch pieces: the REAL
 * `retryStartupGetMe` (App.tsx's retryGetMe body) around the REAL
 * `getMeNamingKeyOwner`, around the REAL api.ts `getMe` -> `request()`, whose
 * 403 branch calls the REAL registered account-deleted handler. The handler
 * reads the owner exactly as App.tsx's does (`accountIdForDeletedElsewhere(
 * currentUserIdRef.current, coldStartOwnerRef.current)`, i.e. the signed-in
 * user, else the owner). The App.tsx wiring is pinned by the guards below.
 *
 * Item 5: currentUserIdRef is cleared when the user becomes null.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];

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
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-file-system/legacy', () => ({}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  isNativeAvailable: true,
  opaqueLoginStart: async () => ({
    state: new Uint8Array([1]),
    message: new Uint8Array([2]),
  }),
  opaqueLoginFinish: async () => ({ message: new Uint8Array([3]) }),
}));

mock.module('./file-index-cache', () => ({
  clearCachedFileIndex: async () => {},
}));

mock.module('./sync-client', () => ({
  getDeviceId: async () => 'device-1',
}));

mock.module('./announcement-context', () => ({
  setAnnouncement: () => {},
  clearAnnouncement: () => {},
}));

mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMeNamingKeyOwner, retryStartupGetMe } from './cold-start-owner';

const TOKEN_KEY = 'beebeeb_session_token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const deletedBody = {
  error: 'account_deleted',
  message: 'This account was deleted and is scheduled for permanent erasure.',
  deleted_at: '2026-09-13T00:00:00Z',
  shred_after: '2026-10-13T00:00:00Z',
};

async function loadFreshApi() {
  return import(`./api?coldStartOwnerTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

/** App.tsx's refs and its account-deleted handler, as registered there. */
async function appWithStoredSession(keyOwner: string | null) {
  const api = await loadFreshApi();
  store.set(TOKEN_KEY, 'session-token');
  const currentUserIdRef = { current: null as string | null };
  const coldStartOwnerRef = { current: null as string | null };
  const named: Array<string | null> = [];
  api.registerAccountDeletedHandler(() => {
    named.push(currentUserIdRef.current || coldStartOwnerRef.current || null);
  });
  let keyReads = 0;
  const readKeyOwner = async () => {
    keyReads += 1;
    return keyOwner;
  };
  // App.tsx's retryGetMe (round 15).
  const retryGetMe = () =>
    retryStartupGetMe(
      () =>
        getMeNamingKeyOwner({
          owner: coldStartOwnerRef,
          signedInUserId: currentUserIdRef.current,
          readKeyOwner,
          getMe: api.getMe,
        }),
      (err) => err instanceof api.ApiError && err.status === 401,
      { delaysMs: [0, 0, 0] },
    );
  return { api, currentUserIdRef, coldStartOwnerRef, named, retryGetMe, keyReads: () => keyReads };
}

describe('item 4: a cold-launch 403 account_deleted names the stored key owner', () => {
  test('r15-4.1 runStartup -> retryGetMe -> getMe: the handler names acct-A, and the owner is cleared after', async () => {
    const app = await appWithStoredSession('acct-A');
    // The 403, then whatever the retries see once the token is cleared.
    fetchQueue.push(async () => jsonResponse(deletedBody, 403));
    for (let i = 0; i < 4; i += 1) fetchQueue.push(async () => jsonResponse({ error: 'unauthorized' }, 401));
    await app.retryGetMe().catch(() => null);
    expect(app.named).toEqual(['acct-A']);
    expect(app.keyReads()).toBeGreaterThanOrEqual(1);
    expect(app.coldStartOwnerRef.current).toBe(null);
    expect(store.has(TOKEN_KEY)).toBe(false);
  });

  test('r15-4.2 control: the dd97f2ac cold-launch shape (retryGetMe calls getMe bare) names no one', async () => {
    const app = await appWithStoredSession('acct-A');
    fetchQueue.push(async () => jsonResponse(deletedBody, 403));
    for (let i = 0; i < 4; i += 1) fetchQueue.push(async () => jsonResponse({ error: 'unauthorized' }, 401));
    await retryStartupGetMe(app.api.getMe, (err) => err instanceof app.api.ApiError && err.status === 401, {
      delaysMs: [0, 0, 0],
    }).catch(() => null);
    expect(app.named).toEqual([null]);
  });

  test('r15-4.3 a signed-in user is named, and the key owner is not read', async () => {
    const app = await appWithStoredSession('acct-A');
    app.currentUserIdRef.current = 'acct-B';
    fetchQueue.push(async () => jsonResponse(deletedBody, 403));
    for (let i = 0; i < 4; i += 1) fetchQueue.push(async () => jsonResponse({ error: 'unauthorized' }, 401));
    await app.retryGetMe().catch(() => null);
    expect(app.named).toEqual(['acct-B']);
    expect(app.keyReads()).toBe(0);
  });

  test('r15-4.4 a successful cold launch returns the profile and leaves no owner behind', async () => {
    const app = await appWithStoredSession('acct-A');
    fetchQueue.push(async () => jsonResponse({ user_id: 'acct-A', email: 'a@beebeeb.io' }));
    const me = await app.retryGetMe();
    expect(me?.user_id).toBe('acct-A');
    expect(app.coldStartOwnerRef.current).toBe(null);
    expect(app.named).toEqual([]);
  });

  test('r15-4.5 an earlier call settling late never clears a later call\'s owner', async () => {
    const owner = { current: null as string | null };
    let releaseFirst: () => void = () => {};
    const first = getMeNamingKeyOwner({
      owner, signedInUserId: null, readKeyOwner: async () => 'acct-A',
      getMe: () => new Promise<void>((r) => { releaseFirst = r; }),
    });
    await Promise.resolve();
    await Promise.resolve();
    let seenDuringSecond: string | null = 'unset';
    let releaseSecond: () => void = () => {};
    const second = getMeNamingKeyOwner({
      owner, signedInUserId: null, readKeyOwner: async () => 'acct-A2',
      getMe: () => new Promise<void>((r) => { releaseSecond = r; }),
    });
    await new Promise((r) => setTimeout(r, 0));
    releaseFirst();
    await first;
    seenDuringSecond = owner.current;
    releaseSecond();
    await second;
    expect(seenDuringSecond).toBe('acct-A2');
    expect(owner.current).toBe(null);
  });
});

describe('items 4 and 5: App.tsx wiring guards', () => {
  const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8');

  test('the cold launch (runStartup) gets the profile through retryGetMe, which names the key owner', () => {
    expect(app).toMatch(/me = await retryGetMe\(\);/);
    const retry = app.slice(app.indexOf('const retryGetMe = useCallback('), app.indexOf('const retryGetMe = useCallback(') + 600);
    expect(retry).toMatch(/retryStartupGetMe\(\s*\(\) =>\s*getMeNamingKeyOwner\(\{\s*owner: coldStartOwnerRef,\s*signedInUserId: currentUserIdRef\.current,\s*readKeyOwner,\s*getMe,\s*\}\),/);
  });

  test('refreshAuth uses the same owner-naming call; no bare getMe() call is left in App.tsx', () => {
    const refresh = app.slice(app.indexOf('const refreshAuth = useCallback('), app.indexOf('const refreshAuth = useCallback(') + 900);
    expect(refresh).toMatch(/const me = await getMeNamingKeyOwner\(\{\s*owner: coldStartOwnerRef,\s*signedInUserId: currentUserIdRef\.current,\s*readKeyOwner,\s*getMe,\s*\}\);/);
    const code = app.replace(/\/\/[^\n]*/g, '');
    expect((code.match(/\bgetMe\(\)/g) ?? []).length).toBe(0);
  });

  test('the handler reads both refs; currentUserIdRef is cleared when the user becomes null (item 5)', () => {
    expect(app).toMatch(/noteAccountDeleted\(accountIdForDeletedElsewhere\(currentUserIdRef\.current, coldStartOwnerRef\.current\)\);/);
    expect(app.includes('currentUserIdRef.current = user ? user.user_id : null;')).toBe(true);
    expect(app.includes('if (user) currentUserIdRef.current = user.user_id;')).toBe(false);
  });
});
