// @ts-nocheck
/**
 * Task 1399 — request-builder test for `deleteAccountPermanently`.
 *
 * Mirrors the web client's `deleteAccountPermanently` (`repos/web/src/lib/api.ts`)
 * and the server contract (`repos/server/beebeeb-api/src/routes/account.rs`,
 * `delete_account`): `DELETE /api/v1/auth/account`, body `{confirmation}`,
 * step-up token in the `X-Confirm-Token` header. Asserts the exact method,
 * path, body, and header the server requires — a wrong header name or a
 * missing confirmation field would 400/403 in production without this test
 * ever catching it, since nothing else in the app calls this endpoint.
 *
 * Isolated per bun:test-per-file semantics (mobile/CLAUDE.md "Tests") — every
 * native module `api.ts` touches is mocked here, same scaffold as
 * `api-client-session.test.ts`.
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
  opaqueLoginStart: async () => { throw new Error('opaque not mocked in this test'); },
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
  return import(`./api?deleteAccountTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('deleteAccountPermanently', () => {
  test('sends DELETE /api/v1/auth/account with the confirmation body and X-Confirm-Token header', async () => {
    store.set(TOKEN_KEY, 'session-token');
    fetchQueue.push(async () => jsonResponse({
      message: 'account marked for deletion',
      shred_after: '2026-10-13T00:00:00Z',
    }));

    const { deleteAccountPermanently } = await loadFreshApi();
    const result = await deleteAccountPermanently('DELETE', 'confirm-token-abc');

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    expect(url).toBe('https://api.test/api/v1/auth/account');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ confirmation: 'DELETE' });
    expect((init.headers as Record<string, string>)['X-Confirm-Token']).toBe('confirm-token-abc');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    expect(result).toEqual({
      message: 'account marked for deletion',
      shred_after: '2026-10-13T00:00:00Z',
    });
  });

  test('a 403 from expired/wrong step-up surfaces as ApiError without retrying', async () => {
    store.set(TOKEN_KEY, 'session-token');
    fetchQueue.push(async () => jsonResponse({ error: 'confirmation_required' }, 403));

    const { ApiError, deleteAccountPermanently } = await loadFreshApi();
    const err = await deleteAccountPermanently('DELETE', 'stale-token').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(fetchCalls).toHaveLength(1);
  });
});
