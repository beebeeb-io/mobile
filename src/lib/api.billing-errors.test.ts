// @ts-nocheck
/**
 * Task 1540 finding 7 — a frozen/suspended billing account must see the
 * server's human-readable `message`, not the raw machine `error` code.
 *
 * Bug: `request()`'s generic error branch built `new ApiError(res.status,
 * err.error ?? err.message ?? res.statusText)` — preferring the machine code
 * over the human text whenever the server sends both (server
 * `beebeeb-api/src/error.rs`'s `BillingReadOnly`/`BillingSuspended` variants
 * always send both: `{"error":"billing_read_only","message":"Your account is
 * read-only due to an unpaid invoice. Update your payment method to restore
 * access."}`). `friendlyError()` has no special case for these codes, so a
 * 403 fell through to `return err.message || '...'`, which was literally the
 * string "billing_read_only".
 *
 * Same mock scaffold as `api.account-deleted.test.ts` (isolated per-file —
 * mobile/CLAUDE.md "Tests" — every native module `api.ts` touches is mocked
 * here too).
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
  opaqueLoginStart: async () => ({ state: new Uint8Array([1]), message: new Uint8Array([2]) }),
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

async function loadFreshApi() {
  return import(`./api?billingErrorsTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  store.set(TOKEN_KEY, 'session-token');
});

describe('finding 7: billing_read_only 403', () => {
  test('ApiError.message and friendlyError() both render the human message, not the raw code', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'billing_read_only',
      message: 'Your account is read-only due to an unpaid invoice. Update your payment method to restore access.',
    }, 403));

    const { ApiError, friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe(
      'Your account is read-only due to an unpaid invoice. Update your payment method to restore access.',
    );
    expect(err.message).not.toBe('billing_read_only');
    expect(friendlyError(err)).toBe(
      'Your account is read-only due to an unpaid invoice. Update your payment method to restore access.',
    );
  });
});

describe('finding 7: billing_suspended 403', () => {
  test('ApiError.message and friendlyError() both render the human message, not the raw code', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'billing_suspended',
      message: 'Your account is suspended due to an unpaid invoice. Update your payment method or export your data.',
    }, 403));

    const { ApiError, friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe(
      'Your account is suspended due to an unpaid invoice. Update your payment method or export your data.',
    );
    expect(err.message).not.toBe('billing_suspended');
    expect(friendlyError(err)).toBe(
      'Your account is suspended due to an unpaid invoice. Update your payment method or export your data.',
    );
  });
});

describe('finding 7 regression guard: a body with ONLY `error` (no `message`) must still surface it', () => {
  test('BadRequest {"error":"upload already completed"} — FilesScreen.tsx:2236 regexes err.message for this exact text', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'upload already completed' }, 400));

    const { ApiError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('upload already completed');
  });
});
