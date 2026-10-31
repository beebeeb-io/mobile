// @ts-nocheck
import { beforeEach, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
let secureStoreGetQueue: Array<(key: string) => Promise<string | null>> = [];
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
  getItemAsync: async (key: string) => {
    const next = secureStoreGetQueue.shift();
    if (next) return next(key);
    return store.get(key) ?? null;
  },
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


const api = await import('./api');
beforeEach(() => { fetchCalls.length = 0; fetchQueue = []; });
function respondStatus(status: number, body: unknown) { fetchQueue.push(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); }

test('photoPreviewUrl points at the preview route', () => {
  expect(api.photoPreviewUrl('f1')).toBe('https://api.test/api/v1/files/f1/thumbnail/preview');
});

test('deletePhotoPreview sends DELETE to the preview route', async () => {
  respondStatus(200, {});
  await api.deletePhotoPreview('f1');
  expect(fetchCalls.at(-1)!.url).toBe('https://api.test/api/v1/files/f1/thumbnail/preview');
  expect(fetchCalls.at(-1)!.init.method).toBe('DELETE');
});

test('getPhotoPreviewSummary returns the body, and null on 404', async () => {
  const body = { count: 2, total_bytes: 10, by_setting: [{ format: 'heic', px: 2560, count: 2 }] };
  respondStatus(200, body);
  expect(await api.getPhotoPreviewSummary()).toEqual(body);
  expect(fetchCalls.at(-1)!.url).toBe('https://api.test/api/v1/files/previews/summary');
  respondStatus(404, { error: 'not_found' });
  expect(await api.getPhotoPreviewSummary()).toBeNull();
});

test('getPhotoPreviewSummary rethrows non-404 errors', async () => {
  respondStatus(500, { error: 'boom' });
  await expect(api.getPhotoPreviewSummary()).rejects.toThrow();
});

test('setPreferenceValue PUTs the object itself as the value', async () => {
  respondStatus(200, {});
  await api.setPreferenceValue('photo_previews', { enabled: true, format: 'heic', px: 2560 });
  const { url, init } = fetchCalls.at(-1)!;
  expect(url).toBe('https://api.test/api/v1/preferences/photo_previews');
  expect(init.method).toBe('PUT');
  expect(JSON.parse(init.body as string)).toEqual({ value: { enabled: true, format: 'heic', px: 2560 } });
});

test('getPreferenceValue returns an object value untouched', async () => {
  respondStatus(200, { key: 'photo_previews', value: { enabled: true, format: 'jpeg', px: 1920 } });
  expect(await api.getPreferenceValue('photo_previews')).toEqual({ enabled: true, format: 'jpeg', px: 1920 });
});

// The support flag is cached per module instance, so each case imports a fresh copy.
async function freshApi(tag: string) { return await import(`./api?${tag}`); }

test('serverSupportsPhotoPreviews is false on 404', async () => {
  const a = await freshApi('s404');
  respondStatus(404, { error: 'not_found' });
  expect(await a.serverSupportsPhotoPreviews()).toBe(false);
});

test('serverSupportsPhotoPreviews is false on 500 and not cached', async () => {
  const a = await freshApi('s500');
  respondStatus(500, { error: 'boom' });
  expect(await a.serverSupportsPhotoPreviews()).toBe(false);
  respondStatus(200, { count: 0, total_bytes: 0, by_setting: [] });
  expect(await a.serverSupportsPhotoPreviews()).toBe(true);
});

test('serverSupportsPhotoPreviews is false on a network error and not cached', async () => {
  const a = await freshApi('snet');
  fetchQueue.push(async () => { throw new Error('offline'); });
  expect(await a.serverSupportsPhotoPreviews()).toBe(false);
  respondStatus(200, { count: 0, total_bytes: 0, by_setting: [] });
  expect(await a.serverSupportsPhotoPreviews()).toBe(true);
});

test('serverSupportsPhotoPreviews is cached per session', async () => {
  respondStatus(200, { count: 0, total_bytes: 0, by_setting: [] });
  expect(await api.serverSupportsPhotoPreviews()).toBe(true);
  const n = fetchCalls.length;
  expect(await api.serverSupportsPhotoPreviews()).toBe(true);
  expect(fetchCalls.length).toBe(n);
});

test('getPreferenceValueStrict: unset reads as null, errors throw, lenient stays null', async () => {
  respondStatus(200, { key: 'photo_previews', value: { enabled: true } });
  expect(await api.getPreferenceValueStrict('photo_previews')).toEqual({ enabled: true });
  respondStatus(200, { key: 'photo_previews', value: null });
  expect(await api.getPreferenceValueStrict('photo_previews')).toBeNull();
  respondStatus(404, { error: 'not_found' });
  expect(await api.getPreferenceValueStrict('photo_previews')).toBeNull();
  respondStatus(500, { error: 'boom' });
  await expect(api.getPreferenceValueStrict('photo_previews')).rejects.toThrow();
  respondStatus(500, { error: 'boom' });
  expect(await api.getPreferenceValue('photo_previews')).toBeNull();
});
