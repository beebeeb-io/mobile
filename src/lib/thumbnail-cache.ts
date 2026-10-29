/**
 * Persistent thumbnail storage.
 *
 * Thumbnails are small (10-100 KB each) and expensive to re-download
 * and decrypt. They live in `documentDirectory` so iOS preserves them
 * across app restarts and cache purges.
 *
 * **Cache key (task 0552):** filenames are `${fileId}.${variant}.webp`. The
 * old single-file-per-id format (`${fileId}.webp`) caused list views that
 * loaded the `small` variant first to "win" — a later Photos grid request
 * for `medium` would silently return the 384px file. The memory map is
 * keyed `${fileId}:${variant}` for the same reason. Legacy unsuffixed
 * files left behind by older builds are migrated lazily into the `medium`
 * slot on first access.
 *
 * This module also provides a concurrency-limited thumbnail loader
 * that prevents overwhelming the network or the crypto bridge when
 * many cells become visible at once.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { gatedPlaintextWrite } from './plaintext-gate';
import { Platform } from 'react-native';

import { notePlaintextPathCreated } from './plaintext-storage';
import { THUMB_CACHE_DIR_NAME, type ThumbnailVariant } from './thumbnail-policy';
import { accountEpoch, onAccountEpochAdvance, type AccountEpoch } from './account-epoch';
import { getModernThumbnailFs } from './thumbnail-fs-modern';
import {
  THUMBNAIL_LOAD_CANCELLED,
  type ThumbnailLoadResult,
} from './thumbnail-load-outcome';

const THUMB_DIR = `${FileSystem.documentDirectory}${THUMB_CACHE_DIR_NAME}/`;

/** Max concurrent thumbnail download+decrypt operations. */
const MAX_CONCURRENT_LOADS = 6;
/**
 * Task 2233 round 2 (P1-2) — at most this many unique jobs may WAIT for a slot.
 *
 * Jobs are coalesced by fileId (a cell and the prefetch asking for the same
 * thumbnail share one job), so this counts distinct thumbnails, not callers.
 * On overflow the oldest PREFETCH-ONLY job is dropped first: a mounted cell's
 * job must win over speculative work. A dropped job resolves CANCELLED, never
 * "no thumbnail".
 */
export const MAX_WAITING_THUMBNAIL_JOBS = 256;
/** Task 2233 item 1 (A6) — in-memory path map bound (LRU by touch). */
const MAX_MEMORY_THUMB_PATHS = 3000;
const memoryThumbPaths = new Map<string, string>();


function cacheKey(fileId: string, variant: ThumbnailVariant): string {
  return `${fileId}:${variant}`;
}

function variantName(fileId: string, variant: ThumbnailVariant): string {
  return `${fileId}.${variant}.webp`;
}

/** LRU-touch insertion: Map preserves insertion order, so re-setting an
 *  existing key moves it to the newest position and eviction is shift(). */
function rememberPath(key: string, path: string): void {
  memoryThumbPaths.delete(key);
  memoryThumbPaths.set(key, path);
  while (memoryThumbPaths.size > MAX_MEMORY_THUMB_PATHS) {
    const oldest = memoryThumbPaths.keys().next();
    if (oldest.done) break;
    memoryThumbPaths.delete(oldest.value);
  }
}

// A6 — names present in THUMB_DIR, hydrated once per session from the
// directory listing. A hit then costs 0 getInfoAsync bridge calls; a miss
// costs at most one (the verification fallback for a path written after
// hydration by code this module does not own).
let diskNames: Set<string> | null = null;
let hydration: Promise<void> | null = null;
let indexUsable = false;
/**
 * Task 2233 round 2 (P2-6a) — a listing that was started before a reset
 * (account switch / sign-out purge) must never be installed afterwards.
 */
let indexGeneration = 0;

/**
 * A folder that does not exist yet (first run, or removed by the sign-out
 * purge / the iOS native purge) is an EMPTY cache, not a broken index. Any
 * other listing failure means the index cannot be trusted this session.
 */
function isMissingFolderError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /enoent|no such file|no such directory|does not exist|doesn't exist|not exist|unable to find/.test(message);
}

/**
 * Task 2233 round 3 (N7) — ask the filesystem instead of parsing the error
 * text. iOS spells the message with a curly apostrophe ("doesn’t exist"), so
 * the regex above misses it on that platform. Only a stat that says the
 * folder is gone counts as "missing"; a failed stat is not evidence.
 */
async function folderIsMissing(): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(THUMB_DIR);
    return info.exists === false;
  } catch {
    return false;
  }
}

function resetCacheIndex(): void {
  indexGeneration += 1;
  diskNames = null;
  hydration = null;
  indexUsable = false;
}

async function cacheIndex(): Promise<void> {
  if (diskNames) return;
  if (!hydration) {
    const generation = indexGeneration;
    hydration = FileSystem.readDirectoryAsync(THUMB_DIR)
      .then((names) => {
        if (generation !== indexGeneration) return;
        diskNames = new Set(names);
        indexUsable = true;
      })
      .catch(async (err) => {
        if (generation !== indexGeneration) return;
        // N7 — the message check is a fast path; when it does not match (iOS
        // curly apostrophe) or there is no message, ask the filesystem.
        const missing = isMissingFolderError(err) || await folderIsMissing();
        if (generation !== indexGeneration) return;
        diskNames = new Set();
        indexUsable = missing;
      })
      .finally(() => {
        if (generation === indexGeneration) hydration = null;
      });
  }
  await hydration;
}

function noteDiskName(name: string): void {
  diskNames?.add(name);
}

function forgetDiskName(name: string): void {
  diskNames?.delete(name);
}

/**
 * Task 2233 round 2 (P2-6c) — `pruneThumbnailCache` deletes files behind this
 * module's back; it must drop the names from the hydrated index too, or a
 * later read would serve a path that no longer exists until the next restart.
 */
export function forgetCachedThumbnailName(name: string): void {
  forgetDiskName(name);
}


function variantPath(fileId: string, variant: ThumbnailVariant): string {
  return `${THUMB_DIR}${fileId}.${variant}.webp`;
}

/** Legacy single-file-per-id path. Files written before task 0552 used this. */
function legacyVariantPath(fileId: string): string {
  return `${THUMB_DIR}${fileId}.webp`;
}

// ---------------------------------------------------------------------------
// Persistent cache read/write
// ---------------------------------------------------------------------------

/**
 * Check if a thumbnail exists in persistent storage.
 * Returns the local file URI or null.
 *
 * `variant` defaults to `'medium'` because the Photos grid is by far the
 * dominant caller. Pass an explicit variant for screens that genuinely need
 * a different tier.
 */
export async function getCachedThumbnail(
  fileId: string,
  variant: ThumbnailVariant = 'medium',
): Promise<string | null> {
  const key = cacheKey(fileId, variant);
  const memory = memoryThumbPaths.get(key);
  if (memory) {
    rememberPath(key, memory);
    return memory;
  }

  const path = variantPath(fileId, variant);
  const name = variantName(fileId, variant);
  await cacheIndex();

  if (indexUsable && diskNames) {
    if (diskNames.has(name)) {
      rememberPath(key, path);
      return path;
    }

    // Task 0552 migration: pre-variant builds wrote `${fileId}.webp`. We treat
    // those as `medium` (the only variant that was ever uploaded before this
    // task) and move them into the suffixed slot.
    if (variant === 'medium') {
      const legacyName = `${fileId}.webp`;
      if (diskNames.has(legacyName)) {
        const legacy = `${THUMB_DIR}${legacyName}`;
        try {
          await FileSystem.moveAsync({ from: legacy, to: path });
          forgetDiskName(legacyName);
          noteDiskName(name);
          rememberPath(key, path);
          return path;
        } catch {
          // If the rename failed, surface the legacy file as-is so the grid
          // still renders something. It will be re-fetched on next miss.
          rememberPath(key, legacy);
          return legacy;
        }
      }
    }

    // Check for legacy .jpg cached before the WebP migration
    const legacyJpgName = `${fileId}.jpg`;
    if (diskNames.has(legacyJpgName)) {
      const legacyJpg = `${THUMB_DIR}${legacyJpgName}`;
      rememberPath(key, legacyJpg);
      return legacyJpg;
    }

    // One verification stat: a writer outside this module may have created
    // the file after hydration (A6: a miss costs at most 1 getInfoAsync).
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) {
        noteDiskName(name);
        rememberPath(key, path);
        return path;
      }
    } catch {
      return null;
    }
    memoryThumbPaths.delete(key);
    return null;
  }

  // Hydration failed (unreadable directory): fall back to stat-based lookup,
  // the pre-A6 behaviour.
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      rememberPath(key, path);
      return path;
    }
  } catch {
    return null;
  }

  if (variant === 'medium') {
    const legacy = legacyVariantPath(fileId);
    try {
      const legacyInfo = await FileSystem.getInfoAsync(legacy);
      if (legacyInfo.exists) {
        try {
          await FileSystem.moveAsync({ from: legacy, to: path });
          rememberPath(key, path);
          return path;
        } catch {
          rememberPath(key, legacy);
          return legacy;
        }
      }
    } catch {
      // fall through
    }
  }

  const legacyJpg = `${THUMB_DIR}${fileId}.jpg`;
  try {
    const info = await FileSystem.getInfoAsync(legacyJpg);
    if (info.exists) {
      rememberPath(key, legacyJpg);
      return legacyJpg;
    }
  } catch {
    // fall through
  }

  memoryThumbPaths.delete(key);
  return null;
}

/**
 * Task 2233 item 1 (A5) — the thumbnail directory is created once per
 * session, not once per tile (`makeDirectoryAsync` per write showed up in the
 * per-cell cost model).
 */
let dirReady: Promise<void> | null = null;

async function ensureThumbDir(): Promise<void> {
  if (!dirReady) {
    dirReady = (async () => {
      const modern = getModernThumbnailFs();
      if (modern) {
        await modern.ensureDir(THUMB_DIR);
      } else {
        await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
      }
      notePlaintextPathCreated();
    })().catch((err) => {
      dirReady = null;
      throw err;
    });
  }
  return dirReady;
}

/**
 * A5 — write the decrypted bytes, not base64. The modern expo-file-system
 * `File.write(Uint8Array)` takes the array as-is (no JS string, no native
 * base64 decode); the legacy string writer remains only as a fallback for
 * builds/runtimes where the modern module is unavailable. Always under the
 * sign-out plaintext lease.
 */
async function writeThumbnailBytes(path: string, data: Uint8Array): Promise<void> {
  const modern = getModernThumbnailFs();
  await gatedPlaintextWrite('thumbnail cache', path, FileSystem, async () => {
    if (modern) {
      await modern.writeBytes(path, data);
      return;
    }
    await FileSystem.writeAsStringAsync(path, uint8ArrayToBase64(data), {
      encoding: FileSystem.EncodingType.Base64,
    });
  });
}

/**
 * Write a decrypted thumbnail to persistent storage.
 * `data` is the raw WebP bytes as a Uint8Array.
 * Returns the persisted file URI.
 */
export async function cacheThumbnail(
  fileId: string,
  data: Uint8Array,
  variant: ThumbnailVariant = 'medium',
): Promise<string> {
  await ensureThumbDir();
  const path = variantPath(fileId, variant);
  try {
    await writeThumbnailBytes(path, data);
  } catch (err) {
    // P2-5 — the folder can vanish under a live memo: the sign-out purge can
    // race a write, and the iOS native service purges the directory on its
    // own. Without recovery every later write fails until the app restarts,
    // so drop the memo, recreate once and retry the write once.
    //
    // N7 — decide "the folder is gone" by statting it, not by parsing the
    // error message: iOS says "doesn’t exist" with a curly apostrophe.
    if (!(await folderIsMissing())) throw err;
    dirReady = null;
    await ensureThumbDir();
    await writeThumbnailBytes(path, data);
  }
  rememberPath(cacheKey(fileId, variant), path);
  noteDiskName(variantName(fileId, variant));
  return path;
}

/**
 * Copy an existing thumbnail file into persistent storage.
 * Used when migrating from the volatile cacheDirectory.
 */
export async function persistThumbnailFromPath(
  fileId: string,
  sourcePath: string,
  variant: ThumbnailVariant = 'medium',
): Promise<string> {
  await ensureThumbDir();
  const destPath = variantPath(fileId, variant);
  await gatedPlaintextWrite('thumbnail cache', destPath, FileSystem, () =>
    FileSystem.copyAsync({ from: sourcePath, to: destPath }),
  );
  rememberPath(cacheKey(fileId, variant), destPath);
  noteDiskName(variantName(fileId, variant));
  return destPath;
}

/**
 * Remove all persisted thumbnails. Use when signing out.
 */
export async function clearThumbnailCache(): Promise<void> {
  memoryThumbPaths.clear();
  resetCacheIndex();
  dirReady = null;
  await FileSystem.deleteAsync(THUMB_DIR, { idempotent: true });
}

/**
 * Invalidate every cached variant for a single file id (task 0553 fix).
 *
 * The thumbnail-repair worker uploads a fresh server thumbnail when a file is
 * detected as DEGRADED, but the on-disk cache and the in-memory path map still
 * point at the OLD, blurry render. Without this call, the Photos grid keeps
 * showing the stale version until the user manually clears the app cache.
 *
 * Removes every variant on disk (small/medium/large + the legacy
 * `${fileId}.webp` / `${fileId}.jpg` paths) and drops the in-memory entries
 * so the next read falls through to `fetchDecryptedThumbnailUri`, which will
 * pull the freshly uploaded blob from the server.
 *
 * Best-effort: failures must never abort a repair tick. The worst case is
 * the user keeps seeing the old thumbnail — exactly what they see today.
 */
export async function invalidateCachedThumbnail(fileId: string): Promise<void> {
  if (!fileId) return;
  for (const variant of ['small', 'medium', 'large'] as const) {
    memoryThumbPaths.delete(cacheKey(fileId, variant));
  }
  const candidates = [
    variantPath(fileId, 'small'),
    variantPath(fileId, 'medium'),
    variantPath(fileId, 'large'),
    legacyVariantPath(fileId),
    `${THUMB_DIR}${fileId}.jpg`,
  ];
  forgetDiskName(variantName(fileId, 'small'));
  forgetDiskName(variantName(fileId, 'medium'));
  forgetDiskName(variantName(fileId, 'large'));
  forgetDiskName(`${fileId}.webp`);
  forgetDiskName(`${fileId}.jpg`);
  await Promise.all(candidates.map((path) =>
    FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {}),
  ));
}

/** Bulk JS-cache invalidation — the reconcile (0817) drops thumbnails for files
 *  that no longer exist server-side. */
export async function invalidateCachedThumbnails(fileIds: string[]): Promise<void> {
  await Promise.all(fileIds.map((id) => invalidateCachedThumbnail(id)));
}

// Native ThumbnailService in-memory cache/state invalidation (0817). The JS disk
// cache is handled above / by pruneThumbnailsForRemoteFiles; this clears the
// native service's per-file FSM state + URL cache so it doesn't serve a stale
// hit. Guarded — the method only exists in builds that shipped it; older builds
// silently no-op (the native in-memory cache is per-session anyway).
let _thumbNative: { invalidateCacheEntries?: (fileIds: string[]) => Promise<void> } | null | undefined;
function thumbNative(): { invalidateCacheEntries?: (fileIds: string[]) => Promise<void> } | null {
  if (_thumbNative === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { requireOptionalNativeModule } = require('expo-modules-core');
      _thumbNative = requireOptionalNativeModule('ThumbnailService') ?? null;
    } catch {
      _thumbNative = null;
    }
  }
  return _thumbNative ?? null;
}

export async function invalidateNativeThumbnailCache(fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const native = thumbNative();
  if (typeof native?.invalidateCacheEntries === 'function') {
    await native.invalidateCacheEntries(fileIds).catch(() => {});
  }
}

/**
 * Remove persisted thumbnails whose remote file no longer exists.
 *
 * Thumbnails are intentionally long-lived because they are expensive to
 * download and decrypt. This is the lifecycle counterweight: after an
 * authoritative remote listing, files not present in `retainFileIds` can be
 * removed locally.
 */
export async function pruneThumbnailsForRemoteFiles(
  retainFileIds: Set<string> | string[],
): Promise<void> {
  const retain = retainFileIds instanceof Set ? retainFileIds : new Set(retainFileIds);
  try {
    const names = await FileSystem.readDirectoryAsync(THUMB_DIR);
    await Promise.all(names.map(async (name) => {
      // Match `${id}.${variant}.webp` (task 0552) or legacy `${id}.{webp|jpg}`.
      const variantMatch = /^([^.]+)\.(small|medium|large)\.webp$/i.exec(name);
      const legacyMatch = /^(.+)\.(webp|jpg)$/i.exec(name);
      const match = variantMatch ?? legacyMatch;
      if (!match) return;
      const fileId = match[1];
      if (retain.has(fileId)) return;
      // Drop every variant from the memory map for this file.
      for (const v of ['small', 'medium', 'large'] as const) {
        memoryThumbPaths.delete(cacheKey(fileId, v));
      }
      await FileSystem.deleteAsync(`${THUMB_DIR}${name}`, { idempotent: true }).catch(() => {});
      forgetDiskName(name);
    }));
  } catch {
    // Best-effort cleanup; cache cleanup must not affect the photo grid.
  }
}

// ---------------------------------------------------------------------------
// Concurrency-limited thumbnail loading queue
// ---------------------------------------------------------------------------

/**
 * Loads one thumbnail. Receives the job's own abort signal (aborts only when
 * every caller that joined the job has gone away) and the account epoch
 * captured at enqueue, so the loader can refuse a write for a stale account.
 */
export type ThumbnailLoader = (
  fileId: string,
  signal?: AbortSignal,
  epoch?: AccountEpoch,
) => Promise<ThumbnailLoadResult>;

export interface EnqueueThumbnailOptions {
  /** Speculative work (prefetch). Yields to cell-owned jobs and is dropped first. */
  prefetch?: boolean;
}

interface QueueJoiner {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (result: ThumbnailLoadResult) => void;
  reject: (err: unknown) => void;
}

interface QueueJob {
  fileId: string;
  loader: ThumbnailLoader;
  /** The job's own controller: one caller's abort must never kill another's load. */
  controller: AbortController;
  joiners: QueueJoiner[];
  queued: boolean;
  prefetchOnly: boolean;
  cancelled: boolean;
  settled: boolean;
  /** Captured at first enqueue; checked right before the gated write. */
  epoch: AccountEpoch;
}

/** FIFO by first enqueue. */
const queue: QueueJob[] = [];
/** One job per fileId — the queue is the only in-flight dedupe. */
const jobsByFileId = new Map<string, QueueJob>();
const running = new Set<QueueJob>();
let activeCount = 0;
let droppedCount = 0;

function detachJoiner(joiner: QueueJoiner): void {
  if (joiner.signal && joiner.onAbort) {
    joiner.signal.removeEventListener('abort', joiner.onAbort);
    joiner.onAbort = undefined;
  }
}

function forgetJob(job: QueueJob): void {
  if (jobsByFileId.get(job.fileId) === job) jobsByFileId.delete(job.fileId);
}

function takeJoiners(job: QueueJob): QueueJoiner[] {
  const joiners = job.joiners;
  job.joiners = [];
  return joiners;
}

function resolveJoiners(job: QueueJob, result: ThumbnailLoadResult): void {
  for (const joiner of takeJoiners(job)) {
    detachJoiner(joiner);
    joiner.resolve(result);
  }
}

function rejectJoiners(job: QueueJob, error: unknown): void {
  for (const joiner of takeJoiners(job)) {
    detachJoiner(joiner);
    joiner.reject(error);
  }
}

/**
 * Withdraw a job: queued jobs leave the queue, running ones have their fetch
 * aborted. Every joined caller resolves CANCELLED — never "no thumbnail".
 */
function cancelJob(job: QueueJob): void {
  if (job.settled) return;
  job.cancelled = true;
  forgetJob(job);
  if (job.queued) {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.queued = false;
  }
  job.controller.abort();
  resolveJoiners(job, THUMBNAIL_LOAD_CANCELLED);
}

/** Add a caller to an existing job. A cell caller promotes a prefetch job. */
function joinJob(
  job: QueueJob,
  signal: AbortSignal | undefined,
  prefetch: boolean,
): Promise<ThumbnailLoadResult> {
  if (prefetch === false) job.prefetchOnly = false;
  if (job.settled) return Promise.resolve(THUMBNAIL_LOAD_CANCELLED);
  return new Promise<ThumbnailLoadResult>((resolve, reject) => {
    const joiner: QueueJoiner = { resolve, reject };
    if (signal) {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        joiner.onAbort = undefined;
        const index = job.joiners.indexOf(joiner);
        if (index >= 0) job.joiners.splice(index, 1);
        resolve(THUMBNAIL_LOAD_CANCELLED);
        // Abort the underlying fetch only when nobody else wants it.
        if (job.joiners.length === 0) cancelJob(job);
      };
      joiner.signal = signal;
      joiner.onAbort = onAbort;
      signal.addEventListener('abort', onAbort);
    }
    job.joiners.push(joiner);
  });
}

/** P1-2 — count unique jobs; drop the oldest prefetch-only job first. */
function enforceWaitingBound(): void {
  while (queue.length > MAX_WAITING_THUMBNAIL_JOBS) {
    let index = queue.findIndex((job) => job.prefetchOnly);
    if (index < 0) index = 0;
    const [dropped] = queue.splice(index, 1);
    dropped.queued = false;
    droppedCount += 1;
    cancelJob(dropped);
  }
}

function startJob(job: QueueJob): void {
  activeCount += 1;
  running.add(job);
  let pending: Promise<ThumbnailLoadResult>;
  try {
    pending = Promise.resolve(job.loader(job.fileId, job.controller.signal, job.epoch));
  } catch (err) {
    pending = Promise.reject(err);
  }
  pending
    .then((result) => finishJob(job, undefined, result))
    .catch((err) => finishJob(job, err));
}

function finishJob(job: QueueJob, error: unknown, result?: ThumbnailLoadResult): void {
  if (job.settled) return;
  job.settled = true;
  job.queued = false;
  running.delete(job);
  forgetJob(job);
  activeCount = Math.max(0, activeCount - 1);
  if (job.cancelled) {
    // Joiners were already resolved CANCELLED when the job was withdrawn.
    resolveJoiners(job, THUMBNAIL_LOAD_CANCELLED);
  } else if (error !== undefined) {
    rejectJoiners(job, error);
  } else {
    resolveJoiners(job, result ?? null);
  }
  drainQueue();
}

function drainQueue(): void {
  while (activeCount < MAX_CONCURRENT_LOADS && queue.length > 0) {
    // FIFO by first enqueue, but a mounted cell's job goes before speculative
    // prefetch work. Abort-on-unmount already removes fling leftovers, so
    // FIFO is the correct order for the rest.
    let index = queue.findIndex((job) => !job.prefetchOnly);
    if (index < 0) index = 0;
    const [job] = queue.splice(index, 1);
    if (!job) break;
    job.queued = false;
    if (job.cancelled || job.joiners.length === 0) {
      cancelJob(job);
      continue;
    }
    startJob(job);
  }
}

/**
 * Enqueue a thumbnail load. If the concurrency limit has not been reached, the
 * load starts immediately. Otherwise it waits for a slot.
 *
 * Callers asking for the same `fileId` share ONE job (and one network fetch):
 * a second enqueue joins the existing job and adds its signal, and the job is
 * aborted only when every joined signal has aborted. A cancelled or dropped
 * load resolves `THUMBNAIL_LOAD_CANCELLED`; only a real missing/failed
 * thumbnail resolves `null`.
 */
export function enqueueThumbnailLoad(
  fileId: string,
  loader: ThumbnailLoader,
  signal?: AbortSignal,
  options: EnqueueThumbnailOptions = {},
): Promise<ThumbnailLoadResult> {
  if (Platform.OS !== 'android') {
    throw new Error('enqueueThumbnailLoad is Android-only — iOS uses BeebeebThumbnails native service');
  }
  const prefetch = options.prefetch === true;
  if (signal?.aborted) return Promise.resolve(THUMBNAIL_LOAD_CANCELLED);

  const existing = jobsByFileId.get(fileId);
  if (existing) return joinJob(existing, signal, prefetch);

  const job: QueueJob = {
    fileId,
    loader,
    controller: new AbortController(),
    joiners: [],
    queued: true,
    prefetchOnly: prefetch,
    cancelled: false,
    settled: false,
    epoch: accountEpoch(),
  };
  jobsByFileId.set(fileId, job);
  queue.push(job);
  const result = joinJob(job, signal, prefetch);
  enforceWaitingBound();
  drainQueue();
  return result;
}

/** Diagnostics (tests + the optional runtime counter): current queue state. */
export function thumbnailQueueStats(): { active: number; waiting: number; dropped: number } {
  return { active: activeCount, waiting: queue.length, dropped: droppedCount };
}

/**
 * Clear the pending queue (e.g. when scrolling away from a section).
 * In-flight loads are not cancelled, but pending ones resolve CANCELLED.
 */
export function clearThumbnailQueue(): void {
  for (const job of [...queue]) cancelJob(job);
}

/**
 * A4/A6 + round 2 P2-7 — an account switch invalidates every queued AND
 * running job, the memoized directory state and every cached name for the
 * previous account: nothing from it may land in the new session.
 */
onAccountEpochAdvance(() => {
  clearThumbnailQueue();
  for (const job of [...running]) cancelJob(job);
  memoryThumbPaths.clear();
  resetCacheIndex();
  dirReady = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
