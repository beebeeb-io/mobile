/**
 * file-index-loader — the ONLY caller of `getFileIndex()` (GET /files/index).
 *
 * Task 1959 (2026-10-18). Guus's iOS TF239 app called GET /files/index 18
 * times in 10 minutes while uploading a 163 MB video into a 39,783-file vault.
 * The server walks the whole vault on every call, hash or not (~2.4 s each),
 * and the calls pushed API p95 over the APILatencyHigh threshold.
 *
 * Cause on the client: nothing coalesced the calls, and two paths fired them
 * repeatedly during an upload:
 *   - The repeating one: SettingsScreen's `refreshBackupStats` effect re-runs
 *     whenever `backupProgress.completed` changes (once per backed-up item; the
 *     Settings tab stays mounted once visited). It calls `getDeviceManifest()`
 *     -> `ensureBackupFolders()` -> `reconcileDerivedStateAgainstServer()` ->
 *     GET /files/index. Its hash gate never matched during a backup, because
 *     every completed item changes the vault. The same reconcile also ran on
 *     every return to the foreground (backup-context AppState listener).
 *     Fixed in BackupService.ts (`RECONCILE_MIN_INTERVAL_MS`), which now also
 *     goes through this loader.
 *   - PhotosScreen's useFocusEffect -> fetchPhotos -> getPhotoCandidates
 *     called getFileIndex on EVERY focus of the Photos tab: switching back to
 *     the tab, and closing any screen stacked over it (Preview, ShareSheet,
 *     any modal). The settings screens that need the index (Advanced, Photo
 *     library, Thumbnail quality) fetched it again on every mount, and
 *     overlapping callers each sent their own request.
 *
 * What this module does instead:
 *   1. In-flight dedupe: every caller that arrives while a request is running
 *      shares that request (forced or not).
 *   2. A revalidation window (`FILE_INDEX_REVALIDATE_MS`): after a successful
 *      server check, callers inside the window get the on-disk cache with no
 *      network request. The cache stays current inside the window because
 *      the sync client (sync-client.ts `persistCacheNow`) writes every
 *      create / trash / move / rename op through to it, keeping the hash.
 *   3. The hash path on every request, so an unchanged vault returns
 *      `changed: false` with no file list.
 *   4. `force: true` (pull-to-refresh, "items were gone" after a bulk action,
 *      the backup reconcile, which needs the current server list)
 *      skips the window but still joins an in-flight request.
 *
 * `file-index-loader.guard.test.ts` keeps `getFileIndex` from being called
 * anywhere else.
 */

import { getFileIndex } from './api';
import type { FileEntry, FileIndexResponse } from './api';
import {
  fileIndexCacheGeneration,
  loadCachedFileIndex,
  saveCachedFileIndex,
  type CachedFileIndex,
} from './file-index-cache';

/** At most one /files/index request starts per window, unless forced. */
export const FILE_INDEX_REVALIDATE_MS = 5 * 60_000;

export interface FileIndexLoadOptions {
  /** Ask the server even inside the revalidation window (explicit refresh). */
  force?: boolean;
  /** A cache the caller already read, to avoid parsing it twice. */
  cached?: CachedFileIndex | null;
}

export interface FileIndexLoadResult {
  /** The vault's live (non-trashed) rows, or null when neither the server
   *  nor the cache produced a list. */
  files: FileEntry[] | null;
  /** The index hash these rows correspond to: the server's current hash
   *  after a network check, the cached hash otherwise. Null when unknown. */
  hash: string | null;
  /** 'network' when this call (or the request it joined) asked the server. */
  source: 'network' | 'cache';
}

interface LoaderDeps {
  fetchIndex: (hash?: string) => Promise<FileIndexResponse>;
  loadCache: () => Promise<CachedFileIndex | null>;
  saveCache: (hash: string, files: FileEntry[], storedAt: number) => Promise<void>;
  cacheGeneration: () => number;
  now: () => number;
  revalidateMs: number;
}

interface LastCheck {
  at: number;
  hash: string;
  storedAt: number;
  generation: number;
  /** Server rows by id, to restore fields the sync write-through drops. */
  byId: Map<string, FileEntry>;
}

/**
 * The sync write-through (`syncNodeToFileEntry`) only carries the fields the
 * sync tree has. It drops per-file fields that only /files/index serves —
 * file-request key material (`file_request_id`, `sender_ephemeral_pubkey`,
 * `wrapped_content_key`), `blurhash`, `thumbnail_bytes`, `storage_location`,
 * `share_count`, `is_media`. Before this task the next focus re-downloaded the
 * index and put them back; inside the window this restores them from the last
 * server response instead. Fields the cache row has win (a rename or move
 * arrives over sync). `is_uploading` is never carried over: the server's
 * value was a snapshot and the upload may have finished since.
 */
export function mergeWithServerRows(cacheFiles: FileEntry[], byId: Map<string, FileEntry>): FileEntry[] {
  return cacheFiles.map((row) => {
    const server = byId.get(row.id);
    if (!server) return row;
    const { is_uploading: _snapshot, ...merged } = server;
    const out = merged as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      if (value !== undefined) out[key] = value;
    }
    return out as unknown as FileEntry;
  });
}

export function createFileIndexLoader(deps: LoaderDeps) {
  let inFlight: Promise<FileIndexLoadResult> | null = null;
  let last: LastCheck | null = null;

  /** The rows to hand out for `cached`, given the last server check. */
  function rowsFor(cached: CachedFileIndex, check: LastCheck): FileEntry[] {
    // Untouched since the server answered: it IS the server response.
    if (cached.storedAt === check.storedAt) return cached.files;
    // Rewritten by the sync write-through since: current membership, server
    // fields restored.
    return mergeWithServerRows(cached.files, check.byId);
  }

  function freshFromCache(cached: CachedFileIndex | null): FileEntry[] | null {
    if (!last || !cached) return null;
    if (deps.now() - last.at >= deps.revalidateMs) return null;
    if (deps.cacheGeneration() !== last.generation) return null;
    if (cached.hash !== last.hash) return null;
    return rowsFor(cached, last);
  }

  async function revalidate(preloaded: CachedFileIndex | null | undefined): Promise<FileIndexLoadResult> {
    const generation = deps.cacheGeneration();
    const cached = preloaded !== undefined ? preloaded : await deps.loadCache();
    const index = await deps.fetchIndex(cached?.hash);
    // Signed out / switched account while the request ran: hand the answer to
    // the caller that asked, but neither cache it nor remember it.
    if (deps.cacheGeneration() !== generation) {
      return {
        files: index.files ?? (index.changed ? null : cached?.files ?? null),
        hash: index.hash ?? null,
        source: 'network',
      };
    }
    if (!index.changed && cached) {
      const sameServerState = last !== null && last.hash === cached.hash && last.generation === generation;
      last = sameServerState && last
        ? { ...last, at: deps.now() }
        : {
            at: deps.now(),
            hash: cached.hash,
            storedAt: cached.storedAt,
            generation,
            byId: new Map(cached.files.map((f) => [f.id, f])),
          };
      return { files: rowsFor(cached, last), hash: cached.hash, source: 'network' };
    }
    if (index.files) {
      const storedAt = deps.now();
      await deps.saveCache(index.hash, index.files, storedAt);
      last = {
        at: storedAt,
        hash: index.hash,
        storedAt,
        generation,
        byId: new Map(index.files.map((f) => [f.id, f])),
      };
      return { files: index.files, hash: index.hash, source: 'network' };
    }
    return { files: cached?.files ?? null, hash: cached?.hash ?? null, source: 'network' };
  }

  async function load(options: FileIndexLoadOptions = {}): Promise<FileIndexLoadResult> {
    if (inFlight) return inFlight;
    if (!options.force) {
      const cached = options.cached !== undefined ? options.cached : await deps.loadCache();
      // Another caller may have started a request while the cache was read.
      if (inFlight) return inFlight;
      const files = freshFromCache(cached);
      if (files && cached) return { files, hash: cached.hash, source: 'cache' };
      return start(cached);
    }
    return start(options.cached);
  }

  function start(preloaded: CachedFileIndex | null | undefined): Promise<FileIndexLoadResult> {
    if (inFlight) return inFlight;
    const request = revalidate(preloaded).finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request;
  }

  function reset(): void {
    inFlight = null;
    last = null;
  }

  return { load, reset };
}

const defaultLoader = createFileIndexLoader({
  fetchIndex: (hash) => getFileIndex(hash),
  loadCache: loadCachedFileIndex,
  saveCache: (hash, files, storedAt) => saveCachedFileIndex(hash, files, storedAt),
  cacheGeneration: fileIndexCacheGeneration,
  now: () => Date.now(),
  revalidateMs: FILE_INDEX_REVALIDATE_MS,
});

/** Load the vault index for a screen. See the module comment for the rules. */
export function loadFileIndex(options?: FileIndexLoadOptions): Promise<FileIndexLoadResult> {
  return defaultLoader.load(options);
}

/** Test hook: forget the in-memory window and any in-flight request. */
export function resetFileIndexLoaderForTests(): void {
  defaultLoader.reset();
}
