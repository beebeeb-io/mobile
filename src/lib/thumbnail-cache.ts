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

const THUMB_DIR = `${FileSystem.documentDirectory}beebeeb-thumbnails/`;

/** Max concurrent thumbnail download+decrypt operations. */
const MAX_CONCURRENT_LOADS = 5;

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
  const path = `${THUMB_DIR}${fileId}.jpg`;
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? path : null;
  } catch {
    return null;
  }
}

/**
 * Write a decrypted thumbnail to persistent storage.
 * `data` is the raw JPEG bytes as a Uint8Array.
 * Returns the persisted file URI.
 */
export async function cacheThumbnail(
  fileId: string,
  data: Uint8Array,
): Promise<string> {
  await FileSystem.makeDirectoryAsync(THUMB_DIR, { intermediates: true });
  const path = `${THUMB_DIR}${fileId}.jpg`;
  await FileSystem.writeAsStringAsync(path, uint8ArrayToBase64(data), {
    encoding: FileSystem.EncodingType.Base64,
  });
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
  const path = `${THUMB_DIR}${fileId}.jpg`;
  await FileSystem.writeAsStringAsync(path, base64Data, {
    encoding: FileSystem.EncodingType.Base64,
  });
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
  const destPath = `${THUMB_DIR}${fileId}.jpg`;
  await FileSystem.copyAsync({ from: sourcePath, to: destPath });
  return destPath;
}

/**
 * Remove all persisted thumbnails. Use when signing out.
 */
export async function clearThumbnailCache(): Promise<void> {
  await FileSystem.deleteAsync(THUMB_DIR, { idempotent: true });
}

// ---------------------------------------------------------------------------
// Concurrency-limited thumbnail loading queue
// ---------------------------------------------------------------------------

type ThumbnailLoader = (fileId: string) => Promise<string | null>;

interface QueueItem {
  fileId: string;
  resolve: (uri: string | null) => void;
  reject: (err: unknown) => void;
}

const queue: QueueItem[] = [];
let activeCount = 0;

function drainQueue(loader: ThumbnailLoader): void {
  while (activeCount < MAX_CONCURRENT_LOADS && queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    activeCount++;
    loader(item.fileId)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeCount--;
        drainQueue(loader);
      });
  }
}

/**
 * Enqueue a thumbnail load. If the concurrency limit has not been reached,
 * the load starts immediately. Otherwise it waits for a slot.
 *
 * `loader` is a function that downloads+decrypts a single thumbnail and
 * returns the local file URI (or null on failure).
 */
export function enqueueThumbnailLoad(
  fileId: string,
  loader: ThumbnailLoader,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    queue.push({ fileId, resolve, reject });
    drainQueue(loader);
  });
}

/**
 * Clear the pending queue (e.g. when scrolling away from a section).
 * In-flight loads are not cancelled, but pending ones are resolved as null.
 */
export function clearThumbnailQueue(): void {
  while (queue.length > 0) {
    const item = queue.shift();
    if (item) item.resolve(null);
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
