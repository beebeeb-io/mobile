/**
 * Persistent thumbnail storage.
 *
 * Thumbnails are small (10-50 KB each) and expensive to re-download
 * and decrypt. They live in `documentDirectory` so iOS preserves them
 * across app restarts and cache purges.
 *
 * This module also provides a concurrency-limited thumbnail loader
 * that prevents overwhelming the network or the crypto bridge when
 * many cells become visible at once.
 */

import * as FileSystem from 'expo-file-system';

import { THUMB_CACHE_DIR_NAME } from './thumbnail-policy';

const THUMB_DIR = `${FileSystem.documentDirectory}${THUMB_CACHE_DIR_NAME}/`;

/** Max concurrent thumbnail download+decrypt operations. */
const MAX_CONCURRENT_LOADS = 6;
const memoryThumbPaths = new Map<string, string>();

// ---------------------------------------------------------------------------
// Persistent cache read/write
// ---------------------------------------------------------------------------

/**
 * Check if a thumbnail exists in persistent storage.
 * Returns the local file URI or null.
 */
export async function getCachedThumbnail(
  fileId: string,
): Promise<string | null> {
  const memory = memoryThumbPaths.get(fileId);
  if (memory) return memory;

  const path = `${THUMB_DIR}${fileId}.webp`;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      memoryThumbPaths.set(fileId, path);
      return path;
    }
  } catch {
    return null;
  }

  // Check for legacy .jpg cached before the WebP migration
  const legacyPath = `${THUMB_DIR}${fileId}.jpg`;
  try {
    const info = await FileSystem.getInfoAsync(legacyPath);
    if (info.exists) {
      memoryThumbPaths.set(fileId, legacyPath);
      return legacyPath;
    }
  } catch {
    // fall through
  }

  memoryThumbPaths.delete(fileId);
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
): Promise<string> {
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const path = `${THUMB_DIR}${fileId}.webp`;
  await FileSystem.writeAsStringAsync(path, uint8ArrayToBase64(data), {
    encoding: FileSystem.EncodingType.Base64,
  });
  memoryThumbPaths.set(fileId, path);
  return path;
}

/**
 * Write a decrypted thumbnail from a base64 string to persistent storage.
 * Returns the persisted file URI.
 */
export async function cacheThumbnailBase64(
  fileId: string,
  base64Data: string,
): Promise<string> {
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const path = `${THUMB_DIR}${fileId}.webp`;
  await FileSystem.writeAsStringAsync(path, base64Data, {
    encoding: FileSystem.EncodingType.Base64,
  });
  memoryThumbPaths.set(fileId, path);
  return path;
}

/**
 * Copy an existing thumbnail file into persistent storage.
 * Used when migrating from the volatile cacheDirectory.
 */
export async function persistThumbnailFromPath(
  fileId: string,
  sourcePath: string,
): Promise<string> {
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const destPath = `${THUMB_DIR}${fileId}.webp`;
  await FileSystem.copyAsync({ from: sourcePath, to: destPath });
  memoryThumbPaths.set(fileId, destPath);
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
      const match = /^(.+)\.(webp|jpg)$/i.exec(name);
      if (!match) return;
      const fileId = match[1];
      if (retain.has(fileId)) return;
      memoryThumbPaths.delete(fileId);
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
