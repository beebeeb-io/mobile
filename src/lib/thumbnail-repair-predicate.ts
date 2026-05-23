/**
 * Thumbnail quality predicates for the bulk backfill worker (task 0553).
 *
 * Extracted from `ThumbnailRepairWorker.tsx` so it can be unit-tested in
 * isolation (the worker module pulls in React, NetInfo, AsyncStorage etc).
 */

import type { FileEntry } from './api';

/**
 * Decoded ciphertext bytes below this threshold are treated as DEGRADED.
 * The pre-0552 50 KB encrypted-thumbnail cap forced complex photos down the
 * degrade ladder to 384px @ q0.54 — visibly blurry on a 2-col Photos grid.
 * Anything ≥ 30 KB ciphertext is plausibly already a decent thumbnail.
 */
export const DEGRADED_THUMBNAIL_BYTES_THRESHOLD = 30 * 1024;

/**
 * Predicate for "degraded" thumbnails. A file qualifies when:
 *   - it is a media file the server flagged with a thumbnail
 *   - the encrypted thumbnail blob is small enough that it was almost
 *     certainly produced under the pre-0552 50 KB cap
 *
 * `thumbnail_bytes` is surfaced by the server post-0553. When the server
 * hasn't been updated yet (field missing), we fall through to treating any
 * thumbnail as a candidate — the worker is opt-in from a user button, so the
 * user has already accepted the cost.
 */
export function isDegradedThumbnail(file: FileEntry): boolean {
  if (file.is_folder || file.is_uploading) return false;
  if (file.has_thumbnail !== true) return false;
  const bytes = file.thumbnail_bytes;
  if (bytes == null) return true;
  return bytes < DEGRADED_THUMBNAIL_BYTES_THRESHOLD;
}
