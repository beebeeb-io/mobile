import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { FileEntry } from './api';
import { notePlaintextPathCreated } from './plaintext-storage';
import { accountEpoch, advanceAccountEpoch, isCurrentAccountEpoch, type AccountEpoch } from './account-epoch';

const FILE_INDEX_CACHE_KEY = 'beebeeb:file-index-cache:v1';
const FILE_INDEX_CACHE_PATH = `${FileSystem.documentDirectory ?? ''}beebeeb-file-index-cache-v1.json`;

export interface CachedFileIndex {
  hash: string;
  files: FileEntry[];
  storedAt: number;
  /**
   * The CRDT sync cursor (`SyncClient.lastSeq`) this cache was written at,
   * when the writer is `sync-client.ts`'s `persistCacheNow` — undefined for
   * writes from the REST `/files/index` path (FilesScreen and friends),
   * which have no sync cursor to stamp. Task 1302 follow-up: a
   * returning-device catch-up may only seed its in-memory tree from this
   * cache when `seq` exactly equals the freshly-loaded `lastSeq` — the cache
   * write is debounced ~800ms behind the synchronous `lastSeq` persist, so a
   * kill mid-debounce can leave the cache older than `lastSeq`, and without
   * this check that gap would be silently, permanently skipped.
   */
  seq?: number;
}

function isFileEntry(value: unknown): value is FileEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<FileEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name_encrypted === 'string' &&
    typeof entry.size_bytes === 'number' &&
    typeof entry.is_folder === 'boolean' &&
    typeof entry.chunk_count === 'number' &&
    typeof entry.created_at === 'string' &&
    typeof entry.updated_at === 'string'
  );
}

/**
 * Task 1959: bumped on every `clearCachedFileIndex()` (sign-out, account
 * switch). `file-index-loader.ts` stamps the generation it last checked the
 * server at, so a cache written after a clear is never treated as already
 * revalidated.
 */
let cacheGeneration = 0;

export function fileIndexCacheGeneration(): number {
  return cacheGeneration;
}

/**
 * Task 1959 round 2: the account epoch each loaded cache object was read
 * under (captured when the read STARTED). The file-index loader refuses a
 * caller-supplied cache read under another account. A WeakMap, not a field,
 * so the object's shape (and anything that serialises it) is unchanged.
 */
const readEpochs = new WeakMap<CachedFileIndex, AccountEpoch>();

export function cachedFileIndexEpoch(index: CachedFileIndex): AccountEpoch | undefined {
  return readEpochs.get(index);
}

export async function loadCachedFileIndex(): Promise<CachedFileIndex | null> {
  const epoch = accountEpoch();
  const generationAtStart = cacheGeneration;
  const loaded = await loadCachedFileIndexUntagged();
  // Cleared while it was being read: whatever came back belonged to the
  // signed-out account.
  if (!loaded || cacheGeneration !== generationAtStart) return null;
  readEpochs.set(loaded, epoch);
  return loaded;
}

async function loadCachedFileIndexUntagged(): Promise<CachedFileIndex | null> {
  const disk = await loadFromDisk();
  if (disk) return disk;

  try {
    const raw = await AsyncStorage.getItem(FILE_INDEX_CACHE_KEY);
    if (!raw) return null;
    const parsed = parseCachedFileIndex(raw);
    if (!parsed) {
      await AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY);
      return null;
    }
    await saveCachedFileIndex(parsed.hash, parsed.files, parsed.storedAt, parsed.seq).catch(() => {});
    await AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY).catch(() => {});
    return parsed;
  } catch {
    await AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY).catch(() => {});
    return null;
  }
}

// Ensure FileSystem.documentDirectory exists. On a fresh iOS install the
// Documents folder is created lazily by the system on first access, and an
// immediate writeAsStringAsync there raises "folder doesn't exist" with the
// filename as the offending path. Idempotent makeDirectoryAsync({intermediates:
// true}) is the documented expo-file-system pattern for this guard.
async function ensureDocumentDirectory(): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  try {
    await FileSystem.makeDirectoryAsync(FileSystem.documentDirectory, {
      intermediates: true,
    });
  } catch {
    // already exists or transient permission — writeAsStringAsync will surface
    // any real error
  }
}

/**
 * Task 1959 round 2: every write and every clear of the cache runs through
 * this one queue, in call order. Without it a clear (sign-out) could delete
 * the file while a write that started before it was still waiting on
 * `ensureDocumentDirectory()`, and the write then put the signed-out
 * account's rows back on disk for the next account to read.
 */
let fileOps: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = fileOps.then(op, op);
  fileOps = run.catch(() => {});
  return run;
}

export interface SaveCachedFileIndexOptions {
  /**
   * The account epoch the rows belong to. The write is dropped when, at its
   * turn in the queue, that account is no longer the current one. Writers
   * that started before an await (the loader, the sync write-through) pass
   * the epoch they started under.
   */
  epoch?: AccountEpoch;
}

export async function saveCachedFileIndex(
  hash: string,
  files: FileEntry[],
  storedAt = Date.now(),
  seq?: number,
  options: SaveCachedFileIndexOptions = {},
): Promise<void> {
  const generationAtCall = cacheGeneration;
  const payload: CachedFileIndex = { hash, files, storedAt, ...(seq !== undefined ? { seq } : {}) };
  const serializedPayload = JSON.stringify(payload);
  await serialized(async () => {
    if (FileSystem.documentDirectory) await ensureDocumentDirectory();
    // Checked synchronously right before the write: a clear queued after this
    // write runs after it (and deletes it); a clear that ran before it wins.
    if (cacheGeneration !== generationAtCall) return;
    if (options.epoch && !isCurrentAccountEpoch(options.epoch)) return;
    if (FileSystem.documentDirectory) {
      await FileSystem.writeAsStringAsync(FILE_INDEX_CACHE_PATH, serializedPayload);
      notePlaintextPathCreated();
      return;
    }
    await AsyncStorage.setItem(FILE_INDEX_CACHE_KEY, serializedPayload);
  });
}

export async function clearCachedFileIndex(): Promise<void> {
  cacheGeneration += 1;
  // Round 2: a cache clear is an account boundary on its own too (clearToken
  // already advanced it; this covers any other caller).
  advanceAccountEpoch();
  await serialized(() =>
    Promise.all([
      AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY),
      FileSystem.documentDirectory
        ? FileSystem.deleteAsync(FILE_INDEX_CACHE_PATH, { idempotent: true }).catch(() => {})
        : Promise.resolve(),
    ]),
  );
}

async function loadFromDisk(): Promise<CachedFileIndex | null> {
  if (!FileSystem.documentDirectory) return null;
  try {
    const info = await FileSystem.getInfoAsync(FILE_INDEX_CACHE_PATH);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(FILE_INDEX_CACHE_PATH);
    const parsed = parseCachedFileIndex(raw);
    if (!parsed) {
      await FileSystem.deleteAsync(FILE_INDEX_CACHE_PATH, { idempotent: true }).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    await FileSystem.deleteAsync(FILE_INDEX_CACHE_PATH, { idempotent: true }).catch(() => {});
    return null;
  }
}

function parseCachedFileIndex(raw: string): CachedFileIndex | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedFileIndex>;
    if (
      typeof parsed.hash !== 'string' ||
      !Array.isArray(parsed.files) ||
      typeof parsed.storedAt !== 'number' ||
      !parsed.files.every(isFileEntry) ||
      (parsed.seq !== undefined && typeof parsed.seq !== 'number')
    ) {
      return null;
    }
    return {
      hash: parsed.hash,
      files: parsed.files,
      storedAt: parsed.storedAt,
      ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}),
    };
  } catch {
    return null;
  }
}
