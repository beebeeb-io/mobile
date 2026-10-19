// @ts-nocheck
/**
 * Task 2050 — region-by-country through the REAL `request()` path in api.ts:
 *  - `PUT /me/region` carries `region_strict` (PUT replaces the whole choice);
 *  - the 409 `region_unavailable_strict` upload refusal reaches the person as
 *    words that name the COUNTRY the server sent, never the deprecated `city`;
 *  - `trustLocation` names a country or "Europe", never a city.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const sent: Array<{ url: string; method: string; body: any }> = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 200 });

mock.module('./rate-limited-fetch', () => ({
  MAX_PACING_PAUSE_MS: 0,
  rateLimitedFetch: async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    return respond(url);
  },
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

const api = await import('./api?region2050=1');

beforeEach(() => {
  sent.length = 0;
  respond = () => new Response('{}', { status: 200 });
});

describe('PUT /me/region carries the strict flag', () => {
  test('a country with strict on', async () => {
    await api.setUserRegion('de', true);
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].url).toContain('/api/v1/me/region');
    expect(sent[0].body).toEqual({ preferred_region: 'de', region_strict: true });
  });

  test('strict defaults to false (PUT replaces the whole choice)', async () => {
    await api.setUserRegion('europe');
    expect(sent[0].body).toEqual({ preferred_region: 'europe', region_strict: false });
  });
});

describe('409 region_unavailable_strict names the country', () => {
  const refusal = () =>
    new Response(
      JSON.stringify({
        error: 'region_unavailable_strict',
        message: "Germany can't take new files right now, so this upload stopped. Your choice is set to only Germany. Try again later, or allow other EU data centers in Settings.",
        datacenter: 'de',
        country: 'Germany',
        country_code: 'DE',
        city: 'Germany',
        reason: 'full',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );

  test('the request error carries the code and the country', async () => {
    respond = refusal;
    const err = await api.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('region_unavailable_strict');
    expect(err.details).toEqual({ country: 'Germany' });
  });

  test('friendlyError says which country and what to do', async () => {
    respond = refusal;
    const err = await api.getMe().catch((e) => e);
    expect(api.friendlyError(err)).toBe(
      "Germany can't take new files right now, so this upload stopped. Your choice is set to only Germany. Try again later, or allow other EU countries in Settings.",
    );
  });

  test('another 409 is untouched by the strict wording', async () => {
    respond = () => new Response(JSON.stringify({ error: 'name_conflict', message: 'A file with that name already exists.' }), { status: 409 });
    const err = await api.getMe().catch((e) => e);
    expect(err.details).toBeUndefined();
    expect(api.friendlyError(err)).toBe('A file with that name already exists.');
  });

  test('a strict refusal that names no country still reads honestly', () => {
    const err = new api.ApiError(409, 'x', 'region_unavailable_strict');
    expect(api.friendlyError(err)).toMatch(/^Your chosen country can't take new files right now/);
  });
});

describe('trustLocation (upload activity, toasts)', () => {
  test('names "Europe" until the server names the file\'s country', () => {
    expect(api.trustLocation('pool-1')).toEqual({ region: 'Europe', place: 'Europe' });
    expect(api.trustLocation(undefined, { storage_location: null })).toEqual({ region: 'Europe', place: 'Europe' });
  });

  test('then the file\'s country, never the deprecated city', () => {
    expect(api.trustLocation('p', { storage_location: { country: 'Finland', country_code: 'FI', city: 'Helsinki' } })).toEqual({
      region: 'Europe',
      place: 'Finland',
    });
    expect(api.trustLocation('p', { storage_location: { city: 'Helsinki' } }).place).toBe('Europe');
  });
});
