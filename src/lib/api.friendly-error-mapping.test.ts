// @ts-nocheck
/**
 * Task 1709 — raw error messages on failed sign-in (Guus, verbatim:
 * "Tijdens mislukte aanmeldingen raw error messages").
 *
 * The sign-in/sign-up surfaces render `friendlyError(err)` for every failure.
 * Three leak classes reach the UI today:
 *
 *   1. `friendlyError`'s 409/422/default branches return `err.message`
 *      verbatim — and `request()` fills that message with the server body's
 *      `error` field or `res.statusText` when no human `message` exists
 *      (e.g. 403 `account_suspended`, 404 `not found`, 400
 *      "invalid base64 client_message"). Bare machine codes and HTTP status
 *      words are displayed raw.
 *   2. `opaqueLoginStart` / `opaqueLoginFinish` re-throw RAW native (UniFFI)
 *      errors — a wrong password fails inside the native finish and its
 *      internal error text lands on LoginScreen verbatim.
 *   *   `NativeCryptoUnavailableError`'s internal message ("Native crypto
 *      module not available — cannot run opaqueLoginFinish. Use plain auth
 *      fallback.") is displayed raw.
 *
 * Fix: harden the ONE shared mapping layer (`friendlyError`) and map the
 * native OPAQUE failures to the same copy the server paths use, mirroring
 * `confirmAction`'s existing precedent and the web client's
 * `user-friendly-error.ts` (looksUserFriendly heuristic).
 *
 * Same mock scaffold as `api.billing-errors.test.ts` (isolated per-file —
 * mobile/CLAUDE.md "Tests" — every native module `api.ts` touches is mocked
 * here too).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
/** What the mocked native module throws — set per test. */
let nativeOpaqueStartError: Error | null = null;
let nativeOpaqueFinishError: Error | null = null;

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
  opaqueLoginStart: async () => {
    if (nativeOpaqueStartError) throw nativeOpaqueStartError;
    return { state: new Uint8Array([1]), message: new Uint8Array([2]) };
  },
  opaqueLoginFinish: async () => {
    if (nativeOpaqueFinishError) throw nativeOpaqueFinishError;
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

function jsonResponse(body: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?friendlyErrorMappingTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  nativeOpaqueStartError = null;
  nativeOpaqueFinishError = null;
  store.set(TOKEN_KEY, 'session-token');
});

// ---------------------------------------------------------------------------
// RED — the raw leaks (must map to honest copy)
// ---------------------------------------------------------------------------

describe('1709: bare machine codes never reach the UI', () => {
  test('403 {"error":"account_suspended"} (no message field) maps to suspended-account copy', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'account_suspended' }, 403));
    const { ApiError, friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    const shown = friendlyError(err);
    expect(shown).not.toBe('account_suspended');
    expect(shown).not.toMatch(/account_suspended/);
    expect(shown).toMatch(/[Ss]uspended/);
  });

  test('403 {"error":"forbidden"} (status word) maps to a permission line, not "forbidden"', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'forbidden' }, 403));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    const shown = friendlyError(err);
    expect(shown).not.toBe('forbidden');
    expect(shown).not.toMatch(/^forbidden$/i);
  });

  test('400 {"error":"invalid base64 client_message"} (internal fragment) never displays', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'invalid base64 client_message' }, 400));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    const shown = friendlyError(err);
    expect(shown).not.toMatch(/base64/);
    expect(shown.length).toBeGreaterThan(0);
  });

  test('404 {"error":"not found"} maps to "Not found.", not the bare body', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'not found' }, 404));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    const shown = friendlyError(err);
    expect(shown).toBe('Not found.');
  });

  test('non-JSON 500 body falls back to statusText — must be masked to the generic honest line', async () => {
    fetchQueue.push(async () => new Response('<html>oops</html>', {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'content-type': 'text/html' },
    }));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    const shown = friendlyError(err);
    expect(shown).not.toMatch(/Internal Server Error/);
    expect(shown).toBe('Something went wrong. Please try again.');
  });

  test('unknown ApiError with a bare machine-code message never displays it', async () => {
    const { ApiError, friendlyError } = await loadFreshApi();
    const shown = friendlyError(new ApiError(418, 'opaque_login_failed'));
    expect(shown).not.toMatch(/opaque_login_failed/);
    expect(shown).toBe('Something went wrong. Please try again.');
  });
});

describe('1709: native OPAQUE failures map to honest sign-in copy', () => {
  test('wrong password (native finish failure) shows "Wrong email or password." — not raw native text', async () => {
    nativeOpaqueFinishError = new Error('opaque protocol error: ServerAuthenticationError');
    const { ApiError, opaqueLoginFinish } = await loadFreshApi();
    const err = await opaqueLoginFinish(
      'user@beebeeb.io', 'pw', new Uint8Array([1]), new Uint8Array([2]), 'c3RhdGU=', 1,
    ).catch((caught) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Wrong email or password.');
  });

  test('native login-start failure maps to an honest client-side line — not raw native text', async () => {
    nativeOpaqueStartError = new Error('opaque protocol error: ClientStartFailed');
    const { ApiError, opaqueLoginStart } = await loadFreshApi();
    const err = await opaqueLoginStart('user@beebeeb.io', 'pw').catch((caught) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).not.toMatch(/opaque protocol error/);
    expect(err.message).toMatch(/[Ss]ign-in/);
  });

  test('NativeCryptoUnavailableError maps to an honest update line — not its internal message', async () => {
    const { NativeCryptoUnavailableError, friendlyError } = await loadFreshApi();
    const shown = friendlyError(new NativeCryptoUnavailableError('opaqueLoginFinish'));
    expect(shown).not.toMatch(/Native crypto module not available/);
    expect(shown).not.toMatch(/plain auth fallback/);
    expect(shown.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GREEN controls — honest human copy must keep flowing through
// (pins so the masking heuristic cannot overreach)
// ---------------------------------------------------------------------------

describe('1709: human messages still pass through unchanged', () => {
  test('403 account_disabled keeps the server\'s human sentence', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'account_disabled',
      message: 'This account has been disabled. Contact support if you believe this is in error.',
    }, 403));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    expect(friendlyError(err)).toBe(
      'This account has been disabled. Contact support if you believe this is in error.',
    );
  });

  test('403 email_unverified keeps the server\'s human sentence', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'email_unverified',
      message: 'Verify your email address to upload, share, or receive files. Check your inbox or request a new link.',
    }, 403));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    expect(friendlyError(err)).toBe(
      'Verify your email address to upload, share, or receive files. Check your inbox or request a new link.',
    );
  });

  test('409 human message ("A file with that name exists.") passes through', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'A file with that name exists.' }, 409));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    expect(friendlyError(err)).toBe('A file with that name exists.');
  });

  test('409 account_mismatch keeps the vault-key mismatch sentence', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'account_mismatch',
      message: 'This session does not match the account of the vault key on this device.',
    }, 409));
    const { ApiError, friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('account_mismatch');
    expect(friendlyError(err)).toBe(
      'This session does not match the account of the vault key on this device.',
    );
  });

  test('2FA wrong-code 401 keeps "Incorrect or expired code. Try again."', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'invalid_totp_code' }, 401));
    const { ApiError, friendlyError, completeTwoFactor } = await loadFreshApi();
    const err = await completeTwoFactor('partial-token', '000000').catch((caught) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Incorrect or expired code. Try again.');
    expect(friendlyError(err)).toBe('Incorrect or expired code. Try again.');
  });

  test('429 with Retry-After header keeps the formatted wait line', async () => {
    fetchQueue.push(async () => new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '45' },
    }));
    const { friendlyError, getMe } = await loadFreshApi();
    const err = await getMe().catch((caught) => caught);
    expect(friendlyError(err)).toBe('Too many attempts. Try again in about 45 seconds.');
  });

  test('network failure (TypeError) keeps the connection line', async () => {
    const { friendlyError } = await loadFreshApi();
    expect(friendlyError(new TypeError('Network request failed'))).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  test('client-authored sentence on an unknown status passes through', async () => {
    const { ApiError, friendlyError } = await loadFreshApi();
    expect(friendlyError(new ApiError(409, 'A share link with that name already exists.'))).toBe(
      'A share link with that name already exists.',
    );
  });
});
