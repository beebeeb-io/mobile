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
  cachedFileIndexEpoch: () => undefined,
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
    // Round 2 (Codex P1): it is not handed to the caller either.
    await expect(p).rejects.toMatchObject({ name: 'StaleAccountError' });
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

// ---------------------------------------------------------------------------
// Task 1959 round 2 (Codex P1 on PR #181, "Key in-flight requests by account
// generation"). Account A signs out while GET /files/index is pending and
// account B calls the loader before it settles. Before the fix B joined A's
// promise and got A's rows; the generation check only skipped the cache write.
// ---------------------------------------------------------------------------
describe('account generation (task 1959 round 2)', () => {
  // The server answers for the account whose token the request carried, i.e.
  // the account current when the request STARTED.
  const vaults = {
    A: { hash: 'sA', files: [row('a1'), row('a2')] },
    B: { hash: 'sB', files: [row('b1')] },
  };
  let account = 'A';
  let accountGen = 0;
  let accountId = 'user-A';
  let holdCache = false;
  let cachePending = [];

  function makeAccountLoader() {
    return createFileIndexLoader({
      fetchIndex: async (hash) => {
        const vault = vaults[account];
        calls.push(hash);
        if (hold) await new Promise((resolve) => pending.push(resolve));
        if (hash === vault.hash) return { hash: vault.hash, changed: false, count: vault.files.length };
        return { hash: vault.hash, changed: true, count: vault.files.length, files: vault.files };
      },
      loadCache: async () => {
        const snapshot = cache ? { ...cache, files: [...cache.files] } : null;
        if (holdCache) await new Promise((resolve) => cachePending.push(resolve));
        return snapshot;
      },
      saveCache: async (hash, files, storedAt) => { cache = { hash, files, storedAt }; },
      cacheGeneration: () => generation,
      accountEpoch: () => ({ generation: accountGen, accountId }),
      now: () => clock,
      revalidateMs: WINDOW,
    });
  }

  /** clearToken() (sign-out) then a sign-in as B: the account epoch moves at
   *  the start of clearToken, the cache generation when the cache is cleared. */
  function switchToB() {
    accountGen += 1;
    generation += 1;
    cache = null;
    account = 'B';
    accountId = 'user-B';
    accountGen += 1; // setToken(B)
  }

  const tick = () => new Promise((r) => setTimeout(r, 1));
  function release() {
    hold = false;
    for (const r of pending.splice(0)) r();
  }

  beforeEach(() => {
    account = 'A';
    accountGen = 0;
    accountId = 'user-A';
    holdCache = false;
    cachePending = [];
    loader = makeAccountLoader();
  });

  test('A signs out mid-request, B calls: B gets its own request and only its own rows', async () => {
    hold = true;
    const forA = loader.load();
    forA.catch(() => {});
    await tick();
    switchToB();
    const forB = loader.load();
    await tick();
    release();
    const outB = await forB;
    expect(outB.files.map((f) => f.id)).toEqual(['b1']);
    expect(outB.hash).toBe('sB');
    expect(calls.length).toBe(2);
  });

  test('a forced B call (the backup reconcile) does not join A\'s request either', async () => {
    hold = true;
    const forA = loader.load({ force: true });
    forA.catch(() => {});
    await tick();
    switchToB();
    const forB = loader.load({ force: true });
    await tick();
    release();
    expect((await forB).files.map((f) => f.id)).toEqual(['b1']);
  });

  test('the stale A request rejects for every A waiter and is never cached', async () => {
    hold = true;
    const first = loader.load();
    const second = loader.load({ force: true });
    first.catch(() => {});
    second.catch(() => {});
    await tick();
    switchToB();
    release();
    await expect(first).rejects.toMatchObject({ name: 'StaleAccountError' });
    await expect(second).rejects.toMatchObject({ name: 'StaleAccountError' });
    expect(cache).toBeNull();
  });

  test('an A caller whose cache read straddles the switch is rejected, not answered under B', async () => {
    cache = { hash: 'sA', files: [row('a1'), row('a2')], storedAt: clock };
    holdCache = true;
    const forA = loader.load();
    await tick();
    switchToB();
    holdCache = false;
    for (const r of cachePending.splice(0)) r();
    await expect(forA).rejects.toMatchObject({ name: 'StaleAccountError' });
    // Nothing was asked of the server on A's behalf under B's session.
    expect(calls.length).toBe(0);
  });

  test('the same with a fresh A window: the straddling caller is not served A\'s rows from the window', async () => {
    await loader.load();
    expect(calls.length).toBe(1);
    holdCache = true;
    const forA = loader.load();
    await tick();
    switchToB();
    holdCache = false;
    for (const r of cachePending.splice(0)) r();
    await expect(forA).rejects.toMatchObject({ name: 'StaleAccountError' });
    expect(calls.length).toBe(1);
  });

  test('a cache read under A that finishes after the switch never seeds B\'s request', async () => {
    // B's caller passes a cache it read before the switch (PhotosScreen reads
    // the cache, then calls the loader). The server would answer "unchanged"
    // only for B's own hash, but the loader must not even send A's.
    const stale = { hash: 'sA', files: [row('a1'), row('a2')], storedAt: clock };
    const tagEpoch = { generation: accountGen, accountId };
    switchToB();
    const out = await loader.load({ cached: stale, cachedEpoch: tagEpoch });
    expect(out.files.map((f) => f.id)).toEqual(['b1']);
    expect(calls).toEqual([undefined]);
  });

  test('the window is per account: B never gets A\'s checked rows from memory', async () => {
    await loader.load();
    expect(calls.length).toBe(1);
    switchToB();
    // B's sync write-through rewrites the cache under the same hash string
    // A's rows had (a contrived collision): still a network check for B.
    cache = { hash: 'sA', files: [row('b1')], storedAt: clock + 1 };
    const out = await loader.load();
    expect(out.source).toBe('network');
    expect(out.files.map((f) => f.id)).toEqual(['b1']);
    expect(loader.inspect().windowAccountId).toBe('user-B');
  });

  test('an account-id change with no generation change still counts as another account', async () => {
    hold = true;
    const forA = loader.load();
    forA.catch(() => {});
    await tick();
    account = 'B';
    accountId = 'user-B';
    const forB = loader.load();
    await tick();
    release();
    expect((await forB).files.map((f) => f.id)).toEqual(['b1']);
    await expect(forA).rejects.toMatchObject({ name: 'StaleAccountError' });
  });

  test('a lock (account id goes null) is the same account: no spurious rejection', async () => {
    hold = true;
    const p = loader.load();
    await tick();
    accountId = null;
    release();
    expect((await p).files.map((f) => f.id)).toEqual(['a1', 'a2']);
  });

  test('reset() (sign-out hook) drops the window and detaches the in-flight request', async () => {
    await loader.load();
    expect(loader.inspect().hasWindow).toBe(true);
    loader.reset();
    expect(loader.inspect()).toMatchObject({ hasWindow: false, inFlight: false });
  });
});

// Task 1959 round 3: the loader's cache write carries the WHOLE scope its
// request started under — the account epoch and the cache generation — so
// file-index-cache can drop it on either change at its turn in the queue.
describe('cache write scope (task 1959 round 3)', () => {
  test('saveCache receives the account epoch and cache generation the request started under', async () => {
    const scopes = [];
    const l = createFileIndexLoader({
      fetchIndex: async () => ({ hash: 's9', changed: true, count: 1, files: [row('x')] }),
      loadCache: async () => null,
      saveCache: async (_hash, _files, _storedAt, scope) => { scopes.push(scope); },
      cacheGeneration: () => 7,
      accountEpoch: () => ({ generation: 4, accountId: 'user-A' }),
      now: () => 0,
      revalidateMs: WINDOW,
    });
    await l.load();
    expect(scopes).toEqual([{ epoch: { generation: 4, accountId: 'user-A' }, generation: 7 }]);
  });
});

// Task 1959 round 4 (Codex P1 on PR #181): rows the sync write-through added
// inside the window have no `is_media`. Own uploads are classified locally;
// any other new file row makes a `revalidateUnclassified` caller ask once.
describe('new rows inside the window (task 1959 round 4)', () => {
  const media = (id) => row(id, { is_media: true });
  let own;
  let lookups;
  function makeClassifyingLoader() {
    return createFileIndexLoader({
      fetchIndex: async (hash) => {
        calls.push(hash);
        if (hold) await new Promise((resolve) => pending.push(resolve));
        if (hash === server.hash) return { hash: server.hash, changed: false, count: server.files.length };
        return { hash: server.hash, changed: true, count: server.files.length, files: server.files };
      },
      loadCache: async () => (cache ? { ...cache, files: [...cache.files] } : null),
      saveCache: async (hash, files, storedAt) => { cache = { hash, files, storedAt }; },
      cacheGeneration: () => generation,
      classifyLocally: async (ids) => {
        lookups.push([...ids]);
        return new Map(ids.filter((id) => own.has(id)).map((id) => [id, own.get(id)]));
      },
      now: () => clock,
      revalidateMs: WINDOW,
    });
  }
  // The sync write-through: same hash, new storedAt, the row without server fields.
  function writeThrough(...rows) {
    cache = { ...cache, files: [...cache.files, ...rows], storedAt: cache.storedAt + 1 };
  }

  beforeEach(() => {
    server = { hash: 's1', files: [media('a'), media('b')] };
    own = new Map();
    lookups = [];
    loader = makeClassifyingLoader();
  });

  test('an own upload gets is_media from the local record; no request', async () => {
    await loader.load({ revalidateUnclassified: true });
    own.set('mine', true);
    server = { hash: 's2', files: [...server.files, media('mine')] };
    writeThrough(row('mine'));
    const out = await loader.load({ revalidateUnclassified: true });
    expect(out.source).toBe('cache');
    expect(out.files.find((f) => f.id === 'mine').is_media).toBe(true);
    expect(calls.length).toBe(1);
  });

  test('a foreign new file row: a revalidateUnclassified caller asks once, with the hash; a plain caller does not', async () => {
    await loader.load({ revalidateUnclassified: true });
    server = { hash: 's2', files: [...server.files, media('theirs')] };
    writeThrough(row('theirs'));
    const plain = await loader.load();
    expect(plain.source).toBe('cache');
    expect(calls.length).toBe(1);
    const photos = await loader.load({ revalidateUnclassified: true });
    expect(photos.source).toBe('network');
    expect(photos.files.find((f) => f.id === 'theirs').is_media).toBe(true);
    expect(calls).toEqual([undefined, 's1']);
  });

  test('overlapping Photos focuses after a foreign arrival share ONE revalidation', async () => {
    await loader.load({ revalidateUnclassified: true });
    server = { hash: 's2', files: [...server.files, media('theirs')] };
    writeThrough(row('theirs'));
    hold = true;
    const loads = Array.from({ length: 5 }, () => loader.load({ revalidateUnclassified: true }));
    await new Promise((r) => setTimeout(r, 2));
    hold = false;
    for (const r of pending) r();
    const outs = await Promise.all(loads);
    for (const o of outs) expect(o.files.map((f) => f.id)).toContain('theirs');
    expect(calls.length).toBe(2);
  });

  test('a row the server does not list (hash unchanged) costs ONE extra request, then none', async () => {
    await loader.load({ revalidateUnclassified: true });
    // The sync tree has a node /files/index never returns; the server state
    // has not moved, so the cache keeps the checked hash 's1'.
    writeThrough(row('phantom'));
    await loader.load({ revalidateUnclassified: true });
    expect(calls).toEqual([undefined, 's1']);
    for (let i = 0; i < 10; i += 1) await loader.load({ revalidateUnclassified: true });
    expect(calls.length).toBe(2);
  });

  test('a new folder row is not a reason to ask (folders need no is_media)', async () => {
    await loader.load({ revalidateUnclassified: true });
    writeThrough(row('folder', { is_folder: true }));
    await loader.load({ revalidateUnclassified: true });
    expect(calls.length).toBe(1);
    expect(lookups).toEqual([]);
  });

  test('the local classification never overrides a server value', async () => {
    await loader.load({ revalidateUnclassified: true });
    own.set('a', false);
    writeThrough(row('own-new'));
    own.set('own-new', true);
    const out = await loader.load({ revalidateUnclassified: true });
    expect(out.files.find((f) => f.id === 'a').is_media).toBe(true);
    // Only the row without a server classification was looked up.
    expect(lookups).toEqual([['own-new']]);
  });

  test('a sign-out during the local lookup: the old account\'s caller is rejected', async () => {
    let acct = { generation: 0, accountId: 'A' };
    let releaseLookup;
    const l = createFileIndexLoader({
      fetchIndex: async (hash) => {
        calls.push(hash);
        return hash === server.hash ? { hash: server.hash, changed: false, count: 0 } : { hash: server.hash, changed: true, count: 0, files: server.files };
      },
      loadCache: async () => (cache ? { ...cache, files: [...cache.files] } : null),
      saveCache: async (hash, files, storedAt) => { cache = { hash, files, storedAt }; },
      cacheGeneration: () => generation,
      accountEpoch: () => acct,
      // The lookup KNOWS the row (an own upload), so no revalidation follows
      // that could reject on its own: only the check after the lookup can.
      classifyLocally: async (ids) => { await new Promise((r) => { releaseLookup = r; }); return new Map(ids.map((id) => [id, true])); },
      now: () => clock,
      revalidateMs: WINDOW,
    });
    await l.load({ revalidateUnclassified: true });
    writeThrough(row('mine'));
    const p = l.load({ revalidateUnclassified: true });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 1));
    acct = { generation: 1, accountId: 'B' };
    releaseLookup();
    await expect(p).rejects.toMatchObject({ name: 'StaleAccountError' });
    expect(calls.length).toBe(1);
  });
});
