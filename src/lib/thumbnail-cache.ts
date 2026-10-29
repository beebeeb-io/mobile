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
import { onAccountEpochAdvance } from './account-epoch';
import { getModernThumbnailFs } from './thumbnail-fs-modern';

const THUMB_DIR = `${FileSystem.documentDirectory}${THUMB_CACHE_DIR_NAME}/`;

/** Max concurrent thumbnail download+decrypt operations. */
const MAX_CONCURRENT_LOADS = 6;
/**
 * Task 2233 item 1 (A3) — at most this many jobs may WAIT for a slot. A long
 * fling enqueues far more; the OLDEST waiting job is resolved `null` on
 * overflow and the newest job is served first, because the cell the user is
 * looking at now was enqueued last.
 */
export const MAX_WAITING_THUMBNAIL_JOBS = 96;
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

function resetCacheIndex(): void {
  diskNames = null;
  hydration = null;
  indexUsable = false;
}

async function cacheIndex(): Promise<void> {
  if (diskNames) return;
  if (!hydration) {
    hydration = FileSystem.readDirectoryAsync(THUMB_DIR)
      .then((names) => {
        diskNames = new Set(names);
        indexUsable = true;
      })
      .catch(() => {
        diskNames = new Set();
        indexUsable = false;
      })
      .finally(() => { hydration = null; });
  }
  await hydration;
}

function noteDiskName(name: string): void {
  diskNames?.add(name);
}

function forgetDiskName(name: string): void {
  diskNames?.delete(name);
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
  await writeThumbnailBytes(path, data);
  rememberPath(cacheKey(fileId, variant), path);
  noteDiskName(variantName(fileId, variant));
  return path;
}

/**
 * Write a decrypted thumbnail from a base64 string to persistent storage.
 * Returns the persisted file URI.
 */
export async function cacheThumbnailBase64(
  fileId: string,
  base64Data: string,
  variant: ThumbnailVariant = 'medium',
): Promise<string> {
  if (Platform.OS !== 'android') {
    throw new Error('cacheThumbnailBase64 is Android-only — iOS thumbnails are managed by the native ThumbnailService actor');
  }
  await ensureThumbDir();
  const path = variantPath(fileId, variant);
  await gatedPlaintextWrite('thumbnail cache', path, FileSystem, () =>
    FileSystem.writeAsStringAsync(path, base64Data, {
      encoding: FileSystem.EncodingType.Base64,
    }),
  );
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

export type ThumbnailLoader = (
  fileId: string,
  signal?: AbortSignal,
) => Promise<string | null>;

interface QueueItem {
  fileId: string;
  loader: ThumbnailLoader;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (uri: string | null) => void;
  reject: (err: unknown) => void;
}

const queue: QueueItem[] = [];
let activeCount = 0;
let droppedCount = 0;

function detachAbortListener(item: QueueItem): void {
  if (item.signal && item.onAbort) {
    item.signal.removeEventListener('abort', item.onAbort);
    item.onAbort = undefined;
  }
}

function drainQueue(): void {
  while (activeCount < MAX_CONCURRENT_LOADS && queue.length > 0) {
    // A3 — newest first: the cell the user is looking at now was enqueued
    // last, so it must not wait behind a fling's stale jobs.
    const item = queue.pop();
    if (!item) break;
    detachAbortListener(item);
    if (item.signal?.aborted) {
      item.resolve(null);
      continue;
    }
    activeCount++;
    item.loader(item.fileId, item.signal)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeCount--;
        drainQueue();
      });
  }
}

/**
 * Enqueue a thumbnail load. If the concurrency limit has not been reached,
 * the load starts immediately. Otherwise it waits for a slot.
 *
 * `loader` is a function that downloads+decrypts a single thumbnail and
 * returns the local file URI (or null on failure). If `signal` aborts before
 * the slot opens, the entry is dropped from the queue and the promise resolves
 * with null. Once running, the signal is passed to the loader so it can abort
 * the underlying fetch.
 */
export function enqueueThumbnailLoad(
  fileId: string,
  loader: ThumbnailLoader,
  signal?: AbortSignal,
): Promise<string | null> {
  if (Platform.OS !== 'android') {
    throw new Error('enqueueThumbnailLoad is Android-only — iOS uses BeebeebThumbnails native service');
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const item: QueueItem = { fileId, loader, signal, resolve, reject };
    if (signal) {
      const onAbort = () => {
        const idx = queue.indexOf(item);
        if (idx >= 0) {
          queue.splice(idx, 1);
          detachAbortListener(item);
          resolve(null);
        }
      };
      item.onAbort = onAbort;
      signal.addEventListener('abort', onAbort);
    }
    queue.push(item);
    // A3 — bound the waiting set; the OLDEST waiting job loses its slot.
    if (queue.length > MAX_WAITING_THUMBNAIL_JOBS) {
      const dropped = queue.shift();
      if (dropped) {
        detachAbortListener(dropped);
        droppedCount += 1;
        dropped.resolve(null);
      }
    }
    drainQueue();
  });
}

/** Diagnostics (tests + the optional runtime counter): current queue state. */
export function thumbnailQueueStats(): { active: number; waiting: number; dropped: number } {
  return { active: activeCount, waiting: queue.length, dropped: droppedCount };
}

/**
 * Clear the pending queue (e.g. when scrolling away from a section).
 * In-flight loads are not cancelled, but pending ones are resolved as null.
 */
export function clearThumbnailQueue(): void {
  while (queue.length > 0) {
    const item = queue.pop();
    if (!item) continue;
    detachAbortListener(item);
    item.resolve(null);
  }
}

/**
 * A4/A6 — an account switch invalidates every queued job and every cached
 * name for the previous account: nothing from it may land in the new session.
 */
onAccountEpochAdvance(() => {
  clearThumbnailQueue();
  memoryThumbPaths.clear();
  resetCacheIndex();
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
