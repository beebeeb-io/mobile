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
let allImagesCalls = 0;

mock.module('./api', () => ({
  ApiError: MockApiError,
  getAllImages: async () => { allImagesCalls += 1; return [photo('b-media')]; },
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
  cachedFileIndexEpoch: () => undefined,
}));

// Round 4: the camera-roll backup engine's shared table (remote_file_id ->
// asset_type), read by upload-classification.ts.
let backupAssetTypes = new Map<string, string>();
let backupLookups = 0;
mock.module('../services/BackupDatabase', () => ({
  getBackupMediaFlags: async (ids: string[]) => {
    backupLookups += 1;
    const out = new Map<string, boolean>();
    for (const id of ids) {
      const type = backupAssetTypes.get(id);
      if (type) out.set(id, type === 'photo' || type === 'video');
    }
    return out;
  },
}));

const { getPhotoCandidates } = await import('./photo-index-source');
const loaderModule = await import('./file-index-loader').catch(() => null);
// Task 1959 round 2. Absent before the fix.
const epoch = await import('./account-epoch').catch(() => null);
// Round 4. Absent before the fix.
const uploads = await import('./upload-classification').catch(() => null);

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

/**
 * A row exactly as the sync write-through writes it (sync-client.ts
 * `syncNodeToFileEntry` over a node from the server's `file_create` op): no
 * `is_media` (the op carries none), no plaintext mime (it is encrypted inside
 * `name_encrypted`), no thumbnail yet (fresh upload).
 */
function writeThroughRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name_encrypted: '{"cipher_suite":"aes-256-gcm","nonce":[1,2,3],"ciphertext":[4,5,6]}',
    parent_id: null,
    is_folder: false,
    size_bytes: 1,
    mime_type: null,
    chunk_count: 1,
    created_at: '2026-10-18T03:39:00Z',
    updated_at: '2026-10-18T03:39:00Z',
    version_number: 1,
    storage_pool_id: null,
    has_thumbnail: false,
    is_starred: false,
    ...extra,
  };
}

/** The server row for the same upload: classified at upload init. */
function serverPhoto(id: string) {
  return photo(id, { name_encrypted: writeThroughRow(id).name_encrypted, mime_type: undefined, has_thumbnail: false });
}

/** A file finished uploading: the server moves on, the sync write-through
 *  adds the row to the cache (same hash, new storedAt). */
let tick = 0;
function arrive(id: string, extra: Record<string, unknown> = {}) {
  tick += 1;
  serverHash = `h-arrive-${tick}`;
  serverFiles = [...serverFiles, extra.is_folder ? { ...writeThroughRow(id), ...extra, is_media: false } : serverPhoto(id)];
  cache = { ...cache!, files: [...cache!.files, writeThroughRow(id, extra)], storedAt: cache!.storedAt + 1, seq: tick };
}

const ids = (rows: Array<{ id: string }>) => rows.map((f) => f.id).sort();

beforeEach(() => {
  backupAssetTypes = new Map();
  backupLookups = 0;
  tick = 0;
  uploads?.resetUploadClassificationsForTests?.();
  indexCalls = [];
  serverHash = 'h1';
  serverFiles = [photo('a'), photo('b')];
  cache = null;
  cacheGeneration = 0;
  holdIndex = false;
  pending = [];
  allImagesCalls = 0;
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

describe('Photos index across an account switch (task 1959 round 2)', () => {
  test('a Photos load whose account signed out mid-request gets neither the old rows nor a media-list fallback under the new session', async () => {
    holdIndex = true;
    const forA = getPhotoCandidates(undefined, new Set());
    forA.catch(() => {});
    await new Promise((r) => setTimeout(r, 2));
    // clearToken(): the account epoch moves first; the cache clear follows.
    epoch?.advanceAccountEpoch();
    cache = null;
    cacheGeneration += 1;
    holdIndex = false;
    releaseAll();
    await expect(forA).rejects.toMatchObject({ name: 'StaleAccountError' });
    // Not answered with GET /files/media either (that would run on the next
    // account's session and hand its photos to the old account's screen).
    expect(allImagesCalls).toBe(0);
  });
});

describe('a photo uploaded inside the revalidation window (task 1959 round 4, Codex P1)', () => {
  test('uploaded by this device (JS uploader): shows on the next focus, no extra request', async () => {
    await getPhotoCandidates(undefined, new Set());
    // finalizeUpload records what it sent on init, before the complete call.
    uploads?.rememberUploadClassification('own-1', true);
    arrive('own-1');
    const out = await getPhotoCandidates(undefined, new Set());
    expect(ids(out)).toEqual(['a', 'b', 'own-1']);
    expect(indexCalls.length).toBe(1);
  });

  test('uploaded by this device\'s backup engine (backup_assets photo row): shows on the next focus, no extra request', async () => {
    await getPhotoCandidates(undefined, new Set());
    backupAssetTypes.set('cam-1', 'photo');
    arrive('cam-1');
    const out = await getPhotoCandidates(undefined, new Set());
    expect(ids(out)).toEqual(['a', 'b', 'cam-1']);
    expect(indexCalls.length).toBe(1);
  });

  test('uploaded by another device: shows on the next focus, after ONE revalidation with the hash', async () => {
    await getPhotoCandidates(undefined, new Set());
    arrive('foreign-1');
    const out = await getPhotoCandidates(undefined, new Set());
    expect(ids(out)).toEqual(['a', 'b', 'foreign-1']);
    expect(indexCalls).toEqual([undefined, 'h1']);
    // It is in the server snapshot now: later focuses ask nothing.
    for (let i = 0; i < 10; i += 1) {
      expect(ids(await getPhotoCandidates(undefined, new Set()))).toEqual(['a', 'b', 'foreign-1']);
    }
    expect(indexCalls.length).toBe(2);
  });

  test('a known non-media upload (contacts backup) stays out, and costs no request', async () => {
    await getPhotoCandidates(undefined, new Set());
    backupAssetTypes.set('vcf-1', 'contact');
    arrive('vcf-1');
    const out = await getPhotoCandidates(undefined, new Set());
    expect(ids(out)).toEqual(['a', 'b']);
    expect(indexCalls.length).toBe(1);
  });

  test('nothing new: 20 focuses, one request; new FOLDERS only (ensureBackupFolders): still one', async () => {
    for (let i = 0; i < 10; i += 1) await getPhotoCandidates(undefined, new Set());
    arrive('folder-1', { is_folder: true });
    arrive('folder-2', { is_folder: true });
    for (let i = 0; i < 10; i += 1) await getPhotoCandidates(undefined, new Set());
    expect(indexCalls.length).toBe(1);
    expect(backupLookups).toBe(0);
  });

  test('BURST, realistic rows: 50 uploads by this device, a focus after each, cost ONE request and every photo shows at once', async () => {
    let expected = 2;
    for (let i = 0; i < 50; i += 1) {
      const out = await getPhotoCandidates(undefined, new Set());
      expect(out.length).toBe(expected);
      // Half through the JS uploader, half through the backup engine.
      if (i % 2 === 0) uploads?.rememberUploadClassification(`up-${i}`, true);
      else backupAssetTypes.set(`up-${i}`, i % 3 === 0 ? 'video' : 'photo');
      arrive(`up-${i}`);
      expected += 1;
    }
    expect((await getPhotoCandidates(undefined, new Set())).length).toBe(52);
    expect(indexCalls.length).toBe(1);
  });

  test('another device uploading: one request per arrival, not per focus (3 arrivals across 12 focuses = 1 + 3)', async () => {
    for (let i = 0; i < 12; i += 1) {
      await getPhotoCandidates(undefined, new Set());
      if (i === 2 || i === 5 || i === 8) arrive(`foreign-${i}`);
    }
    expect(indexCalls.length).toBe(4);
  });
});
