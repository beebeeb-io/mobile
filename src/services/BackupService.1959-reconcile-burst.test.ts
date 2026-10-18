// @ts-nocheck
/**
 * Task 1959 — the backup reconcile must not walk /files/index once per
 * backed-up item.
 *
 * The path that fired GET /files/index 18 times in 10 minutes on Guus's TF239
 * upload: SettingsScreen.tsx's `refreshBackupStats` effect depends on
 * `backupProgress.completed`, so it re-runs once per completed backup item.
 * It calls `getDeviceManifest()` -> `ensureDeviceFolderId()` ->
 * `ensureBackupFolders('camera_roll')` -> `reconcileDerivedStateAgainstServer()`
 * -> `getFileIndex(lastReconcileHash)`. Each completed item changes the vault,
 * so the hash gate never matched and every call pulled the whole index; the
 * server walks all 39,783 rows either way (~2.4 s).
 *
 * Drives the real exported `ensureBackupFolders` (the call every
 * `getDeviceManifest()` makes) and `reconcileDerivedStateAgainstServer` (the
 * foreground listener's call), with every dependency mocked (isolated-runner
 * rule, mobile CLAUDE.md "Tests"), and COUNTS /files/index requests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type Entry = { id: string; parent_id: string | null; is_folder: boolean; name_encrypted: string; created_at: string; updated_at?: string; size_bytes?: number; chunk_count?: number };

const listings = new Map<string, Entry[]>();
const readable = new Map<string, string>();

function sealed(id: string, parent: string | null): Entry {
  return {
    id,
    parent_id: parent,
    is_folder: true,
    name_encrypted: JSON.stringify({ nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUFBQUFBQUFBQUFBQUFBQUFBQUE=' }),
    created_at: '2026-10-18T03:00:00Z',
  };
}

function fileRow(id: string, parent: string): Entry {
  return {
    id,
    parent_id: parent,
    is_folder: false,
    name_encrypted: `${id}.heic`,
    created_at: '2026-10-18T03:38:00Z',
    updated_at: '2026-10-18T03:38:00Z',
    size_bytes: 1,
    chunk_count: 1,
  };
}

// The server: its current hash and live rows. Every completed backup item
// adds a row and moves the hash, like the real vault during an upload.
let serverHash = 'h0';
let serverRows: Entry[] = [];
const indexCalls: Array<string | undefined> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-file-system/legacy', () => ({ documentDirectory: 'file:///tmp/docs/', cacheDirectory: 'file:///tmp/cache/' }));
const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo-device', () => ({ deviceName: 'bb-ios27', modelName: 'iPhone 17 Pro', osName: 'iOS', osVersion: '27.0' }));

mock.module('../lib/api', () => ({
  createFolder: async () => { throw new Error('this test must not create folders'); },
  deleteFile: async () => {},
  downloadFile: async () => { throw new Error('not used'); },
  listAllFiles: async (parentId?: string) => listings.get(parentId ?? 'root') ?? [],
  findFile: async (parentId: string | undefined, match: (f: Entry) => boolean | Promise<boolean>) => {
    for (const f of listings.get(parentId ?? 'root') ?? []) {
      if (await match(f)) return f;
    }
    return undefined;
  },
  moveFile: async () => {},
  renameFile: async () => {},
  trashFiles: async () => {},
  getFileIndex: async (hash?: string) => {
    indexCalls.push(hash);
    if (hash === serverHash) return { hash: serverHash, changed: false, count: serverRows.length };
    return { hash: serverHash, changed: true, count: serverRows.length, files: [...serverRows] };
  },
}));

// In-memory index cache (the real one writes to the documents directory).
let indexCache: { hash: string; files: Entry[]; storedAt: number; seq?: number } | null = null;
let cacheGeneration = 0;
mock.module('../lib/file-index-cache', () => ({
  loadCachedFileIndex: async () => (indexCache ? { ...indexCache, files: [...indexCache.files] } : null),
  saveCachedFileIndex: async (hash: string, files: Entry[], storedAt = Date.now(), seq?: number) => {
    indexCache = { hash, files, storedAt, ...(seq !== undefined ? { seq } : {}) };
  },
  clearCachedFileIndex: async () => { indexCache = null; cacheGeneration += 1; },
  fileIndexCacheGeneration: () => cacheGeneration,
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  getContactsBackupStatus: async () => ({ hasKnownBackupState: false }),
  getCalendarBackupStatus: async () => ({ hasKnownBackupState: false }),
  resetContactsBackup: async () => {},
  resetCalendarBackup: async () => {},
}));
mock.module('../lib/encrypted-upload', () => ({
  encryptedUpload: async () => ({ id: 'manifest' }),
  generateFileId: async () => 'unused',
}));
let uploadedRemote = new Set<string>();
const requeued: string[][] = [];
mock.module('./BackupDatabase', () => ({
  getAllUploadedRemoteIds: async () => new Set(uploadedRemote),
  resetUploadedState: async (ids?: string[]) => { requeued.push(ids ?? ['<all>']); return ids?.length ?? 0; },
}));
mock.module('../lib/offline-manager', () => ({
  offlineManager: { offlineFileIds: () => [], offlineFolderIds: () => [], removeFile: async () => {}, removeFolder: async () => {} },
}));
mock.module('../lib/thumbnail-cache', () => ({
  pruneThumbnailsForRemoteFiles: async () => {},
  invalidateCachedThumbnails: async () => {},
  invalidateNativeThumbnailCache: async () => {},
}));
mock.module('../lib/name-cache', () => ({ loadNameCache: async () => ({}), pruneNameCache: async () => {} }));
mock.module('../lib/device-identity', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('../lib/runtime-trace', () => ({ recordRuntimeTrace: () => null }));

const BackupService = await import('./BackupService');
const { ensureBackupFolders, reconcileDerivedStateAgainstServer, setBackupEncryption } = BackupService;
const loader = await import('../lib/file-index-loader').catch(() => null);

const realNow = Date.now;
let clock = 1_000_000;

beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
  listings.clear();
  readable.clear();
  secure.clear();
  indexCalls.length = 0;
  requeued.length = 0;
  indexCache = null;
  cacheGeneration = 0;
  uploadedRemote = new Set();
  BackupService.resetReconcileThrottleForTests?.();
  loader?.resetFileIndexLoaderForTests?.();

  // A readable, complete Backups tree, so ensureBackupFolders creates nothing.
  listings.set('root', [sealed('backups', null)]);
  readable.set('backups', 'Backups');
  listings.set('backups', [sealed('device-a', 'backups')]);
  readable.set('device-a', 'bb-ios27');
  listings.set('device-a', [sealed('cam', 'device-a'), sealed('con', 'device-a'), sealed('cal', 'device-a')]);
  readable.set('cam', 'Camera Roll');
  readable.set('con', 'Contacts');
  readable.set('cal', 'Calendar');

  serverHash = 'h0';
  serverRows = [
    { ...sealed('backups', null) }, { ...sealed('device-a', 'backups') },
    { ...sealed('cam', 'device-a') }, { ...sealed('con', 'device-a') }, { ...sealed('cal', 'device-a') },
  ];

  setBackupEncryption({
    encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
    decryptChunkFn: async () => new Uint8Array(),
    encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' }),
    decryptMetadataFn: async (fileId: string) => {
      const name = readable.get(fileId);
      if (name == null) throw new Error('decryption failed: ciphertext is invalid or key is wrong');
      return JSON.stringify({ name, mime_type: null });
    },
  });
});

afterEach(() => {
  Date.now = realNow;
});

/** One backed-up item completes: the server gains the row, the hash moves,
 *  and the native manifest records it as uploaded. */
function completeBackupItem(i: number) {
  const id = `photo-${i}`;
  serverRows = [...serverRows, fileRow(id, 'cam')];
  serverHash = `h${i + 1}`;
  uploadedRemote.add(id);
}

describe('task 1959 — backup reconcile burst', () => {
  test('50 completed backup items, each re-running SettingsScreen.refreshBackupStats -> getDeviceManifest -> ensureBackupFolders, cost ONE /files/index request', async () => {
    for (let i = 0; i < 50; i += 1) {
      completeBackupItem(i);
      clock += 6_000; // ~one item every 6 s: 50 items in 5 minutes
      await ensureBackupFolders('camera_roll');
    }
    // First call at t=6 s, last at t=300 s: all inside one 5-minute interval.
    expect(indexCalls.length).toBe(1);
    // Nothing was re-queued: every uploaded item was in the server list the
    // reconcile saw (a stale list would have re-queued fresh uploads).
    expect(requeued).toEqual([]);
  });

  test('foreground bursts (AppState -> active, e.g. Face ID / Control Centre / app switcher) do not each walk the index', async () => {
    for (let i = 0; i < 20; i += 1) {
      completeBackupItem(i);
      clock += 2_000;
      await reconcileDerivedStateAgainstServer();
    }
    expect(indexCalls.length).toBe(1);
  });

  test('after the interval the reconcile asks the server again, and still re-queues a real server-side delete', async () => {
    uploadedRemote = new Set(['gone-1']);
    serverRows = [...serverRows, fileRow('gone-1', 'cam')];
    serverHash = 'with-gone';
    await reconcileDerivedStateAgainstServer();
    expect(indexCalls.length).toBe(1);
    expect(requeued).toEqual([]);

    // Deleted on the web.
    serverRows = serverRows.filter((r) => r.id !== 'gone-1');
    serverHash = 'without-gone';
    clock += 60_000;
    await reconcileDerivedStateAgainstServer();
    expect(indexCalls.length).toBe(1); // inside the interval: no request

    clock += 5 * 60_000;
    await reconcileDerivedStateAgainstServer();
    expect(indexCalls.length).toBe(2);
    expect(requeued).toEqual([['gone-1']]);
  });

  test('the reconcile never decides orphans from a cached list: a screen refreshed the index, then an item finished uploading', async () => {
    // A screen (Photos focus) checks the index: the loader window starts.
    await loader.loadFileIndex();
    expect(indexCalls.length).toBe(1);
    // An item finishes uploading 10 s later. The on-disk cache does not have
    // it yet (no sync write-through in this test).
    clock += 10_000;
    completeBackupItem(0);
    await reconcileDerivedStateAgainstServer();
    // The reconcile asked the server (forced) instead of using the window, so
    // the fresh upload is not mistaken for an orphan and re-queued.
    expect(indexCalls.length).toBe(2);
    expect(requeued).toEqual([]);
  });

  test('concurrent reconcile triggers share one request', async () => {
    completeBackupItem(0);
    await Promise.all([
      reconcileDerivedStateAgainstServer(),
      reconcileDerivedStateAgainstServer(),
      ensureBackupFolders('camera_roll'),
      ensureBackupFolders('contacts'),
    ]);
    expect(indexCalls.length).toBe(1);
  });
});
