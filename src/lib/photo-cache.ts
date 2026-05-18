/**
 * Smart decrypted photo cache — in-memory LRU + disk cache.
 *
 * Prevents re-downloading and re-decrypting photos when navigating
 * back and forth in PreviewScreen. Two tiers:
 *
 * 1. Memory map (20 items): instant lookup, no disk I/O.
 * 2. Disk cache (24h TTL in cacheDirectory): survives memory eviction
 *    but cleaned up after a day to avoid unbounded disk usage.
 *
 * Thumbnails use a separate persistent store (see thumbnail-cache.ts).
 */

import * as FileSystem from 'expo-file-system';

const CACHE_DIR = `${FileSystem.cacheDirectory}beebeeb-photo-cache/`;
const MAX_MEMORY_ITEMS = 20;
const DISK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  uri: string; // local file URI
  accessedAt: number;
  sizeBytes: number;
}

const memoryCache = new Map<string, CacheEntry>();

/**
 * Look up a previously-cached decrypted photo. Returns a local file URI
 * or null if the photo is not cached (or the disk entry has expired).
 */
export async function getCachedPhoto(fileId: string): Promise<string | null> {
  // Check memory cache first (fast path, no disk I/O)
  const mem = memoryCache.get(fileId);
  if (mem) {
    mem.accessedAt = Date.now();
    return mem.uri;
  }

  // Check disk cache
  const diskPath = `${CACHE_DIR}${fileId}`;
  try {
    const info = await FileSystem.getInfoAsync(diskPath);
    if (info.exists) {
      const modTime = (info.modificationTime ?? 0) * 1000;
      if (Date.now() - modTime < DISK_TTL_MS) {
        memoryCache.set(fileId, {
          uri: diskPath,
          accessedAt: Date.now(),
          sizeBytes: info.size ?? 0,
        });
        evictMemoryIfNeeded();
        return diskPath;
      }
      // Expired -- delete
      await FileSystem.deleteAsync(diskPath, { idempotent: true });
    }
  } catch {
    // Disk read failed -- treat as cache miss.
  }

  return null;
}

/**
 * Store a decrypted photo in the cache. Copies the file from `sourceUri`
 * into the cache directory and returns the stable cache path.
 */
export async function cachePhoto(
  fileId: string,
  sourceUri: string,
): Promise<string> {
  await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  const diskPath = `${CACHE_DIR}${fileId}`;
  await FileSystem.copyAsync({ from: sourceUri, to: diskPath });

  const info = await FileSystem.getInfoAsync(diskPath);
  const sizeBytes = info.exists && 'size' in info ? (info.size ?? 0) : 0;
  memoryCache.set(fileId, {
    uri: diskPath,
    accessedAt: Date.now(),
    sizeBytes,
  });
  evictMemoryIfNeeded();

  return diskPath;
}

function evictMemoryIfNeeded(): void {
  if (memoryCache.size <= MAX_MEMORY_ITEMS) return;
  // Remove least recently accessed entries
  const sorted = [...memoryCache.entries()].sort(
    (a, b) => a[1].accessedAt - b[1].accessedAt,
  );
  while (memoryCache.size > MAX_MEMORY_ITEMS) {
    const oldest = sorted.shift();
    if (!oldest) break;
    memoryCache.delete(oldest[0]);
  }
}

/**
 * Wipe the entire photo cache (memory + disk). Called from settings
 * or when the user signs out.
 */
export async function clearPhotoCache(): Promise<void> {
  memoryCache.clear();
  await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
}
