// @ts-nocheck
/**
 * Task 1557 — regression lock for the App Review 2.1(a) login rejection (2026-09-25).
 *
 * Root cause of that rejection: the build under review (141, May 2026) ran the OPAQUE
 * login finish with the legacy Identity KSF and ignored the `ksf_version` that
 * `/api/v1/opaque/login-start` returns. The demo account was registered under KSF v1
 * (Argon2id), so the envelope could not open on the device and the app showed
 * "login finish failed (wrong password?)" before it ever sent login-finish.
 * Reproduced in core: a v1 password file finished with ksf_version=0 fails with
 * `Opaque("login finish failed (wrong password?): Error in validating credentials")`.
 *
 * Current clients thread `ksf_version` from login-start into the native finish. These
 * tests pin that contract so the client can never silently drop it again:
 *   - v1 account → native finish receives 1
 *   - v0 (legacy) account → native finish receives 0
 *   - a server that omits the field → 1 (the current registration KSF)
 *
 * Same isolated scaffold as `api.account-deleted.test.ts` (bun:test-per-file).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
const nativeFinishCalls: Array<{ state: Uint8Array; serverMessage: Uint8Array; password: string; ksfVersion: unknown }> = [];

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
  opaqueLoginFinish: async (state: Uint8Array, serverMessage: Uint8Array, password: string, ksfVersion: unknown) => {
    nativeFinishCalls.push({ state, serverMessage, password, ksfVersion });
    return { message: new Uint8Array([3]) };
  },
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

async function loadFreshApi() {
  return import(`./api?ksfThreadingTest=${Math.random()}`);
}

async function signIn(loginStartBody: Record<string, unknown>) {
  fetchQueue.push(
    async () => jsonResponse(loginStartBody),
    async () => jsonResponse({ session_token: 'session-token' }),
  );
  const { opaqueLoginStart, opaqueLoginFinish } = await loadFreshApi();
  const start = await opaqueLoginStart('app-review@beebeeb.io', 'pw');
  await opaqueLoginFinish(
    'app-review@beebeeb.io', 'pw', start.state, start.serverMessage, start.serverState, start.ksf_version,
  );
  return start;
}

const SERVER_MESSAGE = Buffer.from([9]).toString('base64');

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  nativeFinishCalls.length = 0;
});

describe('OPAQUE login — ksf_version from login-start reaches the native finish', () => {
  test('a KSF v1 (Argon2id) account finishes natively with ksf_version 1', async () => {
    const start = await signIn({ server_message: SERVER_MESSAGE, server_state: 's', ksf_version: 1 });

    expect(start.ksf_version).toBe(1);
    expect(nativeFinishCalls).toHaveLength(1);
    expect(nativeFinishCalls[0].ksfVersion).toBe(1);
    // The finish round actually went to the server and minted a session.
    expect(fetchCalls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/v1/opaque/login-start',
      '/api/v1/opaque/login-finish',
    ]);
    expect(store.get(TOKEN_KEY)).toBe('session-token');
  });

  test('a legacy KSF v0 (Identity) account finishes natively with ksf_version 0', async () => {
    const start = await signIn({ server_message: SERVER_MESSAGE, server_state: 's', ksf_version: 0 });

    expect(start.ksf_version).toBe(0);
    expect(nativeFinishCalls).toHaveLength(1);
    expect(nativeFinishCalls[0].ksfVersion).toBe(0);
  });

  test('a login-start response without ksf_version defaults to 1, the current registration KSF', async () => {
    const start = await signIn({ server_message: SERVER_MESSAGE, server_state: 's' });

    expect(start.ksf_version).toBe(1);
    expect(nativeFinishCalls).toHaveLength(1);
    expect(nativeFinishCalls[0].ksfVersion).toBe(1);
  });
});
