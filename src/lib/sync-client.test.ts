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
import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'session-token',
  getStreamToken: async () => ({ stream_token: 'tok', expires_at: '2099-01-01T00:00:00Z' }),
  submitSyncOps: async () => ({ applied: [], rejected: [] }),
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

mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => cachedIndex,
  saveCachedFileIndex: async (hash: string, files: unknown[], storedAt?: number, seq?: number) => {
    savedIndexCalls.push({ hash, files, storedAt, seq });
  },
  clearCachedFileIndex: async () => {},
}));

mock.module('./file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => {},
}));

mock.module('./device-identity', () => ({
  getDeviceId: async () => 'device-1',
}));

const { SyncClient, fileEntryToSyncNode } = await import('./sync-client');

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

  test('does NOT seed from a cache whose cursor is behind lastSeq — the cache write is debounced ~800ms behind the synchronous lastSeq persist, so a kill mid-debounce can leave the cache stale', async () => {
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
    // "consumed" per lastSeq bookkeeping and is NEVER re-sent. If seeding
    // from the stale cache were allowed anyway, 'mid-1' would be silently,
    // permanently missing from the tree.
    getSyncOpsImpl = async () => [];
    getSnapshotImpl = async () => ({
      seq_id: 6,
      nodes: [syncNode({ id: 'old-1' }), syncNode({ id: 'old-2' }), syncNode({ id: 'mid-1' })],
    });

    const client = new SyncClient();
    await client.start();

    // Treated exactly like "no cache" — always an authoritative snapshot,
    // never an unsafe ops-only reconstruction off a stale base.
    expect(getSnapshotCalls).toBe(1);
    expect(getSyncOpsCalls).toEqual([]);
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
