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
 * Account boundary (round 2, Codex P1 on PR #181): every request, and the
 * window, belongs to the account epoch (`account-epoch.ts`) it started under.
 *   - A caller only joins an in-flight request of its own epoch; a caller of
 *     another epoch starts its own request.
 *   - A request whose epoch is no longer current when it settles REJECTS with
 *     `StaleAccountError` for all of its waiters (who are, by the rule above,
 *     all of the old epoch). It never hands rows to anyone and never writes
 *     the cache. Callers treat that rejection as "discard silently".
 *   - The same check runs after every await inside the loader (cache read,
 *     server response, cache write), and a cache object the caller read under
 *     another epoch is not used.
 *   - The window (`last`, which also holds the last server rows by id for the
 *     field restore) is dropped on every epoch advance — at the start of
 *     sign-out, not at the next call.
 *
 * Rows new since the last server check (round 4, Codex P1 on PR #181): the
 * sync write-through adds a file uploaded after the window opened, but its row
 * has none of the server-only fields — above all no `is_media`, so the Photos
 * tab filtered a fresh upload out until the window expired.
 *   - Rows this device uploaded are classified locally
 *     (upload-classification.ts: the `is_media` the JS uploader sent, or the
 *     backup engine's `backup_assets.asset_type`). No request.
 *   - Any other new file row (another device, the share extension, a file
 *     request) is unclassified. A caller that needs the classification passes
 *     `revalidateUnclassified` (the Photos tab, the photo-library settings),
 *     and that load revalidates with the hash — joined to any request in
 *     flight — instead of returning the cache. One request per arrival, not
 *     per focus: the answer puts the row in the server snapshot.
 *   - A row the server confirms it does not list (hash unchanged) is
 *     remembered as acknowledged, so it cannot make every focus ask again.
 *
 * `file-index-loader.guard.test.ts` keeps `getFileIndex` from being called
 * anywhere else.
 */

import { getFileIndex } from './api';
import type { FileEntry, FileIndexResponse } from './api';
import {
  cachedFileIndexEpoch,
  fileIndexCacheGeneration,
  loadCachedFileIndex,
  saveCachedFileIndex,
  type CachedFileIndex,
  type FileIndexCacheWriteScope,
} from './file-index-cache';
import {
  accountEpoch,
  onAccountEpochAdvance,
  sameAccountEpoch,
  StaleAccountError,
  type AccountEpoch,
} from './account-epoch';
import { classifyOwnUploads } from './upload-classification';

/** At most one /files/index request starts per window, unless forced. */
export const FILE_INDEX_REVALIDATE_MS = 5 * 60_000;

export interface FileIndexLoadOptions {
  /** Ask the server even inside the revalidation window (explicit refresh). */
  force?: boolean;
  /** A cache the caller already read, to avoid parsing it twice. Used only
   *  when it was read under the current account epoch. */
  cached?: CachedFileIndex | null;
  /** The epoch `cached` was read under. Defaults to the tag
   *  `loadCachedFileIndex()` puts on the object; an untagged object is
   *  treated as read under the current epoch. */
  cachedEpoch?: AccountEpoch;
  /** Round 4: the caller needs `is_media` on every file row (the Photos
   *  tab, the photo-library settings). Inside the window, a new file row that
   *  neither the server snapshot nor this device's own upload record can
   *  classify triggers a revalidation instead of a cache answer. */
  revalidateUnclassified?: boolean;
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
  /** Round 3: `scope` is required — the epoch AND cache generation this
   *  request started under (file-index-cache.ts `FileIndexCacheWriteScope`). */
  saveCache: (hash: string, files: FileEntry[], storedAt: number, scope: FileIndexCacheWriteScope) => Promise<void>;
  cacheGeneration: () => number;
  /** The signed-in account's epoch (account-epoch.ts). */
  accountEpoch?: () => AccountEpoch;
  /** The epoch a cache object was read under, when known. */
  cacheReadEpoch?: (cached: CachedFileIndex) => AccountEpoch | undefined;
  /** Round 4: `is_media` for the ids this device uploaded itself
   *  (upload-classification.ts). Absent ids are unknown. */
  classifyLocally?: (fileIds: string[]) => Promise<Map<string, boolean>>;
  now: () => number;
  revalidateMs: number;
}

/** The account epoch plus the cache generation: both must hold. */
interface Epoch {
  account: AccountEpoch;
  cache: number;
}

interface LastCheck {
  at: number;
  hash: string;
  storedAt: number;
  epoch: Epoch;
  /** Server rows by id, to restore fields the sync write-through drops. */
  byId: Map<string, FileEntry>;
  /** Cache rows absent from `byId` that a later server check (hash
   *  unchanged) confirmed it does not list: not "new", never revalidated
   *  for again. */
  acknowledged: Set<string>;
}

interface InFlight {
  epoch: Epoch;
  promise: Promise<FileIndexLoadResult>;
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

const NO_ACCOUNT: AccountEpoch = { generation: 0, accountId: null };

/** A file row with no `is_media` at all: written by the sync write-through,
 *  not by the server (whose /files/index rows always carry the boolean). */
function isUnclassifiedFile(row: FileEntry): boolean {
  return !row.is_folder && typeof row.is_media !== 'boolean';
}

export function createFileIndexLoader(deps: LoaderDeps) {
  let inFlight: InFlight | null = null;
  let last: LastCheck | null = null;

  function epochNow(): Epoch {
    return { account: deps.accountEpoch ? deps.accountEpoch() : NO_ACCOUNT, cache: deps.cacheGeneration() };
  }

  function sameEpoch(a: Epoch, b: Epoch): boolean {
    return a.cache === b.cache && sameAccountEpoch(a.account, b.account);
  }

  /** Throws when `epoch` is no longer current: the work belongs to an
   *  account that has signed out (or been switched away from). */
  function assertCurrent(epoch: Epoch): void {
    if (!sameEpoch(epoch, epochNow())) throw new StaleAccountError('file index');
  }

  /** Forget another epoch's window (its server rows). */
  function dropOtherEpochWindow(epoch: Epoch): void {
    if (last && !sameEpoch(last.epoch, epoch)) last = null;
  }

  /** The in-flight request a caller of `epoch` may share: only one that
   *  started under the same epoch. Another epoch's request is left to settle
   *  (and reject for its own waiters); this caller starts its own. */
  function joinable(epoch: Epoch): Promise<FileIndexLoadResult> | null {
    return inFlight && sameEpoch(inFlight.epoch, epoch) ? inFlight.promise : null;
  }

  /** The caller's preloaded cache, only when it was read under `epoch`. */
  function usablePreloaded(
    epoch: Epoch,
    cached: CachedFileIndex | null | undefined,
    cachedEpoch: AccountEpoch | undefined,
  ): CachedFileIndex | null | undefined {
    if (!cached) return cached;
    const readUnder = cachedEpoch ?? deps.cacheReadEpoch?.(cached);
    if (readUnder && !sameAccountEpoch(readUnder, epoch.account)) return undefined;
    return cached;
  }

  /** The rows to hand out for `cached`, given the last server check. */
  function rowsFor(cached: CachedFileIndex, check: LastCheck): FileEntry[] {
    // Untouched since the server answered: it IS the server response.
    if (cached.storedAt === check.storedAt) return cached.files;
    // Rewritten by the sync write-through since: current membership, server
    // fields restored.
    return mergeWithServerRows(cached.files, check.byId);
  }

  /** Fill `is_media` on unclassified file rows from this device's own
   *  upload record. Returns the rows and the ids still unknown. */
  async function classifyRows(epoch: Epoch, rows: FileEntry[]): Promise<{ rows: FileEntry[]; unknown: string[] }> {
    const ids = rows.filter(isUnclassifiedFile).map((row) => row.id);
    if (ids.length === 0) return { rows, unknown: [] };
    const known = deps.classifyLocally ? await deps.classifyLocally(ids) : new Map<string, boolean>();
    assertCurrent(epoch);
    if (known.size === 0) return { rows, unknown: ids };
    const out = rows.map((row) => {
      const isMedia = isUnclassifiedFile(row) ? known.get(row.id) : undefined;
      return isMedia === undefined ? row : { ...row, is_media: isMedia };
    });
    return { rows: out, unknown: ids.filter((id) => !known.has(id)) };
  }

  /** Unknown ids that are new since `check`: neither in its server snapshot
   *  nor acknowledged as unlisted by a later check. */
  function newSince(check: LastCheck, unknown: string[]): boolean {
    return unknown.some((id) => !check.byId.has(id) && !check.acknowledged.has(id));
  }

  function freshFromCache(epoch: Epoch, cached: CachedFileIndex | null): FileEntry[] | null {
    if (!last || !cached) return null;
    if (!sameEpoch(last.epoch, epoch)) return null;
    if (deps.now() - last.at >= deps.revalidateMs) return null;
    if (cached.hash !== last.hash) return null;
    return rowsFor(cached, last);
  }

  async function revalidate(epoch: Epoch, preloaded: CachedFileIndex | null | undefined): Promise<FileIndexLoadResult> {
    const cached = preloaded !== undefined ? preloaded : await deps.loadCache();
    assertCurrent(epoch);
    const index = await deps.fetchIndex(cached?.hash);
    // Signed out / switched account while the request ran: the answer is the
    // old account's. Reject for every waiter (all of them are of this epoch);
    // never cache it, never remember it.
    assertCurrent(epoch);
    if (!index.changed && cached) {
      const sameServerState = last !== null && last.hash === cached.hash && sameEpoch(last.epoch, epoch);
      let check: LastCheck;
      if (sameServerState && last) {
        // The server has not changed since `last.byId`: a cache row absent
        // from it is one the server does not list. Acknowledge it so it
        // never triggers another revalidation.
        const acknowledged = new Set(last.acknowledged);
        for (const f of cached.files) if (!last.byId.has(f.id)) acknowledged.add(f.id);
        check = { ...last, at: deps.now(), acknowledged };
      } else {
        check = {
          at: deps.now(),
          hash: cached.hash,
          storedAt: cached.storedAt,
          epoch,
          byId: new Map(cached.files.map((f) => [f.id, f])),
          acknowledged: new Set(),
        };
      }
      last = check;
      const { rows } = await classifyRows(epoch, rowsFor(cached, check));
      return { files: rows, hash: cached.hash, source: 'network' };
    }
    if (index.files) {
      const storedAt = deps.now();
      // The cache write re-checks the epoch at its turn in the write queue
      // (file-index-cache.ts), so a sign-out during it leaves nothing behind.
      await deps.saveCache(index.hash, index.files, storedAt, { epoch: epoch.account, generation: epoch.cache });
      assertCurrent(epoch);
      last = {
        at: storedAt,
        hash: index.hash,
        storedAt,
        epoch,
        byId: new Map(index.files.map((f) => [f.id, f])),
        acknowledged: new Set(),
      };
      return { files: index.files, hash: index.hash, source: 'network' };
    }
    return { files: cached?.files ?? null, hash: cached?.hash ?? null, source: 'network' };
  }

  async function load(options: FileIndexLoadOptions = {}): Promise<FileIndexLoadResult> {
    const epoch = epochNow();
    dropOtherEpochWindow(epoch);
    const joined = joinable(epoch);
    if (joined) return joined;
    const preloaded = usablePreloaded(epoch, options.cached, options.cachedEpoch);
    if (!options.force) {
      const cached = preloaded !== undefined ? preloaded : await deps.loadCache();
      // The account may have changed while the cache was read: this caller's
      // account is gone, so it gets nothing (and nothing is asked of the
      // server on its behalf under the next account's session).
      assertCurrent(epoch);
      // Another caller of this epoch may have started a request meanwhile.
      const joinedLater = joinable(epoch);
      if (joinedLater) return joinedLater;
      const files = freshFromCache(epoch, cached);
      const check = last;
      if (files && cached && check) {
        const { rows, unknown } = await classifyRows(epoch, files);
        // Round 4: a new file row nobody here can classify. The caller needs
        // the server's answer for it; ask once (joining any request in flight).
        if (options.revalidateUnclassified && newSince(check, unknown)) return start(epoch, cached);
        return { files: rows, hash: cached.hash, source: 'cache' };
      }
      return start(epoch, cached);
    }
    return start(epoch, preloaded);
  }

  function start(epoch: Epoch, preloaded: CachedFileIndex | null | undefined): Promise<FileIndexLoadResult> {
    const joined = joinable(epoch);
    if (joined) return joined;
    const promise = revalidate(epoch, preloaded).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { epoch, promise };
    return promise;
  }

  /** Forget the window and detach any in-flight request (sign-out / sign-in:
   *  wired to every account-epoch advance for the app's loader). */
  function reset(): void {
    inFlight = null;
    last = null;
  }

  /** Test hook: what the loader holds in memory right now. */
  function inspect(): { hasWindow: boolean; inFlight: boolean; windowAccountId: string | null } {
    return {
      hasWindow: last !== null,
      inFlight: inFlight !== null,
      windowAccountId: last?.epoch.account.accountId ?? null,
    };
  }

  return { load, reset, inspect };
}

const defaultLoader = createFileIndexLoader({
  fetchIndex: (hash) => getFileIndex(hash),
  loadCache: loadCachedFileIndex,
  saveCache: (hash, files, storedAt, scope) => saveCachedFileIndex(hash, files, storedAt, undefined, scope),
  cacheGeneration: fileIndexCacheGeneration,
  accountEpoch,
  cacheReadEpoch: cachedFileIndexEpoch,
  classifyLocally: (fileIds) => classifyOwnUploads(fileIds),
  now: () => Date.now(),
  revalidateMs: FILE_INDEX_REVALIDATE_MS,
});

// Sign-out / sign-in: drop the previous account's window (its server rows,
// including file-request key material, live in `last.byId`) at the boundary,
// not at the next call.
onAccountEpochAdvance(() => defaultLoader.reset());

/** Load the vault index for a screen. See the module comment for the rules.
 *  Rejects with `StaleAccountError` when the account changed while it ran. */
export function loadFileIndex(options?: FileIndexLoadOptions): Promise<FileIndexLoadResult> {
  return defaultLoader.load(options);
}

/** Test hook: forget the in-memory window and any in-flight request. */
export function resetFileIndexLoaderForTests(): void {
  defaultLoader.reset();
}

/** Test hook: what the app's loader holds in memory. */
export function fileIndexLoaderStateForTests(): ReturnType<ReturnType<typeof createFileIndexLoader>['inspect']> {
  return defaultLoader.inspect();
}
