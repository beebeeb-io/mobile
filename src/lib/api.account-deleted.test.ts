// @ts-nocheck
/**
 * Task 1405 — mapper/request-path test for the `account_deleted` 403.
 *
 * Mirrors the web client's central-handler test (`repos/web/test/session-expiry-gate.test.ts`)
 * and the server contract (`repos/server/beebeeb-api/src/error.rs`,
 * `ApiError::AccountDeleted`): `403 {"error":"account_deleted","deleted_at":"<rfc3339>",
 * "shred_after":"<rfc3339>"}` on password/OPAQUE login-finish AND on any authenticated
 * call whose session belongs to a since-deleted account.
 *
 * Isolated per bun:test-per-file semantics (mobile/CLAUDE.md "Tests") — every native
 * module `api.ts` touches is mocked here, same scaffold as `api-client-session.test.ts` /
 * `api.delete-account.test.ts`.
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

const TOKEN_KEY = 'beebeeb_session_token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accountDeletedBody() {
  return {
    error: 'account_deleted',
    message: 'This account was deleted and is scheduled for permanent erasure.',
    deleted_at: '2026-09-13T00:00:00Z',
    shred_after: '2026-10-13T00:00:00Z',
  };
}

async function loadFreshApi() {
  return import(`./api?accountDeletedTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('formatAccountDeletedMessage', () => {
  test('renders the exact copy with both dates, date-only, in order', async () => {
    const { formatAccountDeletedMessage } = await loadFreshApi();
    const msg = formatAccountDeletedMessage('2026-09-13T00:00:00Z', '2026-10-13T00:00:00Z');
    expect(msg).toStartWith('This account was deleted on ');
    expect(msg).toContain('. Its encrypted data will be shredded on ');
    expect(msg).toEndWith(". We can't recover it.");
    // Date-only: no time-of-day fragment (a colon would indicate one, e.g. "10:00 AM").
    expect(msg).not.toContain(':');
  });
});

describe('opaqueLoginFinish — account_deleted', () => {
  test('a 403 account_deleted body throws AccountDeletedError with both dates', async () => {
    // login-start round trip (not the round under test) then login-finish 403.
    fetchQueue.push(
      async () => jsonResponse({ server_message: Buffer.from([9]).toString('base64'), server_state: 's', ksf_version: 1 }),
      async () => jsonResponse(accountDeletedBody(), 403),
    );

    const { AccountDeletedError, ApiError, opaqueLoginStart, opaqueLoginFinish } = await loadFreshApi();
    const start = await opaqueLoginStart('deleted@beebeeb.io', 'pw');
    const err = await opaqueLoginFinish(
      'deleted@beebeeb.io', 'pw', start.state, start.serverMessage, start.serverState, start.ksf_version,
    ).catch((caught) => caught);

    expect(err).toBeInstanceOf(AccountDeletedError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.deletedAt).toBe('2026-09-13T00:00:00Z');
    expect(err.shredAfter).toBe('2026-10-13T00:00:00Z');
    // No session was minted — no token persisted.
    expect(store.has(TOKEN_KEY)).toBe(false);
  });

  test('friendlyError() renders the AccountDeletedError as the exact login-screen copy', async () => {
    const { AccountDeletedError, friendlyError } = await loadFreshApi();
    const err = new AccountDeletedError('2026-09-13T00:00:00Z', '2026-10-13T00:00:00Z');
    expect(friendlyError(err)).toBe(
      "This account was deleted on September 13, 2026. Its encrypted data will be shredded on October 13, 2026. We can't recover it.",
    );
  });

  test('wrong password (401) on the same account is unaffected — generic copy, not AccountDeletedError', async () => {
    fetchQueue.push(
      async () => jsonResponse({ server_message: Buffer.from([9]).toString('base64'), server_state: 's', ksf_version: 1 }),
      async () => jsonResponse({ error: 'invalid_credentials' }, 401),
    );

    const { AccountDeletedError, ApiError, friendlyError, opaqueLoginStart, opaqueLoginFinish } = await loadFreshApi();
    const start = await opaqueLoginStart('deleted@beebeeb.io', 'wrong-pw');
    const err = await opaqueLoginFinish(
      'deleted@beebeeb.io', 'wrong-pw', start.state, start.serverMessage, start.serverState, start.ksf_version,
    ).catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(AccountDeletedError);
    expect(err.status).toBe(401);
    expect(friendlyError(err)).toBe('Wrong email or password.');
  });
});

describe('request() authenticated 403 account_deleted — session/live-device path', () => {
  test('clears the token and fires the account-deleted handler exactly once', async () => {
    store.set(TOKEN_KEY, 'session-token');
    fetchQueue.push(async () => jsonResponse(accountDeletedBody(), 403));

    const { AccountDeletedError, getMe, getToken, registerAccountDeletedHandler } = await loadFreshApi();
    let firedCount = 0;
    let firedDeletedAt: string | null = null;
    let firedShredAfter: string | null = null;
    registerAccountDeletedHandler((deletedAt: string, shredAfter: string) => {
      firedCount += 1;
      firedDeletedAt = deletedAt;
      firedShredAfter = shredAfter;
    });

    const err = await getMe().catch((caught) => caught);

    expect(err).toBeInstanceOf(AccountDeletedError);
    expect(firedCount).toBe(1);
    expect(firedDeletedAt).toBe('2026-09-13T00:00:00Z');
    expect(firedShredAfter).toBe('2026-10-13T00:00:00Z');
    expect(await getToken()).toBeNull();
    expect(store.has(TOKEN_KEY)).toBe(false);
  });

  test('a stale in-flight request (session already replaced) does not fire the handler or clear the new token', async () => {
    const { getMe, getToken, registerAccountDeletedHandler, setToken } = await loadFreshApi();
    let firedCount = 0;
    registerAccountDeletedHandler(() => { firedCount += 1; });
    await setToken('old-token');

    let resolveOldMe!: (response: Response) => void;
    fetchQueue.push(async () => new Promise((resolve) => { resolveOldMe = resolve; }));

    const staleRequest = getMe().catch((err) => err);
    await Promise.resolve();
    await setToken('new-token');

    resolveOldMe(jsonResponse(accountDeletedBody(), 403));
    await staleRequest;

    expect(firedCount).toBe(0);
    expect(await getToken()).toBe('new-token');
    expect(store.get(TOKEN_KEY)).toBe('new-token');
  });
});
