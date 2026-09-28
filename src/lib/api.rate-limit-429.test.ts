// @ts-nocheck
/**
 * Task 1591 bug 3 — signup hung after a 429.
 *
 * The server's signup limiter answers `429` with `Retry-After: 3600` (3 per
 * hour per IP). `rate-limited-fetch` paused the whole request bucket for that
 * long, so the user's next attempt sat in `sleep(3_600_000)` before it was
 * even sent: the Create-account button spun for minutes with no message.
 *
 * This drives the REAL `createRateLimitedFetch` (clock + sleep injected)
 * underneath the REAL `request()` path in api.ts, and asserts that every
 * attempt settles without a long silent wait and that the user is told when
 * to retry. Mutation evidence: task 1591 Notes.
 *
 * Task 1037 removed in-app signup (and `signupEmailStart`/`signupEmailVerify`).
 * The same behaviour is now driven through the other unauthenticated call in
 * the `auth` bucket, `login()`, with `getMe()` as the unrelated request.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const real = await import('./rate-limited-fetch?real=1591');

let now = 1_000_000;
const sleeps: number[] = [];
const sent: Array<{ url: string; at: number }> = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 200 });

const pacedFetch = real.createRateLimitedFetch({
  fetchImpl: async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    sent.push({ url, at: now });
    return respond(url);
  },
  now: () => now,
  sleep: async (ms) => { sleeps.push(ms); now += ms; },
});

mock.module('./rate-limited-fetch', () => ({
  ...real,
  rateLimitedFetch: pacedFetch,
}));
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
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  isNativeAvailable: true,
}));
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }));
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }));

const api = await import('./api?rate429=1591');

function tooMany(retryAfter: string): Response {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'Retry-After': retryAfter },
  });
}

beforeEach(() => {
  sleeps.length = 0;
  sent.length = 0;
});

describe('auth request after a long 429 lockout (Retry-After: 3600)', () => {
  test('every attempt settles at once and says when to retry', async () => {
    respond = () => tooMany('3600');

    const first = await api.login('a@beebeeb.io', 'pw').catch((e) => e);
    expect(first).toBeInstanceOf(api.ApiError);
    expect(first.status).toBe(429);
    expect(first.retryAfterSeconds).toBe(3600);
    expect(api.friendlyError(first)).toBe('Too many attempts. Try again in about 1 hour.');

    // The user retries after the message: the request must go out without
    // being held back for the lockout (it used to sleep 3_600_000 ms).
    const second = await api.login('a@beebeeb.io', 'pw').catch((e) => e);
    expect(second).toBeInstanceOf(api.ApiError);
    expect(second.status).toBe(429);
    expect(sent.length).toBe(2);
    expect(Math.max(0, ...sleeps)).toBeLessThanOrEqual(real.MAX_PACING_PAUSE_MS);
    expect(sent[1].at - sent[0].at).toBeLessThanOrEqual(real.MAX_PACING_PAUSE_MS);
  });

  test('the lockout does not stall unrelated requests in the same bucket', async () => {
    respond = (url) => (url.includes('/auth/login') ? tooMany('3600') : new Response('{"message":"ok"}', { status: 200 }));
    await api.login('b@beebeeb.io', 'pw').catch(() => {});
    const t0 = now;
    await api.getMe().catch(() => {});
    expect(now - t0).toBeLessThanOrEqual(real.MAX_PACING_PAUSE_MS);
  });
});

describe('short 429 pacing is still honoured', () => {
  test('Retry-After: 30 pauses the bucket for 30 s before the next request', async () => {
    let calls = 0;
    respond = () => (++calls === 1 ? tooMany('30') : new Response('{"message":"ok"}', { status: 200 }));
    await api.login('c@beebeeb.io', 'pw').catch(() => {});
    // The 200 body carries no session token, so login() itself rejects; only
    // the send times matter here.
    await api.login('c@beebeeb.io', 'pw').catch(() => {});
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(30_000);
  });
});

describe('friendlyError retry-after wording', () => {
  test('rounds up and pluralises', () => {
    expect(api.formatRetryAfter(1)).toBe('about 1 second');
    expect(api.formatRetryAfter(45)).toBe('about 45 seconds');
    expect(api.formatRetryAfter(61)).toBe('about 2 minutes');
    expect(api.formatRetryAfter(300)).toBe('about 5 minutes');
    expect(api.formatRetryAfter(3600)).toBe('about 1 hour');
    expect(api.formatRetryAfter(3601)).toBe('about 2 hours');
  });
  test('a 429 without Retry-After keeps the generic message', () => {
    expect(api.friendlyError(new api.ApiError(429, 'x'))).toBe('Too many requests. Wait a moment, then try again.');
  });
});
