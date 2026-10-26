// @ts-nocheck
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
  return import(`./api?syncPagesTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('sync ops pagination (1990)', () => {
  test('all 2500 ops are fetched through the advertised head', async () => {
    const api = await loadFreshApi();
    for (const [from, to] of [[1, 1000], [1001, 2000], [2001, 2500]]) {
      fetchQueue.push(async () => jsonResponse({ ops: Array.from({length: to-from+1}, (_,i) => ({seq_id: from+i})), head_seq: 2500 }));
    }
    const ops = await api.getSyncOps(0);
    expect(ops.length).toBe(2500);
    expect(fetchCalls.map(x => new URL(x.url).searchParams.get('since'))).toEqual(['0','1000','2000']);
  });
  test('old servers without a head are paged while pages are full', async () => {
    const api = await loadFreshApi();
    fetchQueue.push(async () => jsonResponse({ops: Array.from({length:1000}, (_,i)=>({seq_id: i+1}))}));
    fetchQueue.push(async () => jsonResponse({ops:[{seq_id:1001}]}));
    expect((await api.getSyncOps(0)).length).toBe(1001);
  });
  test('an empty page below the head is refused, not accepted as caught up', async () => {
    const api = await loadFreshApi();
    fetchQueue.push(async () => jsonResponse({ops:[],head_seq:99}));
    await expect(api.getSyncOps(0)).rejects.toThrow();
  });
  test('a repeated page is refused instead of looping or returning partial data', async () => {
    const api = await loadFreshApi();
    fetchQueue.push(async () => jsonResponse({ops:[{seq_id:1}],head_seq:2}));
    fetchQueue.push(async () => jsonResponse({ops:[{seq_id:1}],head_seq:2}));
    await expect(api.getSyncOps(0)).rejects.toThrow();
  });
});
