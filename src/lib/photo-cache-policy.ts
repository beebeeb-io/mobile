export interface PhotoCacheDiskEntry {
  fileId: string;
  uri: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface PhotoCacheLimits {
  maxItems: number;
  maxBytes: number;
  ttlMs: number;
}

export function planPhotoCacheEvictions(
  entries: PhotoCacheDiskEntry[],
  now: number,
  limits: PhotoCacheLimits,
): Set<string> {
  const evict = new Set<string>();
  const survivors = entries
    .filter((entry) => {
      const expired = now - entry.modifiedAt >= limits.ttlMs;
      if (expired) evict.add(entry.fileId);
      return !expired;
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt);

  let totalBytes = 0;
  let kept = 0;
  for (const entry of survivors) {
    totalBytes += entry.sizeBytes;
    kept += 1;
    if (kept > limits.maxItems || totalBytes > limits.maxBytes) {
      evict.add(entry.fileId);
    }
  }

  return evict;
}
