/**
 * PhotoSyncEngine — event-driven camera roll sync.
 *
 * Replaces PhotoBackupRunner. Uses MediaLibrary.addListener for real-time
 * sync and SQLite backup_assets as an offline queue. No session limits.
 *
 * Three processors:
 *   - uploadProcessor: drains pending_upload / pending_reupload rows
 *   - deleteProcessor: drains pending_delete rows
 *   - fullReconciliation: enumerates ALL assets, diffs, queues work
 */

import * as MediaLibrary from 'expo-media-library';
import * as SecureStore from 'expo-secure-store';
import {
  upsertPendingUpload,
  markUploading,
  markUploadComplete,
  markFailed,
  markPendingDelete,
  markOrphaned,
  removePendingDelete,
  getPendingUploads,
  getPendingDeletes,
  getAllUploadedIds,
  getStatusCounts,
  type BackupAssetType,
} from './BackupDatabase';
import { photoBackupCheck, photoBackupMark } from '../lib/api';

const ENUMERATE_PAGE = 200;
const CHECK_BATCH = 200;
const UPLOAD_BATCH = 10;
const LAST_FULL_SCAN_KEY = 'backup_last_full_scan_at';
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type DeletionBehavior = 'keep' | 'trash';

export interface SyncEngineCallbacks {
  encryptAndUpload: (asset: MediaLibrary.Asset) => Promise<{ fileId: string }>;
  deleteServerFile: (fileId: string) => Promise<void>;
  getDeletionBehavior: () => DeletionBehavior;
  onProgress?: (counts: Record<string, number>) => void;
  signal?: AbortSignal;
}

let listenerSubscription: MediaLibrary.Subscription | null = null;
let processingUpload = false;
let processingDelete = false;

// ─── Event Listener ──────────────────────────────────────────────────────────

export function startEventListener(callbacks: SyncEngineCallbacks): void {
  if (listenerSubscription) return; // already listening

  listenerSubscription = MediaLibrary.addListener(async (event) => {
    if (!event.hasIncrementalChanges) {
      // Permissions changed or mass import — full rescan needed
      await fullReconciliation(callbacks);
      return;
    }

    if (event.insertedAssets?.length) {
      for (const asset of event.insertedAssets) {
        const assetType: BackupAssetType = asset.mediaType === 'video' ? 'video' : 'photo';
        await upsertPendingUpload(
          asset.id,
          assetType,
          0, // size unknown from event, will read on upload
          asset.creationTime * 1000, // seconds → ms
        );
      }
      void processUploads(callbacks);
    }

    if (event.deletedAssets?.length) {
      const behavior = callbacks.getDeletionBehavior();
      for (const asset of event.deletedAssets) {
        if (behavior === 'trash') {
          await markPendingDelete(asset.id);
        } else {
          await markOrphaned(asset.id);
        }
      }
      if (behavior === 'trash') void processDeletes(callbacks);
    }

    if (event.updatedAssets?.length) {
      for (const asset of event.updatedAssets) {
        const assetType: BackupAssetType = asset.mediaType === 'video' ? 'video' : 'photo';
        await upsertPendingUpload(asset.id, assetType, 0, asset.creationTime * 1000);
      }
      void processUploads(callbacks);
    }

    // Report counts
    if (callbacks.onProgress) {
      const counts = await getStatusCounts();
      callbacks.onProgress(counts);
    }
  });
}

export function stopEventListener(): void {
  if (listenerSubscription) {
    listenerSubscription.remove();
    listenerSubscription = null;
  }
}

// ─── Upload Processor ────────────────────────────────────────────────────────

export async function processUploads(callbacks: SyncEngineCallbacks): Promise<number> {
  if (processingUpload) return 0;
  processingUpload = true;
  let totalUploaded = 0;

  try {
    while (true) {
      if (callbacks.signal?.aborted) break;

      const batch = await getPendingUploads(UPLOAD_BATCH);
      if (batch.length === 0) break;

      for (const row of batch) {
        if (callbacks.signal?.aborted) break;

        try {
          await markUploading(row.local_asset_id);

          // Read the actual asset from MediaLibrary
          const asset = await MediaLibrary.getAssetInfoAsync(row.local_asset_id);
          if (!asset) {
            await markFailed(row.local_asset_id, 'Asset no longer exists in camera roll');
            continue;
          }

          const { fileId } = await callbacks.encryptAndUpload(asset);
          await photoBackupMark(row.local_asset_id, fileId);
          await markUploadComplete(row.local_asset_id, fileId);
          totalUploaded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          await markFailed(row.local_asset_id, msg);
        }

        if (callbacks.onProgress) {
          const counts = await getStatusCounts();
          callbacks.onProgress(counts);
        }
      }
    }
  } finally {
    processingUpload = false;
  }

  return totalUploaded;
}

// ─── Delete Processor ────────────────────────────────────────────────────────

export async function processDeletes(callbacks: SyncEngineCallbacks): Promise<number> {
  if (processingDelete) return 0;
  processingDelete = true;
  let totalDeleted = 0;

  try {
    const rows = await getPendingDeletes();
    for (const row of rows) {
      if (callbacks.signal?.aborted) break;
      if (!row.remote_file_id) {
        await removePendingDelete(row.local_asset_id);
        continue;
      }

      try {
        await callbacks.deleteServerFile(row.remote_file_id);
        await removePendingDelete(row.local_asset_id);
        totalDeleted++;
      } catch {
        // Keep in queue, retry later
      }
    }
  } finally {
    processingDelete = false;
  }

  return totalDeleted;
}

// ─── Full Reconciliation ─────────────────────────────────────────────────────

export async function fullReconciliation(callbacks: SyncEngineCallbacks): Promise<void> {
  // 1. Enumerate ALL camera roll assets
  const allAssetIds = new Map<string, { type: BackupAssetType; time: number }>();
  let hasMore = true;
  let endCursor: string | undefined;

  while (hasMore) {
    if (callbacks.signal?.aborted) return;

    const page = await MediaLibrary.getAssetsAsync({
      first: ENUMERATE_PAGE,
      after: endCursor,
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    });

    for (const asset of page.assets) {
      allAssetIds.set(asset.id, {
        type: asset.mediaType === 'video' ? 'video' : 'photo',
        time: asset.creationTime * 1000,
      });
    }

    hasMore = page.hasNextPage;
    endCursor = page.endCursor;
  }

  // 2. Batch-check server for which need backup
  const idList = Array.from(allAssetIds.keys());
  const needsUpload = new Set<string>();

  for (let i = 0; i < idList.length; i += CHECK_BATCH) {
    if (callbacks.signal?.aborted) return;
    const chunk = idList.slice(i, i + CHECK_BATCH);
    const result = await photoBackupCheck(chunk);
    for (const id of result.needs_backup) needsUpload.add(id);
  }

  // 3. Queue uploads for assets not already pending
  const alreadyTracked = await getAllUploadedIds();
  for (const id of needsUpload) {
    if (!alreadyTracked.has(id)) {
      const info = allAssetIds.get(id);
      if (info) {
        await upsertPendingUpload(id, info.type, 0, info.time);
      }
    }
  }

  // 4. Detect deletions — assets in our DB but not in camera roll
  const behavior = callbacks.getDeletionBehavior();
  const uploadedIds = await getAllUploadedIds();
  for (const trackedId of uploadedIds) {
    if (!allAssetIds.has(trackedId)) {
      if (behavior === 'trash') {
        await markPendingDelete(trackedId);
      } else {
        await markOrphaned(trackedId);
      }
    }
  }

  // 5. Store scan timestamp
  await SecureStore.setItemAsync(LAST_FULL_SCAN_KEY, String(Date.now()));

  // 6. Process queued work
  await processUploads(callbacks);
  await processDeletes(callbacks);
}

// ─── Scheduling helpers ──────────────────────────────────────────────────────

export async function needsFullScan(): Promise<boolean> {
  const lastScan = await SecureStore.getItemAsync(LAST_FULL_SCAN_KEY);
  if (!lastScan) return true;
  return Date.now() - Number(lastScan) > FULL_SCAN_INTERVAL_MS;
}

export async function getLastFullScanAt(): Promise<number | null> {
  const val = await SecureStore.getItemAsync(LAST_FULL_SCAN_KEY);
  return val ? Number(val) : null;
}
