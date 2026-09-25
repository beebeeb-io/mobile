// @ts-nocheck
/**
 * Task 1551 — request-path tests for the signup email-code step: proves the
 * ACTUAL HTTP calls `signupEmailStart`/`signupEmailVerify`/
 * `opaqueRegistrationStart`/`opaqueRegistrationFinish`/`signup` make, not
 * just the pure `withSignupTicket` helper in isolation. Mirrors
 * `api.account-deleted.test.ts`'s mock scaffold (mobile CLAUDE.md "Tests" —
 * every native module `api.ts` touches must be mocked per-file under the
 * isolated test runner).
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

// Fake OPAQUE native calls — this file is about the HTTP wire shape, not
// the OPAQUE protocol math (already covered by the ios KAT suite).
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  isNativeAvailable: true,
  opaqueRegistrationStart: async (_email: string, _password: string) => ({
    state: new Uint8Array([1, 2, 3]),
    message: new Uint8Array([4, 5, 6]),
  }),
  opaqueRegistrationFinish: async (_state: Uint8Array, _serverMessage: Uint8Array, _password: string) => ({
    record: new Uint8Array([7, 8, 9]),
  }),
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastBody(): Record<string, unknown> {
  const last = fetchCalls[fetchCalls.length - 1];
  return JSON.parse(last.init.body as string);
}

async function loadFreshApi() {
  return import(`./api?signupEmailCodeTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('signupEmailStart', () => {
  test('POSTs {email} to /api/v1/auth/signup/email-start, unauthenticated', async () => {
    fetchQueue.push(async () => jsonResponse({ message: 'ok' }, 202));
    const { signupEmailStart } = await loadFreshApi();

    const result = await signupEmailStart('guus@beebeeb.io');

    expect(result).toEqual({ message: 'ok' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://api.test/api/v1/auth/signup/email-start');
    expect(fetchCalls[0].init.method).toBe('POST');
    expect(lastBody()).toEqual({ email: 'guus@beebeeb.io' });
    // No Authorization header on this unauthenticated bootstrap call.
    expect((fetchCalls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('a 404 (server predates task 1525) surfaces as ApiError status 404 — the legacy-fallback signal', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'not found' }, 404));
    const { signupEmailStart, ApiError } = await loadFreshApi();
    const { isLegacyFallbackError } = await import('./signup-email-code');

    const err = await signupEmailStart('guus@beebeeb.io').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(isLegacyFallbackError(err)).toBe(true);
  });

  test('a 429 rate-limit is NOT treated as the legacy-fallback signal', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'Too many requests' }, 429));
    const { signupEmailStart } = await loadFreshApi();
    const { isLegacyFallbackError } = await import('./signup-email-code');

    const err = await signupEmailStart('guus@beebeeb.io').catch((caught) => caught);

    expect(err.status).toBe(429);
    expect(isLegacyFallbackError(err)).toBe(false);
  });
});

describe('signupEmailVerify', () => {
  test('POSTs {email, code} and returns the signup_ticket on success', async () => {
    fetchQueue.push(async () => jsonResponse({ signup_ticket: 'tkt_abc123' }, 200));
    const { signupEmailVerify } = await loadFreshApi();

    const result = await signupEmailVerify('guus@beebeeb.io', '12345678');

    expect(result).toEqual({ signup_ticket: 'tkt_abc123' });
    expect(fetchCalls[0].url).toBe('https://api.test/api/v1/auth/signup/email-verify');
    expect(lastBody()).toEqual({ email: 'guus@beebeeb.io', code: '12345678' });
  });

  test('a wrong/expired code is a 400 ApiError with the server\'s undifferentiated message', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'invalid or expired code' }, 400));
    const { signupEmailVerify, ApiError } = await loadFreshApi();

    const err = await signupEmailVerify('guus@beebeeb.io', '00000000').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('invalid or expired code');
  });
});

describe('opaqueRegistrationStart — ticket threading', () => {
  test('with a signupTicket: register-start body carries signup_ticket', async () => {
    fetchQueue.push(async () => jsonResponse({ server_message: Buffer.from([9]).toString('base64') }));
    const { opaqueRegistrationStart } = await loadFreshApi();

    await opaqueRegistrationStart('guus@beebeeb.io', 'hunter22', 'tkt_abc123');

    expect(fetchCalls[0].url).toBe('https://api.test/api/v1/opaque/register-start');
    const body = lastBody();
    expect(body.email).toBe('guus@beebeeb.io');
    expect(body.signup_ticket).toBe('tkt_abc123');
  });

  test('without a signupTicket: register-start body has NO signup_ticket key at all', async () => {
    fetchQueue.push(async () => jsonResponse({ server_message: Buffer.from([9]).toString('base64') }));
    const { opaqueRegistrationStart } = await loadFreshApi();

    await opaqueRegistrationStart('guus@beebeeb.io', 'hunter22');

    const body = lastBody();
    expect('signup_ticket' in body).toBe(false);
  });
});

describe('opaqueRegistrationFinish — ticket threading + signup_ticket_invalid', () => {
  test('with a signupTicket: register-finish body carries signup_ticket', async () => {
    fetchQueue.push(async () => jsonResponse({ session_token: 'sess_1' }));
    const { opaqueRegistrationFinish } = await loadFreshApi();

    await opaqueRegistrationFinish(
      'guus@beebeeb.io', 'hunter22', new Uint8Array([1]), new Uint8Array([2]),
      undefined, undefined, 'tkt_abc123',
    );

    expect(fetchCalls[0].url).toBe('https://api.test/api/v1/opaque/register-finish');
    const body = lastBody();
    expect(body.email).toBe('guus@beebeeb.io');
    expect(body.signup_ticket).toBe('tkt_abc123');
  });

  test('without a signupTicket: register-finish body has NO signup_ticket key — legacy/unflagged path unchanged', async () => {
    fetchQueue.push(async () => jsonResponse({ session_token: 'sess_1' }));
    const { opaqueRegistrationFinish } = await loadFreshApi();

    await opaqueRegistrationFinish(
      'guus@beebeeb.io', 'hunter22', new Uint8Array([1]), new Uint8Array([2]),
    );

    const body = lastBody();
    expect('signup_ticket' in body).toBe(false);
    // Session is still minted normally — the ticket is purely additive.
    expect(store.get('beebeeb_session_token')).toBe('sess_1');
  });

  test('the real server\'s 403 signup_ticket_invalid body (both error + human message) is recognized by isTicketInvalidError', async () => {
    // Exact body observed against a live server in this task's local smoke
    // test (server #95 head 3c5f706, BB_SIGNUP_EMAIL_CODE=1) — NOT the
    // bodyless-message shape an earlier version of this test assumed.
    fetchQueue.push(async () => jsonResponse(
      { error: 'signup_ticket_invalid', message: 'Verify your email again to get a new signup link.' },
      403,
    ));
    const { opaqueRegistrationFinish } = await loadFreshApi();
    const { isTicketInvalidError } = await import('./signup-email-code');

    const err = await opaqueRegistrationFinish(
      'guus@beebeeb.io', 'hunter22', new Uint8Array([1]), new Uint8Array([2]),
      undefined, undefined, 'tkt_expired',
    ).catch((caught) => caught);

    expect(err.status).toBe(403);
    // The human message is what ends up on .message — request() prefers it
    // over .error when both are present. isTicketInvalidError must not rely
    // on message content (see its doc comment) — it still recognizes this.
    expect(err.message).toBe('Verify your email again to get a new signup link.');
    expect(isTicketInvalidError(err)).toBe(true);
    // No session was minted on a rejected ticket.
    expect(store.has('beebeeb_session_token')).toBe(false);
  });
});

describe('legacy signup() — ticket threading', () => {
  test('with a signupTicket: /auth/signup body carries signup_ticket', async () => {
    fetchQueue.push(async () => jsonResponse({ user_id: 'u1', session_token: 'sess_1', salt: 's' }));
    const { signup } = await loadFreshApi();

    await signup('guus@beebeeb.io', 'hunter22', 'tkt_abc123');

    expect(fetchCalls[0].url).toBe('https://api.test/api/v1/auth/signup');
    const body = lastBody();
    expect(body.signup_ticket).toBe('tkt_abc123');
  });

  test('without a signupTicket: /auth/signup body is byte-for-byte the pre-1551 shape', async () => {
    fetchQueue.push(async () => jsonResponse({ user_id: 'u1', session_token: 'sess_1', salt: 's' }));
    const { signup } = await loadFreshApi();

    await signup('guus@beebeeb.io', 'hunter22');

    expect(lastBody()).toEqual({ email: 'guus@beebeeb.io', password: 'hunter22' });
  });
});
