/**
 * Smart decrypted photo cache — in-memory LRU + disk cache.
 *
 * Prevents re-downloading and re-decrypting photos when navigating
 * back and forth in PreviewScreen. Two tiers:
 *
 * 1. Memory map: instant lookup, no disk I/O.
 * 2. Disk cache: survives memory eviction, but is bounded by age, count, and
 *    total bytes so fast swiping cannot leave many originals on disk.
 *
 * Thumbnails use a separate persistent store (see thumbnail-cache.ts).
 */

import * as FileSystem from 'expo-file-system/legacy';
import {
  planPhotoCacheEvictions,
  type PhotoCacheDiskEntry,
} from './photo-cache-policy';

const CACHE_DIR = `${FileSystem.cacheDirectory}beebeeb-photo-cache/`;
const MAX_MEMORY_ITEMS = 6;
const MAX_DISK_ITEMS = 12;
const MAX_DISK_BYTES = 256 * 1024 * 1024;
const DISK_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  uri: string; // local file URI
  accessedAt: number;
  sizeBytes: number;
}

const memoryCache = new Map<string, CacheEntry>();

function normalizedExtension(extension?: string | null): string | null {
  if (!extension) return null;
  const ext = extension.replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return ext || null;
}

function cacheKey(fileId: string, extension?: string | null): string {
  const ext = normalizedExtension(extension);
  return ext ? `${fileId}.${ext}` : fileId;
}

function cachePath(fileId: string, extension?: string | null): string {
  return `${CACHE_DIR}${cacheKey(fileId, extension)}`;
}

/**
 * Look up a previously-cached decrypted photo. Returns a local file URI
 * or null if the photo is not cached (or the disk entry has expired).
 */
export async function getCachedPhoto(fileId: string): Promise<string | null> {
  return getCachedPhotoWithExtension(fileId, null);
}

/**
 * Look up a cached decrypted media file. Supplying an extension keeps videos at
 * an AVFoundation-friendly path such as `.mp4` instead of an extensionless
 * cache file.
 */
export async function getCachedPhotoWithExtension(
  fileId: string,
  extension?: string | null,
): Promise<string | null> {
  const key = cacheKey(fileId, extension);
  // Check memory cache first (fast path, no disk I/O)
  const mem = memoryCache.get(key);
  if (mem) {
    mem.accessedAt = Date.now();
    return mem.uri;
  }

  // Check disk cache
  const diskPath = cachePath(fileId, extension);
  try {
    const info = await FileSystem.getInfoAsync(diskPath);
    if (info.exists) {
      const modTime = (info.modificationTime ?? 0) * 1000;
      if (Date.now() - modTime < DISK_TTL_MS) {
        memoryCache.set(key, {
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
  return cachePhotoWithExtension(fileId, sourceUri, null);
}

/**
 * Store a decrypted media file in the cache with an optional decoder-friendly
 * extension. This is required for MP4/MOV playback on iOS.
 */
export async function cachePhotoWithExtension(
  fileId: string,
  sourceUri: string,
  extension?: string | null,
): Promise<string> {
  await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  const key = cacheKey(fileId, extension);
  const diskPath = cachePath(fileId, extension);
  await FileSystem.deleteAsync(diskPath, { idempotent: true }).catch(() => {});
  await FileSystem.copyAsync({ from: sourceUri, to: diskPath });

  const info = await FileSystem.getInfoAsync(diskPath);
  const sizeBytes = info.exists && 'size' in info ? (info.size ?? 0) : 0;
  memoryCache.set(key, {
    uri: diskPath,
    accessedAt: Date.now(),
    sizeBytes,
  });
  evictMemoryIfNeeded();
  await prunePhotoDiskCache();

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

async function listDiskEntries(): Promise<PhotoCacheDiskEntry[]> {
  try {
    const names = await FileSystem.readDirectoryAsync(CACHE_DIR);
    const entries = await Promise.all(
      names.map(async (name) => {
        const uri = `${CACHE_DIR}${name}`;
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) return null;
        return {
          fileId: name,
          uri,
          sizeBytes: info.size ?? 0,
          modifiedAt: (info.modificationTime ?? 0) * 1000,
        };
      }),
    );
    return entries.filter((entry): entry is PhotoCacheDiskEntry => entry != null);
  } catch {
    return [];
  }
}

async function prunePhotoDiskCache(): Promise<void> {
  const entries = await listDiskEntries();
  if (entries.length === 0) return;

  const evictions = planPhotoCacheEvictions(entries, Date.now(), {
    maxItems: MAX_DISK_ITEMS,
    maxBytes: MAX_DISK_BYTES,
    ttlMs: DISK_TTL_MS,
  });
  await Promise.all(
    entries
      .filter((entry) => evictions.has(entry.fileId))
      .map(async (entry) => {
        memoryCache.delete(entry.fileId);
        await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {});
      }),
  );
}

function fileIdFromCacheName(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return name;
  return name.slice(0, dotIndex);
}

/**
 * Remove decrypted preview cache entries for files that no longer exist
 * remotely. This keeps full-size local plaintext cache bounded by remote
 * ownership, separately from the normal age/count/byte limits.
 */
export async function prunePhotoCacheForRemoteFiles(
  retainFileIds: Set<string> | string[],
): Promise<void> {
  const retain = retainFileIds instanceof Set ? retainFileIds : new Set(retainFileIds);
  const entries = await listDiskEntries();
  await Promise.all(entries.map(async (entry) => {
    const fileId = fileIdFromCacheName(entry.fileId);
    if (retain.has(fileId)) return;
    memoryCache.delete(entry.fileId);
    memoryCache.delete(fileId);
    await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {});
  }));
}

/**
 * Wipe the entire photo cache (memory + disk). Called from settings
 * or when the user signs out.
 */
export async function clearPhotoCache(): Promise<void> {
  memoryCache.clear();
  await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
}
