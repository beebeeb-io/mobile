// @ts-nocheck
/**
 * Task 1870 — `uploadFile` (simple path, `POST /api/v1/files/upload`) retries a
 * `429 server_busy` after Retry-After and keeps today's error otherwise.
 * The helper's own timing contract is in `server-busy-retry.test.ts`; this
 * file proves the call site is wired through it and that the final error
 * carries `retryAfterSeconds`.
 *
 * Every native module is mocked here (isolated-runner rule).
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];
const rawFetchCalls: Array<{ url: string; init: RequestInit }> = [];

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
  default: { expoConfig: { version: '9.9.9', extra: { apiUrl: 'https://api.test' } } },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));
mock.module('expo-file-system/legacy', () => ({}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => true,
  planUploadChunksNative: () => ({ chunkSizeBytes: 4_194_304, chunkCount: 1 }),
  uploadChunksNative: async () => ({ chunksUploaded: 1, bytesUploaded: 0, bytesTotal: 0, cryptoBytesPerSec: 0 }),
}));
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }));
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));


function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
}
const busy = (n: number) => jsonResponse({ error: 'server_busy', message: 'The server is handling other large uploads right now.', retry_after: n }, 429, { 'Retry-After': String(n) });
const created = () => jsonResponse({ id: 'f1', name_encrypted: 'x' }, 201);

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function settle<T>(p: Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i++) {
    await flush();
    jest.advanceTimersByTime(30_000);
  }
  return p;
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  store.set('beebeeb_session_token', 'test-token');
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('1870 — uploadFile retries a 429 server_busy', () => {
  test('429 server_busy + Retry-After: 2, then 201 -> one retry after >= 2 s, with a fresh FormData each attempt', async () => {
    const api = await import('./api');
    fetchQueue.push(async () => busy(2), async () => created());
    const start = Date.now();
    const blob = new Blob([new Uint8Array(10)]);
    const p = api.uploadFile({ name_encrypted: 'x', size_bytes: 10 }, blob);
    await flush();
    expect(fetchCalls.length).toBe(1);
    jest.advanceTimersByTime(1999);
    await flush();
    expect(fetchCalls.length).toBe(1);
    jest.advanceTimersByTime(1);
    const entry = await p;
    expect(entry.id).toBe('f1');
    expect(fetchCalls.length).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(2000);
    expect(fetchCalls.every((c) => c.url === 'https://api.test/api/v1/files/upload' && c.init.method === 'POST')).toBe(true);
    // One-shot bodies are rebuilt: the two attempts did not share a FormData.
    expect(fetchCalls[0].init.body).not.toBe(fetchCalls[1].init.body);
    expect(fetchCalls[1].init.body.get('chunk_0')).toBeTruthy();
  });

  test('four server_busy -> the existing ApiError (status 429, code server_busy, server message) now carrying retryAfterSeconds', async () => {
    const api = await import('./api');
    fetchQueue.push(async () => busy(3), async () => busy(3), async () => busy(3), async () => busy(3), async () => created());
    const p = api.uploadFile({ name_encrypted: 'x', size_bytes: 10 }, new Blob([new Uint8Array(10)]));
    p.catch(() => {});
    await settle(p.catch(() => {}));
    await expect(p).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'server_busy',
      message: 'The server is handling other large uploads right now.',
      retryAfterSeconds: 3,
    });
    expect(fetchCalls.length).toBe(4);
  });

  test('429 upload_rate_limited -> not retried; same error as today (plus its Retry-After)', async () => {
    const api = await import('./api');
    fetchQueue.push(
      async () => jsonResponse({ error: 'upload_rate_limited', message: 'Too many uploads', retry_after: 2 }, 429, { 'Retry-After': '2' }),
      async () => created(),
    );
    const p = api.uploadFile({ name_encrypted: 'x', size_bytes: 10 }, new Blob([new Uint8Array(10)]));
    p.catch(() => {});
    await settle(p.catch(() => {}));
    await expect(p).rejects.toMatchObject({ status: 429, code: 'upload_rate_limited', message: 'Too many uploads', retryAfterSeconds: 2 });
    expect(fetchCalls.length).toBe(1);
  });

  test('a 500 is not retried', async () => {
    const api = await import('./api');
    fetchQueue.push(async () => jsonResponse({ error: 'internal' }, 500), async () => created());
    const p = api.uploadFile({ name_encrypted: 'x', size_bytes: 10 }, new Blob([new Uint8Array(10)]));
    p.catch(() => {});
    await settle(p.catch(() => {}));
    await expect(p).rejects.toMatchObject({ status: 500 });
    expect(fetchCalls.length).toBe(1);
  });
});
