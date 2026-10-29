// @ts-nocheck
// 1302 — after an upload finishes (esp. right after a relaunch), Drive briefly
// showed ONLY the just-uploaded file instead of the merged, server-truthful
// set. Root cause: SyncClient's tree is in-memory only (never persisted across
// process restarts) — see `start()` in sync-client.ts. A returning device
// (`lastSeq !== 0`) replayed only the ops since `lastSeq` onto a freshly
// EMPTY tree. Any op that TOUCHES a node adds/updates it, but a pre-existing
// file/folder that no op referenced since `lastSeq` is silently absent from
// the resulting tree — and the old "fall back to a snapshot only if the tree
// ends up empty" guard doesn't catch this, because the tree isn't empty (it
// has exactly the touched nodes, e.g. the file the user just uploaded).
// FilesScreen then trusts `sync.ready` + a non-empty `sync.children()` as the
// complete folder and renders that partial tree — and `persistCacheNow`
// write-through then stamps that same partial list onto the on-disk
// file-index cache, so even a relaunch shows the same broken state.
//
// The fix seeds the tree from the on-disk file-index cache (the last
// known-good FULL listing) before replaying catch-up ops, so ops land on a
// real base instead of nothing.
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — sync-client.ts's dependencies. Every test file must mock every
// native module it needs itself (task 0877 isolation).
// ---------------------------------------------------------------------------

const secureStore = new Map<string, string>();

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
  deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

mock.module('react-native', () => ({
  // 'android' so persistCacheNow's iOS-only File Provider write-through
  // never fires — irrelevant to this test and not otherwise mocked.
  Platform: { OS: 'android' },
  // Task 1686 — sync-client now imports AppState for the reconnect-pause
  // seam. A no-op subscription; the tests drive setSyncClientAppState
  // directly.
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));

mock.module('react-native-sse', () => ({
  default: class FakeEventSource {
    addEventListener() {}
    close() {}
  },
}));

let getSnapshotCalls = 0;
let getSnapshotImpl: () => Promise<{ seq_id: number; nodes: unknown[] }> = async () => {
  throw new Error('getSnapshot not stubbed for this test');
};
let getSyncOpsCalls: number[] = [];
let getSyncOpsImpl: (since: number) => Promise<unknown[]> = async () => [];

// Task 1667 round 13 (review item 1): the ops the client sent, with their
// device id.
const submittedOps: Array<{ client_op_id: string; device_id: string }> = [];

mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'session-token',
  getStreamToken: async () => ({ stream_token: 'tok', expires_at: '2099-01-01T00:00:00Z' }),
  submitSyncOps: async (ops: Array<{ client_op_id: string; device_id: string }>) => {
    submittedOps.push(...ops);
    return { applied: [], rejected: [] };
  },
  getSnapshot: async () => {
    getSnapshotCalls += 1;
    return getSnapshotImpl();
  },
  getSyncOps: async (since: number) => {
    getSyncOpsCalls.push(since);
    return getSyncOpsImpl(since);
  },
}));

let cachedIndex: { hash: string; files: unknown[]; storedAt: number; seq?: number } | null = null;
const savedIndexCalls: Array<{ hash: string; files: unknown[]; storedAt?: number; seq?: number }> = [];
// Task 1959 round 3: every scope the cache handed out, and the scope each
// write carried (kept apart from savedIndexCalls so its toEqual checks hold).
const issuedScopes: Array<{ id: number }> = [];
const savedScopes: unknown[] = [];

mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => cachedIndex,
  saveCachedFileIndex: async (hash: string, files: unknown[], storedAt?: number, seq?: number, scope?: unknown) => {
    savedIndexCalls.push({ hash, files, storedAt, seq });
    savedScopes.push(scope);
  },
  clearCachedFileIndex: async () => {},
  fileIndexCacheWriteScope: () => {
    const scope = { epoch: { generation: 0, accountId: null }, generation: 0, id: issuedScopes.length + 1 };
    issuedScopes.push(scope);
    return scope;
  },
}));

mock.module('./file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => {},
}));

// Round 13: reassignable, so a test can make the keychain unreadable.
let getDeviceIdImpl: () => Promise<string> = async () => 'device-1';
mock.module('./device-identity', () => ({
  getDeviceId: () => getDeviceIdImpl(),
}));

const { SyncClient, fileEntryToSyncNode } = await import('./sync-client');
// Task 1959 round 2. Absent before the fix (real module: dependency-free).
const epoch = await import('./account-epoch').catch(() => null);

function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name_encrypted: 'enc-name-1',
    size_bytes: 1234,
    is_folder: false,
    chunk_count: 3,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    parent_id: null,
    ...overrides,
  };
}

function syncNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node-1',
    name_encrypted: 'enc-node-1',
    parent_id: null,
    is_folder: false,
    size_bytes: 1,
    content_hash: null,
    version_number: 1,
    has_thumbnail: false,
    storage_pool_id: null,
    is_trashed: false,
    is_starred: false,
    chunk_count: 1,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  secureStore.clear();
  getSnapshotCalls = 0;
  getSyncOpsCalls = [];
  getSnapshotImpl = async () => {
    throw new Error('getSnapshot not stubbed for this test');
  };
  getSyncOpsImpl = async () => [];
  cachedIndex = null;
  savedIndexCalls.length = 0;
});

describe('SyncClient catch-up (task 1302)', () => {
  test('seeds the tree from the on-disk index cache before replaying ops — pre-existing files survive a relaunch that only replays a create op', async () => {
    secureStore.set('bb_sync_last_seq', '5');

    cachedIndex = {
      hash: 'old-hash',
      storedAt: Date.now(),
      seq: 5, // matches lastSeq — persistCacheNow wrote this cache AT lastSeq.
      files: [
        fileEntry({ id: 'old-1', name_encrypted: 'enc-old-1' }),
        fileEntry({ id: 'old-2', name_encrypted: 'enc-old-2' }),
      ],
    };

    // The ONLY op the device missed is its own just-completed upload's
    // file_create echo — exactly the real-world trigger (relaunch, then
    // immediately upload).
    getSyncOpsImpl = async () => [
      {
        seq_id: 6,
        op_type: 'file_create',
        payload: {
          id: 'new-1',
          name_encrypted: 'enc-new-1',
          parent_id: null,
          size_bytes: 42,
          chunk_count: 1,
        },
      },
    ];

    const client = new SyncClient();
    await client.start();

    const ids = client.getAllNodes().map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['new-1', 'old-1', 'old-2']);

    const rootChildren = client.getChildren(null).map((n: { id: string }) => n.id).sort();
    expect(rootChildren).toEqual(['new-1', 'old-1', 'old-2']);

    // A real snapshot fetch was never needed — the cache supplied the base.
    expect(getSnapshotCalls).toBe(0);
    expect(getSyncOpsCalls).toEqual([5]);
  });

  test('falls back to a full snapshot when there is no cache at all (existing empty-tree guard, generalized)', async () => {
    secureStore.set('bb_sync_last_seq', '5');
    cachedIndex = null;
    getSnapshotImpl = async () => ({ seq_id: 10, nodes: [syncNode({ id: 'snap-1' })] });

    const client = new SyncClient();
    await client.start();

    expect(getSnapshotCalls).toBe(1);
    // No cache to safely seed from — the (unsafe) ops-only path is never
    // even attempted.
    expect(getSyncOpsCalls).toEqual([]);
    expect(client.getAllNodes().map((n: { id: string }) => n.id)).toEqual(['snap-1']);
  });

  test('a fresh device (lastSeq === 0) always loads the full snapshot, cache or not', async () => {
    // No bb_sync_last_seq set → loadLastSeq() returns 0.
    cachedIndex = { hash: 'stale-hash', storedAt: Date.now(), seq: 1, files: [fileEntry({ id: 'stale-1' })] };
    getSnapshotImpl = async () => ({ seq_id: 1, nodes: [syncNode({ id: 'fresh-1' })] });

    const client = new SyncClient();
    await client.start();

    expect(getSnapshotCalls).toBe(1);
    expect(getSyncOpsCalls).toEqual([]);
    expect(client.getAllNodes().map((n: { id: string }) => n.id)).toEqual(['fresh-1']);
  });

  // --- Codex review on PR #103 (two P1s) ---------------------------------

  test('startup failures back off until the stream successfully opens', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    globalThis.setTimeout = ((fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    const client = new SyncClient();
    try {
      getSnapshotImpl = async () => { throw new Error('outage'); };
      await expect(client.start()).rejects.toThrow('outage');
      const delays = [timers[0].ms];
      for (let cycle = 0; cycle < 2; cycle++) {
        timers[cycle].fn();
        for (let tick = 0; tick < 100 && timers.length < cycle + 2; tick++) await Promise.resolve();
        expect(timers.length).toBe(cycle + 2);
        delays.push(timers[cycle + 1].ms);
      }
      expect(getSnapshotCalls).toBe(3);
      expect(delays[0]).toBeGreaterThanOrEqual(1200);
      expect(delays[0]).toBeLessThanOrEqual(1800);
      expect(delays[1]).toBeGreaterThanOrEqual(2400);
      expect(delays[1]).toBeLessThanOrEqual(3600);
      expect(delays[2]).toBeGreaterThanOrEqual(4800);
      expect(delays[2]).toBeLessThanOrEqual(7200);
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('rebuild applies a pending create echo missing from the older cache', async () => {
    secureStore.set('bb_sync_last_seq', '6');
    secureStore.set('bb_sync_pending_ops', JSON.stringify([{
      client_op_id: 'pending-create', op_type: 'file_create',
      payload: { id: 'new-1', name_encrypted: 'enc-new-1' },
    }]));
    cachedIndex = { hash: 'old', storedAt: Date.now(), seq: 5, files: [fileEntry({ id: 'old-1' })] };
    getSyncOpsImpl = async () => [{
      seq_id: 7, client_op_id: 'pending-create', op_type: 'file_create',
      payload: { id: 'new-1', name_encrypted: 'enc-new-1' },
    }];
    const client = new SyncClient();
    try {
      await client.start();
      expect(client.getAllNodes().map(n => n.id).sort()).toEqual(['new-1', 'old-1']);
      expect(getSyncOpsCalls).toEqual([5]);
      expect(secureStore.get('bb_sync_last_seq')).toBe('7');
      expect(JSON.parse(secureStore.get('bb_sync_pending_ops')!)).toEqual([]);
      expect(getSnapshotCalls).toBe(0);
    } finally {
      client.stop();
    }
  });

  test('replays the debounce gap from the stamped cache cursor without losing an already-checkpointed create', async () => {
    secureStore.set('bb_sync_last_seq', '6');
    cachedIndex = {
      hash: 'stale-cursor-hash',
      storedAt: Date.now(),
      // Behind lastSeq=6: an op with seq_id 5 (e.g. a file_create for
      // 'mid-1') was applied and its lastSeq persisted synchronously, but
      // the app was killed before persistCacheNow's debounced write caught
      // up — so the cache still reflects state as of seq 4.
      seq: 4,
      files: [
        fileEntry({ id: 'old-1', name_encrypted: 'enc-old-1' }),
        fileEntry({ id: 'old-2', name_encrypted: 'enc-old-2' }),
      ],
    };
    // getSyncOps(6) only returns ops AFTER 6 — 'mid-1' (seq 5) is already
    // Re-request from the stamped cache cursor so the gap is replayed.
    getSyncOpsImpl = async (since) => since < 5 ? [
      { seq_id: 5, op_type: 'file_create', payload: { id: 'mid-1', name_encrypted: 'enc-mid-1' } },
    ] : [];
    getSnapshotImpl = async () => ({
      seq_id: 6,
      nodes: [syncNode({ id: 'old-1' }), syncNode({ id: 'old-2' }), syncNode({ id: 'mid-1' })],
    });

    const client = new SyncClient();
    await client.start();

    // Task 1990: replay from the cache's cursor, rather than skipping the gap.
    expect(getSnapshotCalls).toBe(0);
    expect(getSyncOpsCalls).toEqual([4]);
    const ids = client.getAllNodes().map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['mid-1', 'old-1', 'old-2']);
  });

  test('escalates to a full snapshot when a catch-up op targets a node missing from the seeded tree (a tombstone the cache excluded)', async () => {
    secureStore.set('bb_sync_last_seq', '5');
    cachedIndex = {
      hash: 'cursor-matched-hash',
      storedAt: Date.now(),
      seq: 5, // matches lastSeq — normally eligible to seed.
      files: [
        fileEntry({ id: 'old-1' }),
        fileEntry({ id: 'old-2' }),
        // 'trashed-1' was already trashed as of this cache snapshot, so
        // /files/index (the cache's source) excluded it — no tombstone was
        // ever cached for it.
      ],
    };
    getSyncOpsImpl = async () => [
      { seq_id: 6, op_type: 'file_restore', payload: { id: 'trashed-1' } },
    ];
    getSnapshotImpl = async () => ({
      seq_id: 6,
      nodes: [syncNode({ id: 'old-1' }), syncNode({ id: 'old-2' }), syncNode({ id: 'trashed-1' })],
    });

    const client = new SyncClient();
    await client.start();

    expect(getSnapshotCalls).toBe(1);
    const ids = client.getAllNodes().map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['old-1', 'old-2', 'trashed-1']);
  });

  test('does NOT escalate to a snapshot for an ordinary catch-up that only creates/updates nodes already covered by the seed', async () => {
    // Regression guard: opTargetsNodeMissingFromTree must not false-positive
    // on the common, correct path (would silently defeat the whole
    // optimization if it did).
    secureStore.set('bb_sync_last_seq', '5');
    cachedIndex = {
      hash: 'cursor-matched-hash-2',
      storedAt: Date.now(),
      seq: 5,
      files: [fileEntry({ id: 'old-1' })],
    };
    getSyncOpsImpl = async () => [
      { seq_id: 6, op_type: 'file_create', payload: { id: 'new-1', parent_id: null, name_encrypted: 'enc-new-1' } },
      { seq_id: 7, op_type: 'file_rename', payload: { id: 'old-1', new_name_encrypted: 'enc-renamed' } },
    ];

    const client = new SyncClient();
    await client.start();

    expect(getSnapshotCalls).toBe(0);
    const ids = client.getAllNodes().map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['new-1', 'old-1']);
    expect(client.getNode('old-1')?.name_encrypted).toBe('enc-renamed');
  });
});

describe('fileEntryToSyncNode (task 1302)', () => {
  test('maps required fields straight through', () => {
    const node = fileEntryToSyncNode(fileEntry({
      id: 'f1',
      name_encrypted: 'enc-f1',
      parent_id: 'parent-1',
      is_folder: true,
      size_bytes: 999,
      chunk_count: 7,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }));

    expect(node.id).toBe('f1');
    expect(node.name_encrypted).toBe('enc-f1');
    expect(node.parent_id).toBe('parent-1');
    expect(node.is_folder).toBe(true);
    expect(node.size_bytes).toBe(999);
    expect(node.chunk_count).toBe(7);
    expect(node.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(node.updated_at).toBe('2026-01-02T00:00:00.000Z');
  });

  test('fills in safe defaults for fields the cache does not carry', () => {
    const node = fileEntryToSyncNode(fileEntry({ parent_id: undefined }));

    // The cache's source (/files/index) already excludes trashed rows.
    expect(node.is_trashed).toBe(false);
    // Metadata-only, unused by any op-application path a seeded node needs.
    expect(node.content_hash).toBeNull();
    expect(node.parent_id).toBeNull();
    expect(node.has_thumbnail).toBe(false);
    expect(node.is_starred).toBe(false);
    expect(node.version_number).toBe(1);
    expect(node.storage_pool_id).toBeNull();
    expect(node.mime_type).toBeNull();
  });

  test('preserves explicit non-default values instead of overwriting with defaults', () => {
    const node = fileEntryToSyncNode(fileEntry({
      has_thumbnail: true,
      is_starred: true,
      version_number: 4,
      storage_pool_id: 'pool-2',
      mime_type: 'image/png',
    }));

    expect(node.has_thumbnail).toBe(true);
    expect(node.is_starred).toBe(true);
    expect(node.version_number).toBe(4);
    expect(node.storage_pool_id).toBe('pool-2');
    expect(node.mime_type).toBe('image/png');
  });
});

// Task 1959 round 2 (Codex P1 on PR #181, audit of the cache-rows class):
// SyncProvider stops the client when `user` goes null, which is AFTER
// logout() -> clearToken() has cleared the index cache. stop() flushes a
// pending write-through, which wrote the signed-out account's tree back to
// disk, where the next account's Photos tab rendered it as its cached index.
describe('SyncClient write-through across a sign-out (task 1959 round 2)', () => {
  test('a stop() after sign-out does not write the signed-out account\'s tree to the index cache', async () => {
    getSnapshotImpl = async () => ({ seq_id: 3, nodes: [syncNode({ id: 'a1', name_encrypted: 'enc-a1' })] });
    const client = new SyncClient();
    await client.start();
    savedIndexCalls.length = 0;

    // An op within the ~800 ms debounce before sign-out.
    client.applyLocalOp('file_rename', { id: 'a1', name_encrypted: 'enc-a1-renamed' });
    // logout() -> clearToken(): the account epoch moves and the cache is cleared.
    epoch?.advanceAccountEpoch();
    // SyncProvider's effect sees user === null.
    client.stop();
    await new Promise((r) => setTimeout(r, 5));

    expect(savedIndexCalls).toEqual([]);
  });

  test('without a sign-out the stop() flush still writes (unchanged behaviour)', async () => {
    getSnapshotImpl = async () => ({ seq_id: 3, nodes: [syncNode({ id: 'a1', name_encrypted: 'enc-a1' })] });
    const client = new SyncClient();
    await client.start();
    savedIndexCalls.length = 0;
    client.applyLocalOp('file_rename', { id: 'a1', name_encrypted: 'enc-a1-renamed' });
    client.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(savedIndexCalls.length).toBe(1);
  });

  // Task 1959 round 3: the write-through writes under the scope captured when
  // the client was created (its account), never one captured at write time.
  test('the write-through carries the cache write scope captured at construction', async () => {
    getSnapshotImpl = async () => ({ seq_id: 3, nodes: [syncNode({ id: 'a1', name_encrypted: 'enc-a1' })] });
    issuedScopes.length = 0;
    const client = new SyncClient();
    const constructionScope = issuedScopes[0];
    expect(constructionScope).toBeDefined();
    await client.start();
    savedScopes.length = 0;
    client.applyLocalOp('file_rename', { id: 'a1', name_encrypted: 'enc-a1-renamed' });
    client.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(savedScopes.length).toBe(1);
    expect(savedScopes[0]).toBe(constructionScope);
  });
});

// Task 1667 round 13 (review of mobile#182 at a19037f9, item 1, sweep of
// every getDeviceId() caller): getDeviceId() now REJECTS while the keychain
// cannot be read, instead of minting a throwaway id. The sync client must
// still start (not fail the whole sync engine), and must never send an op
// with a made-up or empty origin: the op stays pending until the id reads.
describe('SyncClient with an unreadable device id (task 1667 round 13)', () => {
  test('start succeeds; ops wait for the device id instead of carrying a made-up one', async () => {
    secureStore.set('bb_sync_last_seq', '0');
    getSnapshotImpl = async () => ({ seq_id: 1, nodes: [] });
    submittedOps.length = 0;
    let unreadable = true;
    getDeviceIdImpl = async () => {
      if (unreadable) {
        const err = new Error('device id unavailable: the secure storage read failed');
        err.name = 'DeviceIdUnavailableError';
        throw err;
      }
      return 'device-real';
    };
    try {
      const client = new SyncClient();
      await client.start(); // must not throw
      const r = await client.submitOp('folder_create', { id: 'f-1', name_encrypted: 'n', parent_id: null });
      expect(r.accepted).toBe(true); // optimistic, kept pending
      expect(submittedOps).toEqual([]); // nothing sent without the real id

      unreadable = false;
      await client.submitOp('folder_create', { id: 'f-2', name_encrypted: 'n2', parent_id: null });
      expect(submittedOps.length).toBeGreaterThan(0);
      expect(submittedOps.every((op) => op.device_id === 'device-real')).toBe(true);
      client.stop();
    } finally {
      getDeviceIdImpl = async () => 'device-1';
    }
  });
});

 describe('1990 sync cursor persistence', () => {
  test('metadata-only remote updates persist a matching cache and avoid a cold snapshot', async () => {
    secureStore.set('bb_sync_last_seq', '5');
    cachedIndex = { hash: 'h', storedAt: 1, seq: 5, files: [fileEntry()] };
    getSyncOpsImpl = async (since) => since < 6 ? [{ seq_id: 6, op_type: 'file_update', payload: { id: 'file-1', size_bytes: 999 } }] : [];
    const first = new SyncClient(); await first.start(); first.stop();
    for (let i=0;i<40;i++) await Promise.resolve();
    const saved = savedIndexCalls.at(-1);
    expect(saved?.seq).toBe(6);
    expect(saved?.files[0].size_bytes).toBe(999);
    cachedIndex = saved;
    const second = new SyncClient(); await second.start(); second.stop();
    expect(getSnapshotCalls).toBe(0);
  });
  test('a stamped empty tree is a valid returning-device cache', async () => {
    secureStore.set('bb_sync_last_seq', '5'); cachedIndex = { hash:'h', storedAt:1, seq:5, files:[] };
    const client = new SyncClient(); await client.start(); client.stop();
    expect(getSnapshotCalls).toBe(0); expect(client.getAllNodes()).toEqual([]);
  });
  test('a debounce gap replays from the cached cursor instead of taking a snapshot', async () => {
    secureStore.set('bb_sync_last_seq', '6'); cachedIndex = { hash:'h', storedAt:1, seq:5, files:[fileEntry()] };
    getSyncOpsImpl = async () => [{seq_id:6,op_type:'file_update',payload:{id:'file-1',size_bytes:9}}];
    const client = new SyncClient(); await client.start(); client.stop();
    expect(getSyncOpsCalls).toEqual([5]); expect(getSnapshotCalls).toBe(0);
    expect(client.getNode('file-1')?.size_bytes).toBe(9);
  });
});

// PR #199: failed startup must preserve the complete cache across its debounce.
test('failed restore snapshot cannot stamp an incomplete tree before retry', async () => {
  secureStore.set('bb_sync_last_seq', '5');
  cachedIndex = { hash: 'complete', storedAt: Date.now(), seq: 5, files: [fileEntry({ id: 'old-1' })] };
  getSyncOpsImpl = async (since) => since < 6 ? [
    { seq_id: 6, op_type: 'file_restore', payload: { id: 'restored-1' } },
  ] : [];
  getSnapshotImpl = async () => { throw new Error('snapshot temporarily unavailable'); };
  const client = new SyncClient();
  try {
    await expect(client.start()).rejects.toThrow('snapshot temporarily unavailable');
    // Longer than the 800ms cache debounce, shorter than the reconnect floor.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(savedIndexCalls).toHaveLength(0);
    getSnapshotImpl = async () => ({ seq_id: 6, nodes: [syncNode({ id: 'old-1' }), syncNode({ id: 'restored-1' })] });
    await client.reconnect();
    expect(getSnapshotCalls).toBe(2);
    expect(getSyncOpsCalls).toEqual([5, 5]);
    expect(client.getNode('restored-1')).toBeDefined();
    await client.persistCacheNow();
    expect(savedIndexCalls.at(-1)?.seq).toBe(6);
    expect(savedIndexCalls.at(-1)?.files.map((file) => file.id).sort()).toEqual(['old-1', 'restored-1']);
  } finally { client.stop(); }
});

const signedInUser = { id: 'user-1' };
mock.module('./auth', () => ({ useAuth: () => ({ user: signedInUser }) }));
mock.module('./delete-cascade', () => ({ onFilesDeleted: async () => {} }));

test('SyncProvider becomes ready after its rejected startup recovers without a snapshot', async () => {
  const React = await import('react');
  const { default: TestRenderer, act } = await import('react-test-renderer');
  const { SyncProvider, useSync } = await import('./sync-context');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  secureStore.set('bb_sync_last_seq', '5');
  cachedIndex = { hash: 'complete', storedAt: Date.now(), seq: 5, files: [fileEntry()] };
  let attempts = 0;
  getSyncOpsImpl = async () => {
    if (++attempts === 1) throw new Error('temporary catch-up failure');
    return [];
  };
  let latest;
  let client;
  const realStart = SyncClient.prototype.start;
  const start = spyOn(SyncClient.prototype, 'start').mockImplementation(function () {
    client = this;
    return realStart.call(this);
  });
  function Consumer() { latest = useSync(); return null; }
  let renderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SyncProvider, null, React.createElement(Consumer)));
    });
    expect(latest.ready).toBe(false);
    expect(latest.error?.message).toBe('temporary catch-up failure');
    await act(async () => { await client.reconnect(); });
    expect(getSyncOpsCalls).toEqual([5, 5]);
    expect(getSnapshotCalls).toBe(0);
    expect(latest.ready).toBe(true);
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeNull();
    expect(latest.allNodes()).toHaveLength(1);
  } finally {
    await act(async () => { renderer?.unmount(); });
    start.mockRestore();
  }
});

// 2236: metadata encrypted to the request content key must retain its routing
// envelope across cache seeding, snapshot persistence and incoming create ops.
const requestEnvelope2236 = {
  file_request_id: 'request-2236', sender_ephemeral_pubkey: 'ephemeral-2236', wrapped_content_key: 'wrapped-2236',
};
test('2236 request envelope survives cache -> sync -> persisted cache', async () => {
  secureStore.set('bb_sync_last_seq', '5');
  cachedIndex = {hash:'h', storedAt:1, seq:5, files:[fileEntry(requestEnvelope2236)]};
  getSyncOpsImpl = async (since) => since < 6 ? [{seq_id:6,op_type:'file_update',payload:{id:'file-1',size_bytes:1235}}] : [];
  const client = new SyncClient();
  try {
    await client.start();
    expect(client.getNode('file-1')).toMatchObject(requestEnvelope2236);
    await client.persistCacheNow();
    expect(savedIndexCalls.at(-1)?.files[0]).toMatchObject(requestEnvelope2236);
  } finally { client.stop(); }
});
test('2236 request envelope survives a snapshot -> persisted cache', async () => {
  getSnapshotImpl = async () => ({seq_id:5,nodes:[syncNode(requestEnvelope2236)]});
  const client = new SyncClient();
  try {
    await client.start(); await client.persistCacheNow();
    expect(savedIndexCalls.at(-1)?.files[0]).toMatchObject(requestEnvelope2236);
  } finally { client.stop(); }
});
test('2236 request envelope survives a create op', async () => {
  const client = new SyncClient();
  client.applyRemoteOp({seq_id:1,op_type:'file_create',payload:{id:'request-file',...requestEnvelope2236}});
  expect(client.getNode('request-file')).toMatchObject(requestEnvelope2236);
  client.stop();
});
