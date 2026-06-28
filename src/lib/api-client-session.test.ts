// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let secureStoreGetQueue: Array<(key: string) => Promise<string | null>> = [];
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];

mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}));

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    const next = secureStoreGetQueue.shift();
    if (next) return next(key);
    return store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-file-system', () => ({}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
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

const TOKEN_KEY = 'beebeeb_session_token';
const CACHE_KEY = 'beebeeb_mobile_ios_backup_client_session_id';
const SESSION_NAME = 'iPhone Camera Roll Backup';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    device_id: 'device-1',
    name: SESSION_NAME,
    session_type: 'backup',
    local_path: 'Camera Roll',
    remote_path: '/Backups/Camera Roll',
    status: 'syncing',
    heartbeat_interval_secs: 30,
    alert_after_missed: 4,
    created_at: '2026-06-27T00:00:00Z',
    last_heartbeat: null,
    files_synced: null,
    files_total: null,
    bytes_synced: null,
    bytes_total: null,
    heartbeat_status: null,
    current_file: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?clientSessionTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  secureStoreGetQueue = [];
});

describe('session generation guards', () => {
  test('stale token read resolving after setToken does not overwrite cached token', async () => {
    store.set(TOKEN_KEY, 'old-token');
    let resolveOldRead!: (value: string | null) => void;
    secureStoreGetQueue.push(() => new Promise((resolve) => {
      resolveOldRead = resolve;
    }));

    const { getToken, setToken } = await loadFreshApi();
    const staleRead = getToken();
    await Promise.resolve();

    await setToken('new-token');
    resolveOldRead('old-token');

    expect(await staleRead).toBe('old-token');
    expect(await getToken()).toBe('new-token');
    expect(store.get(TOKEN_KEY)).toBe('new-token');
  });

  test('stale authenticated 401 does not clear a newer token or fire session expiry', async () => {
    const { ApiError, getMe, getToken, registerSessionExpiredHandler, setToken } = await loadFreshApi();
    let expiredCount = 0;
    registerSessionExpiredHandler(() => { expiredCount += 1; });
    await setToken('old-token');

    let resolveOldMe!: (response: Response) => void;
    fetchQueue.push(async () => new Promise((resolve) => {
      resolveOldMe = resolve;
    }));

    const staleRequest = getMe().catch((err) => err);
    await Promise.resolve();
    await setToken('new-token');

    resolveOldMe(jsonResponse({ error: 'expired' }, 401));
    const err = await staleRequest;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(expiredCount).toBe(0);
    expect(await getToken()).toBe('new-token');
    expect(store.get(TOKEN_KEY)).toBe('new-token');
  });

  test('current authenticated 401 still clears token and fires session expiry', async () => {
    const { ApiError, getMe, getToken, registerSessionExpiredHandler, setToken } = await loadFreshApi();
    let expiredCount = 0;
    registerSessionExpiredHandler(() => { expiredCount += 1; });
    await setToken('expired-token');
    fetchQueue.push(async () => jsonResponse({ error: 'expired' }, 401));

    const err = await getMe().catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(expiredCount).toBe(1);
    expect(await getToken()).toBeNull();
    expect(store.has(TOKEN_KEY)).toBe(false);
  });
});

describe('ensureMobileIosBackupClientSession', () => {
  test('validates and reuses a cached non-stopped backup session', async () => {
    store.set(CACHE_KEY, 'cached-session');
    fetchQueue.push(async () => jsonResponse({ sessions: [session({ id: 'cached-session' })] }));

    const { ensureMobileIosBackupClientSession } = await loadFreshApi();

    expect(await ensureMobileIosBackupClientSession('device-1')).toBe('cached-session');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].init.method).toBe('GET');
    expect(store.get(CACHE_KEY)).toBe('cached-session');
  });

  test('does not reuse cached id or create duplicates when session listing fails', async () => {
    store.set(CACHE_KEY, 'cached-session');
    fetchQueue.push(async () => { throw new Error('network down'); });

    const { ensureMobileIosBackupClientSession } = await loadFreshApi();

    expect(await ensureMobileIosBackupClientSession('device-1')).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].init.method).toBe('GET');
    expect(store.get(CACHE_KEY)).toBe('cached-session');
  });

  test('drops stale cached id and reuses an existing live backup session', async () => {
    store.set(CACHE_KEY, 'deleted-session');
    fetchQueue.push(async () => jsonResponse({ sessions: [session({ id: 'live-session' })] }));

    const { ensureMobileIosBackupClientSession } = await loadFreshApi();

    expect(await ensureMobileIosBackupClientSession('device-1')).toBe('live-session');
    expect(fetchCalls).toHaveLength(1);
    expect(store.get(CACHE_KEY)).toBe('live-session');
  });

  test('creates and caches a backup session when no live session exists', async () => {
    fetchQueue.push(
      async () => jsonResponse({ sessions: [] }),
      async () => jsonResponse(session({ id: 'created-session', status: 'idle' })),
    );

    const { ensureMobileIosBackupClientSession } = await loadFreshApi();

    expect(await ensureMobileIosBackupClientSession('device-1')).toBe('created-session');
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].init.method).toBe('GET');
    expect(fetchCalls[1].init.method).toBe('POST');
    expect(JSON.parse(fetchCalls[1].init.body as string)).toMatchObject({
      device_id: 'device-1',
      name: SESSION_NAME,
      session_type: 'backup',
      heartbeat_interval_secs: 30,
    });
    expect(store.get(CACHE_KEY)).toBe('created-session');
  });
});
