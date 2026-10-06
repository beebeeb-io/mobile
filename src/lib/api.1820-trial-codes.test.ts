// @ts-nocheck
/**
 * Task 1820 (server task 1755): the no-card trial's typed 409/429 refusals through
 * the real `request()` path. App Store 3.1.x: the app shows account state only, so
 * the client maps by code and never prints server wording that points at buying
 * ("choose a plan", "Subscribe", "pay at checkout"). Same isolated-per-file mock
 * scaffold as api.1605-trial-cancelled.test.ts (mobile/CLAUDE.md "Tests").
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
  return import(`./api?trial1820Test=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  store.set(TOKEN_KEY, 'session-token');
});


const SERVER = {
  trial_previously_subscribed: 'A free trial is for accounts that have never subscribed. Choose a plan to continue.',
  trial_sharing_unavailable: 'Sharing starts with a plan. Your trial keeps your files private.',
  trial_share_limit_reached: 'A trial can hold 5 active share links. Revoke one, or choose a plan for more.',
  no_subscription_to_cancel: 'Your trial has no card and no subscription, so there is nothing to cancel and nothing will be charged. It ends by itself on its end date.',
  trial_convert_unavailable: 'A trial without a card converts by subscribing: choose a plan and pay at checkout.',
  trial_checkout_retired: 'Trials no longer need a card or iDEAL. Start your trial without one.',
};
const PURCHASE = /subscribe|subscription|upgrade|checkout|\bplans?\b|ideal|pay now|start your trial/i;

describe('Task 1820: the no-card trial 409 codes survive request() and map to purchase-free copy', () => {
  for (const [code, serverMessage] of Object.entries(SERVER)) {
    test(`409 ${code}: code kept, friendlyError is the authored sentence, never the server wording`, async () => {
      fetchQueue.push(async () => jsonResponse({ error: code, message: serverMessage }, 409));
      const { ApiError, friendlyError, createShare } = await loadFreshApi();
      const err = await createShare('file-1').catch((caught) => caught);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(code);
      const shown = friendlyError(err);
      expect(shown.length).toBeGreaterThan(20);
      expect(PURCHASE.test(shown), shown).toBe(false);
      expect(shown).not.toBe('Something went wrong. Please try again.');
      expect(shown).not.toBe(code);
    });
  }

  test('the same codes without a message field still map (no crash, no generic error)', async () => {
    const { ApiError, friendlyError } = await loadFreshApi();
    for (const code of Object.keys(SERVER)) {
      const shown = friendlyError(new ApiError(409, code, code));
      expect(shown).not.toBe('Something went wrong. Please try again.');
      expect(shown).not.toBe(code);
    }
  });

  test('429 trial_rate_limited keeps its code and says so', async () => {
    fetchQueue.push(async () => new Response(JSON.stringify({ error: 'trial_rate_limited', message: 'Too many free trials were started from your network today. Try again later.', retry_after: 3600 }), { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '3600' } }));
    const { friendlyError, createShare } = await loadFreshApi();
    const err = await createShare('file-1').catch((caught) => caught);
    expect(err.code).toBe('trial_rate_limited');
    expect(err.retryAfterSeconds).toBe(3600);
    expect(friendlyError(err)).toContain('trials');
  });

  test('a 409 that is not ours still gets no code (whitelist stays narrow)', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'trial_something_new', message: 'Brand new refusal.' }, 409));
    const { createShare } = await loadFreshApi();
    const err = await createShare('file-1').catch((caught) => caught);
    expect(err.code).toBeUndefined();
  });
});

describe('Task 1820: the trial storage cap names the cap the server sent', () => {
  test('413 quota_exceeded + is_trial_cap + limit_bytes 10 GB shows 10 GB', async () => {
    fetchQueue.push(async () => jsonResponse({ error: 'quota_exceeded', limit_bytes: 10_000_000_000, used_bytes: 10_000_000_000, is_trial_cap: true, message: "You've reached the 10 GB trial storage cap. Subscribe to unlock your full plan storage." }, 413));
    const { friendlyError, uploadFile } = await loadFreshApi();
    const err = await uploadFile({ name_encrypted: 'x', size_bytes: 10 }, new Blob([new Uint8Array(10)])).catch((caught) => caught);
    expect(err.status).toBe(413);
    expect(err.isTrialCap).toBe(true);
    expect(err.limitBytes).toBe(10_000_000_000);
    const shown = friendlyError(err);
    expect(shown).toContain('10 GB');
    expect(shown).not.toContain('25 GB');
    expect(PURCHASE.test(shown), shown).toBe(false);
  });
});
