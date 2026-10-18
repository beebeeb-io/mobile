// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1959 — the Photos tab's focus refresh must not re-download the whole
// vault index on every focus. Guus's TF239 app called GET /files/index 18
// times in 10 minutes (~2.4 s server time each on a 39,783-file vault) while
// a 163 MB upload ran: `PhotosScreen`'s useFocusEffect calls fetchPhotos ->
// getPhotoCandidates -> getFileIndex unconditionally, on every focus (tab
// switch back, Preview / ShareSheet / any modal closing).
//
// These tests drive the real call site (`getPhotoCandidates`, extracted
// verbatim from PhotosScreen.tsx) with the network mocked, and COUNT the
// /files/index requests.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

class MockApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let indexCalls: Array<string | undefined> = [];
let serverHash = 'h1';
let serverFiles: unknown[] = [];
let pending: Array<() => void> = [];
function releaseAll() { const p = pending; pending = []; for (const r of p) r(); }
let holdIndex = false;

mock.module('./api', () => ({
  ApiError: MockApiError,
  getAllImages: async () => [],
  getFileIndex: async (hash?: string) => {
    indexCalls.push(hash);
    if (holdIndex) await new Promise<void>((resolve) => { pending.push(resolve); });
    if (hash === serverHash) return { hash: serverHash, changed: false, count: serverFiles.length };
    return { hash: serverHash, changed: true, count: serverFiles.length, files: serverFiles };
  },
}));

let cache: { hash: string; files: unknown[]; storedAt: number; seq?: number } | null = null;
let cacheGeneration = 0;
mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => (cache ? { ...cache, files: [...cache.files] } : null),
  saveCachedFileIndex: async (hash: string, files: unknown[], storedAt = Date.now(), seq?: number) => {
    cache = { hash, files, storedAt, ...(seq !== undefined ? { seq } : {}) };
  },
  clearCachedFileIndex: async () => { cache = null; cacheGeneration += 1; },
  fileIndexCacheGeneration: () => cacheGeneration,
}));

const { getPhotoCandidates } = await import('./photo-index-source');
const loaderModule = await import('./file-index-loader').catch(() => null);

function photo(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name_encrypted: `${id}.jpg`,
    mime_type: 'image/jpeg',
    size_bytes: 1,
    is_folder: false,
    chunk_count: 1,
    created_at: '2026-10-18T03:38:00Z',
    updated_at: '2026-10-18T03:38:00Z',
    has_thumbnail: true,
    is_media: true,
    ...extra,
  };
}

beforeEach(() => {
  indexCalls = [];
  serverHash = 'h1';
  serverFiles = [photo('a'), photo('b')];
  cache = null;
  cacheGeneration = 0;
  holdIndex = false;
  pending = [];
  loaderModule?.resetFileIndexLoaderForTests?.();
});

describe('Photos focus refresh — /files/index burst (task 1959)', () => {
  test('50 focus refreshes during an upload cost ONE /files/index request, not 50', async () => {
    // Each iteration = one Photos focus while the upload runs. Between
    // focuses the sync client writes the new file through to the on-disk
    // cache (as sync-client.ts persistCacheNow does), keeping the hash it
    // found — so the cache is current without the server being asked.
    for (let i = 0; i < 50; i += 1) {
      const out = await getPhotoCandidates(undefined, new Set());
      expect(out.length).toBeGreaterThanOrEqual(2);
      // the upload of file i completes; the server's hash moves on
      serverHash = `h-after-${i}`;
      serverFiles = [...serverFiles, photo(`up-${i}`)];
      cache = { ...cache!, files: [...cache!.files, photo(`up-${i}`)], storedAt: Date.now() + i + 1, seq: i + 1 };
    }
    expect(indexCalls.length).toBe(1);
  });

  test('the fresh-window result still shows the files the sync client added', async () => {
    await getPhotoCandidates(undefined, new Set());
    cache = { ...cache!, files: [...cache!.files, photo('fresh-upload')], storedAt: cache!.storedAt + 1, seq: 7 };
    const out = await getPhotoCandidates(undefined, new Set());
    expect(out.map((f) => f.id).sort()).toEqual(['a', 'b', 'fresh-upload']);
    expect(indexCalls.length).toBe(1);
  });

  test('overlapping focuses while a request is in flight share it (5 callers, 1 request)', async () => {
    holdIndex = true;
    const calls = Array.from({ length: 5 }, () => getPhotoCandidates(undefined, new Set()));
    await new Promise((r) => setTimeout(r, 5));
    holdIndex = false;
    releaseAll();
    const results = await Promise.all(calls);
    for (const r of results) expect(r.map((f) => f.id).sort()).toEqual(['a', 'b']);
    expect(indexCalls.length).toBe(1);
  });

  test('pull-to-refresh (force) still asks the server, with the cached hash', async () => {
    await getPhotoCandidates(undefined, new Set());
    await getPhotoCandidates(undefined, new Set(), { force: true });
    expect(indexCalls).toEqual([undefined, 'h1']);
  });
});
