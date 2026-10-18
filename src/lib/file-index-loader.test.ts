// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1959 — unit tests for the /files/index coalescer (createFileIndexLoader
// with injected deps: no network, no disk, a fake clock).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The module's default singleton imports these; this file only uses the
// factory, but every native module must still be mocked here (isolated runner).
mock.module('./api', () => ({ getFileIndex: async () => { throw new Error('singleton not used here'); } }));
mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => null,
  saveCachedFileIndex: async () => {},
  fileIndexCacheGeneration: () => 0,
}));

const { createFileIndexLoader, mergeWithServerRows } = await import('./file-index-loader');

const WINDOW = 300_000;

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name_encrypted: `${id}-name`,
    size_bytes: 1,
    is_folder: false,
    chunk_count: 1,
    created_at: '2026-10-18T03:38:00Z',
    updated_at: '2026-10-18T03:38:00Z',
    ...extra,
  };
}

let clock = 0;
let generation = 0;
let cache = null;
let server = { hash: 's1', files: [row('a'), row('b')] };
let calls = [];
let failNext = null;
let hold = false;
let pending = [];

function makeLoader() {
  return createFileIndexLoader({
    fetchIndex: async (hash) => {
      calls.push(hash);
      if (hold) await new Promise((resolve) => pending.push(resolve));
      if (failNext) { const e = failNext; failNext = null; throw e; }
      if (hash === server.hash) return { hash: server.hash, changed: false, count: server.files.length };
      return { hash: server.hash, changed: true, count: server.files.length, files: server.files };
    },
    loadCache: async () => (cache ? { ...cache, files: [...cache.files] } : null),
    saveCache: async (hash, files, storedAt) => { cache = { hash, files, storedAt }; },
    cacheGeneration: () => generation,
    now: () => clock,
    revalidateMs: WINDOW,
  });
}

let loader;
beforeEach(() => {
  clock = 1_000;
  generation = 0;
  cache = null;
  server = { hash: 's1', files: [row('a'), row('b')] };
  calls = [];
  failNext = null;
  hold = false;
  pending = [];
  loader = makeLoader();
});

describe('createFileIndexLoader', () => {
  test('first load asks the server and caches the answer', async () => {
    const out = await loader.load();
    expect(calls).toEqual([undefined]);
    expect(out.source).toBe('network');
    expect(out.hash).toBe('s1');
    expect(out.files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(cache.hash).toBe('s1');
  });

  test('inside the window: no request; at the window: one request with the cached hash', async () => {
    await loader.load();
    clock += WINDOW - 1;
    expect((await loader.load()).source).toBe('cache');
    expect(calls.length).toBe(1);
    clock += 1;
    const out = await loader.load();
    expect(out.source).toBe('network');
    expect(calls).toEqual([undefined, 's1']);
  });

  test('force skips the window but joins a request already in flight', async () => {
    await loader.load();
    await loader.load({ force: true });
    expect(calls.length).toBe(2);

    hold = true;
    const a = loader.load({ force: true });
    const b = loader.load({ force: true });
    const c = loader.load();
    await new Promise((r) => setTimeout(r, 1));
    hold = false;
    for (const r of pending) r();
    await Promise.all([a, b, c]);
    expect(calls.length).toBe(3);
  });

  test('a failed request is not remembered: the next call asks again', async () => {
    failNext = new Error('offline');
    await expect(loader.load()).rejects.toThrow('offline');
    await loader.load();
    expect(calls.length).toBe(2);
  });

  test('a cleared cache (sign-out / account switch) is never treated as checked', async () => {
    await loader.load();
    generation += 1;
    cache = { hash: 'live-writethrough', files: [row('other-account')], storedAt: clock + 5 };
    const out = await loader.load();
    expect(out.source).toBe('network');
    expect(calls.length).toBe(2);
  });

  test('after a clear, even a cache carrying the checked hash is not trusted', async () => {
    await loader.load();
    generation += 1;
    cache = { ...cache, storedAt: clock + 5 };
    expect((await loader.load()).source).toBe('network');
    expect(calls.length).toBe(2);
  });

  test('five overlapping non-forced loads share one request', async () => {
    hold = true;
    const all = Array.from({ length: 5 }, () => loader.load());
    await new Promise((r) => setTimeout(r, 1));
    hold = false;
    for (const r of pending) r();
    await Promise.all(all);
    expect(calls.length).toBe(1);
  });

  test('a cache whose hash is not the one checked is not trusted', async () => {
    await loader.load();
    cache = { ...cache, hash: 'something-else' };
    expect((await loader.load()).source).toBe('network');
  });

  test('a sign-out during the request: the answer is neither cached nor remembered', async () => {
    hold = true;
    const p = loader.load();
    await new Promise((r) => setTimeout(r, 1));
    generation += 1;
    hold = false;
    for (const r of pending) r();
    await p;
    expect(cache).toBeNull();
    await loader.load();
    expect(calls.length).toBe(2);
  });

  test('inside the window, rows the sync write-through rewrote get their server-only fields back', async () => {
    server = {
      hash: 's1',
      files: [
        row('req', {
          file_request_id: 'fr-1',
          sender_ephemeral_pubkey: 'pk',
          wrapped_content_key: 'wck',
          blurhash: 'LKO2?U%2Tw=w',
          is_media: true,
          is_uploading: true,
          storage_location: { city: 'Falkenstein' },
        }),
        row('b'),
      ],
    };
    await loader.load();
    // sync-client persistCacheNow: same hash, new storedAt, rows rebuilt from
    // SyncNodes (server-only fields gone), a rename, a new file, a trash.
    cache = {
      hash: 's1',
      storedAt: clock + 10,
      files: [row('req', { name_encrypted: 'renamed', mime_type: null }), row('new-upload')],
    };
    const out = await loader.load();
    expect(out.source).toBe('cache');
    expect(out.files.map((f) => f.id)).toEqual(['req', 'new-upload']);
    const req = out.files[0];
    expect(req.name_encrypted).toBe('renamed');
    expect(req.file_request_id).toBe('fr-1');
    expect(req.sender_ephemeral_pubkey).toBe('pk');
    expect(req.wrapped_content_key).toBe('wck');
    expect(req.blurhash).toBe('LKO2?U%2Tw=w');
    expect(req.is_media).toBe(true);
    expect(req.storage_location).toEqual({ city: 'Falkenstein' });
    expect(req.is_uploading).toBeUndefined();
  });
});

describe('mergeWithServerRows', () => {
  test('cache row values win; undefined cache values do not erase server values', () => {
    const server = new Map([['x', row('x', { blurhash: 'B', share_count: 2 })]]);
    const out = mergeWithServerRows([row('x', { blurhash: undefined, share_count: 0 })], server);
    expect(out[0].blurhash).toBe('B');
    expect(out[0].share_count).toBe(0);
  });
});
