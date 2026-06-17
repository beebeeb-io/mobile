/**
 * Delete-cascade dispatcher (task 0818, data-consistency Layer 2).
 *
 * One entry point — `onFilesDeleted(ids)` — that fans a delete out to EVERY
 * derived store, reusing the 0817 per-store invalidation primitives. Wired into
 * BOTH delete sources:
 *   - LOCAL deletes (FilesScreen trash/batch/swipe/delete-folder, TrashScreen
 *     permanent) — the caller expands the folder subtree from the in-memory tree
 *     (`sync.collectSubtreeIds`) and passes the full id set.
 *   - SYNC-ARRIVED deletes (sync-context op handler) — the subtree is captured in
 *     sync-client before the op is applied and surfaced on the event.
 *
 * The search index lives in the `useSearchIndex` hook (it owns the HKDF-derived
 * key + the in-memory blob), which a plain module can't reach — so this exposes a
 * tiny deletion event bus the hook subscribes to. Everything else is a direct
 * module call. All steps are best-effort: one failing store never blocks another.
 */

import { markRemoteDeletedByFileIds } from '../services/BackupDatabase';
import { invalidateBackupFolderCacheIfDeleted } from '../services/BackupService';
import { offlineManager } from './offline-manager';
import { invalidateCachedThumbnails, invalidateNativeThumbnailCache } from './thumbnail-cache';
import { pruneNameCache } from './name-cache';

export interface DeleteCascadeOptions {
  /** True when `ids` already includes a folder's expanded subtree. Advisory —
   *  the dispatcher treats every id uniformly. */
  subtree?: boolean;
}

type DeletedListener = (ids: string[]) => void;
const deletedListeners = new Set<DeletedListener>();

/** Subscribe to delete-cascade events (the search index hook uses this to prune
 *  its in-memory index). Returns an unsubscribe fn. */
export function subscribeFilesDeleted(listener: DeletedListener): () => void {
  deletedListeners.add(listener);
  return () => {
    deletedListeners.delete(listener);
  };
}

/**
 * Fan a delete out to every derived store. `ids` must already be subtree-expanded
 * for folder deletes (callers use `sync.collectSubtreeIds`). Idempotent.
 */
export async function onFilesDeleted(
  ids: string[],
  _opts: DeleteCascadeOptions = {},
): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return;
  const idSet = new Set(unique);

  // 1. Backup manifest — EXPLICIT delete: mark remote_deleted (NOT re-queued —
  //    the user deleted these, so they must not silently re-upload; contrast
  //    with the reconcile's re-queue when the server lost them unexpectedly).
  await markRemoteDeletedByFileIds(unique).catch(() => {});

  // 2. Offline-pinned copies — drop the on-disk copy + manifest entry. A pinned
  //    folder id is removed as a folder; everything else as a file.
  const offlineFolders = new Set(offlineManager.offlineFolderIds());
  for (const id of unique) {
    if (offlineFolders.has(id)) {
      await offlineManager.removeFolder(id, []).catch(() => {});
    } else if (offlineManager.getStatus(id)) {
      await offlineManager.removeFile(id).catch(() => {});
    }
  }

  // 3. Thumbnails — JS memory/disk + the native FSM/url cache.
  await invalidateCachedThumbnails(unique).catch(() => {});
  await invalidateNativeThumbnailCache(unique).catch(() => {});

  // 4. Name cache (0807).
  await pruneNameCache(unique).catch(() => {});

  // 5. Backup folder cache — if a backup folder (root/device/category) was
  //    deleted, drop the cache so the tree rebuilds.
  await invalidateBackupFolderCacheIfDeleted(idSet).catch(() => {});

  // 6. Search index — notify subscribers (the useSearchIndex hook unindexes).
  for (const listener of deletedListeners) {
    try {
      listener(unique);
    } catch {
      // a listener failure must not abort the cascade
    }
  }
}
