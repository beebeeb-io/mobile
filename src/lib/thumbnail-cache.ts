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

import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

import { THUMB_CACHE_DIR_NAME, type ThumbnailVariant } from './thumbnail-policy';

const THUMB_DIR = `${FileSystem.documentDirectory}${THUMB_CACHE_DIR_NAME}/`;

/** Max concurrent thumbnail download+decrypt operations. */
const MAX_CONCURRENT_LOADS = 6;
/** In-memory cache. Keyed by `${fileId}:${variant}` so the photo grid never
 *  serves a stale small thumbnail when a medium one was requested. */
const memoryThumbPaths = new Map<string, string>();

function cacheKey(fileId: string, variant: ThumbnailVariant): string {
  return `${fileId}:${variant}`;
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
  if (memory) return memory;

  const path = variantPath(fileId, variant);
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      memoryThumbPaths.set(key, path);
      return path;
    }
  } catch {
    return null;
  }

  // Task 0552 migration: pre-variant builds wrote `${fileId}.webp`. We treat
  // those as `medium` (the only variant that was ever uploaded before this
  // task) and move them into the suffixed slot.
  if (variant === 'medium') {
    const legacy = legacyVariantPath(fileId);
    try {
      const legacyInfo = await FileSystem.getInfoAsync(legacy);
      if (legacyInfo.exists) {
        try {
          await FileSystem.moveAsync({ from: legacy, to: path });
          memoryThumbPaths.set(key, path);
          return path;
        } catch {
          // If the rename failed, surface the legacy file as-is so the grid
          // still renders something. It will be re-fetched on next miss.
          memoryThumbPaths.set(key, legacy);
          return legacy;
        }
      }
    } catch {
      // fall through
    }
  }

  // Check for legacy .jpg cached before the WebP migration
  const legacyJpg = `${THUMB_DIR}${fileId}.jpg`;
  try {
    const info = await FileSystem.getInfoAsync(legacyJpg);
    if (info.exists) {
      memoryThumbPaths.set(key, legacyJpg);
      return legacyJpg;
    }
  } catch {
    // fall through
  }

  memoryThumbPaths.delete(key);
  return null;
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
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const path = variantPath(fileId, variant);
  await FileSystem.writeAsStringAsync(path, uint8ArrayToBase64(data), {
    encoding: FileSystem.EncodingType.Base64,
  });
  memoryThumbPaths.set(cacheKey(fileId, variant), path);
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
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const path = variantPath(fileId, variant);
  await FileSystem.writeAsStringAsync(path, base64Data, {
    encoding: FileSystem.EncodingType.Base64,
  });
  memoryThumbPaths.set(cacheKey(fileId, variant), path);
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
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const destPath = variantPath(fileId, variant);
  await FileSystem.copyAsync({ from: sourcePath, to: destPath });
  memoryThumbPaths.set(cacheKey(fileId, variant), destPath);
  return destPath;
}

/**
 * Remove all persisted thumbnails. Use when signing out.
 */
export async function clearThumbnailCache(): Promise<void> {
  memoryThumbPaths.clear();
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
  await Promise.all(candidates.map((path) =>
    FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {}),
  ));
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

function detachAbortListener(item: QueueItem): void {
  if (item.signal && item.onAbort) {
    item.signal.removeEventListener('abort', item.onAbort);
    item.onAbort = undefined;
  }
}

function drainQueue(): void {
  while (activeCount < MAX_CONCURRENT_LOADS && queue.length > 0) {
    const item = queue.shift();
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
    drainQueue();
  });
}

/**
 * Clear the pending queue (e.g. when scrolling away from a section).
 * In-flight loads are not cancelled, but pending ones are resolved as null.
 */
export function clearThumbnailQueue(): void {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;
    detachAbortListener(item);
    item.resolve(null);
  }
}

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
