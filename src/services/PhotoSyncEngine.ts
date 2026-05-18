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
import * as SQLite from 'expo-sqlite';
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
  recoverStuckUploads,
  type BackupAsset,
  type BackupAssetType,
} from './BackupDatabase';
import { photoBackupCheck, photoBackupMark, photoBackupListIds } from '../lib/api';
import type { UploadProgress } from '../lib/api';
import type { BackupFileStatus } from '../lib/backup-context';
import { maybeVerify } from './BackupVerifier';

const ENUMERATE_PAGE = 200;
const CHECK_BATCH = 200;
const MAX_ENCRYPT_CONCURRENT = 9;
const MAX_UPLOAD_CONCURRENT = 3;
const UPLOAD_BATCH = 30; // fetch more since concurrent pipeline processes faster
const LAST_FULL_SCAN_KEY = 'backup_last_full_scan_at';
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type DeletionBehavior = 'keep' | 'trash';

export interface SyncEngineCallbacks {
  encryptAndUpload: (
    asset: MediaLibrary.Asset,
    onProgress?: (progress: UploadProgress) => void,
  ) => Promise<{ fileId: string }>;
  deleteServerFile: (fileId: string) => Promise<void>;
  getDeletionBehavior: () => DeletionBehavior;
  onProgress?: (counts: Record<string, number>) => void;
  onQueueUpdate?: (queue: BackupFileStatus[]) => void;
  signal?: AbortSignal;
  /** Returns the opaque native master key handle ID, or null if vault is locked. Used for backup verification. */
  getMasterKeyHandleId?: () => number | null;
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
//
// Producer-consumer pipeline with concurrent uploads:
//   [Camera Roll] → [Encrypt Workers x9] → [Encrypted Queue (max 9)] → [Upload Workers x3] → [Done]
//
// Server allows 1000 req/min for file routes. Previous 600ms serial pacing
// limited to ~100 uploads/min. This pipeline runs 3 concurrent uploads with a
// 9-deep encrypt/validate queue, limited only by network speed.

const RATE_LIMIT_BACKOFF_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): number | null {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('rate_limit') || msg.includes('429') || msg.includes('too many')) {
      const match = msg.match(/retry.after.*?(\d+)/i);
      return match ? Number(match[1]) * 1000 : RATE_LIMIT_BACKOFF_MS;
    }
  }
  return null;
}

export async function processUploads(callbacks: SyncEngineCallbacks): Promise<number> {
  if (processingUpload) return 0;
  processingUpload = true;
  let totalUploaded = 0;

  try {
    // Recover any rows stuck in 'uploading' from a previous crashed session
    await recoverStuckUploads();

    while (true) {
      if (callbacks.signal?.aborted) break;

      const batch = await getPendingUploads(UPLOAD_BATCH);
      if (batch.length === 0) break;

      // ── Status tracking for UI ──

      const fileStatuses = new Map<string, BackupFileStatus>();
      for (const row of batch) {
        fileStatuses.set(row.local_asset_id, {
          assetId: row.local_asset_id,
          filename: row.local_asset_id,
          sizeBytes: row.file_size || 0,
          status: 'encrypting',
          progress: 0,
        });
      }
      callbacks.onQueueUpdate?.([...fileStatuses.values()]);

      // ── Encrypted queue: validated assets ready for upload ──

      type ValidatedItem = { row: BackupAsset; asset: MediaLibrary.Asset };
      const encryptedQueue: ValidatedItem[] = [];
      let encryptIndex = 0;
      let encryptDone = false;
      let consecutiveFailures = 0;

      // Promise-based signaling so upload workers wake when items arrive.
      // Multiple waiters supported via an array of resolvers.
      let queueWaiters: (() => void)[] = [];
      function signalQueue() {
        const waiters = queueWaiters;
        queueWaiters = [];
        for (const r of waiters) r();
      }
      function waitForQueue(): Promise<void> {
        if (encryptedQueue.length > 0 || encryptDone) return Promise.resolve();
        return new Promise<void>(r => { queueWaiters.push(r); });
      }

      // ── Encrypt/validate workers ──
      // Validate assets and fetch MediaLibrary info concurrently.
      // Keep the encrypted queue at most MAX_ENCRYPT_CONCURRENT deep.

      // Back-pressure: resolvers waiting for queue space
      let spaceWaiters: (() => void)[] = [];
      function signalSpace() {
        const waiters = spaceWaiters;
        spaceWaiters = [];
        for (const r of waiters) r();
      }

      const encryptWorker = async () => {
        while (true) {
          if (callbacks.signal?.aborted) return;

          // Back-pressure: wait until queue has room
          while (encryptedQueue.length >= MAX_ENCRYPT_CONCURRENT) {
            await new Promise<void>(r => { spaceWaiters.push(r); });
          }

          const idx = encryptIndex++;
          if (idx >= batch.length) return; // no more to validate

          const row = batch[idx];
          const status = fileStatuses.get(row.local_asset_id);

          try {
            if (status) { status.status = 'encrypting'; status.progress = 0; }
            callbacks.onQueueUpdate?.([...fileStatuses.values()]);

            await markUploading(row.local_asset_id);
            const asset = await MediaLibrary.getAssetInfoAsync(row.local_asset_id);
            if (!asset) {
              await markFailed(row.local_asset_id, 'Asset no longer exists in camera roll');
              if (status) { status.status = 'failed'; }
              callbacks.onQueueUpdate?.([...fileStatuses.values()]);
              continue;
            }

            // Asset validated — mark as queued, push into encrypted queue
            if (status) {
              status.filename = asset.filename || status.filename;
              status.sizeBytes = (asset as any).fileSize || asset.width * asset.height * 3 || 0;
              status.status = 'queued';
              status.progress = 100;
            }
            callbacks.onQueueUpdate?.([...fileStatuses.values()]);

            encryptedQueue.push({ row, asset });
            signalQueue();
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Unknown error';
            await markFailed(row.local_asset_id, msg);
            if (status) { status.status = 'failed'; }
            callbacks.onQueueUpdate?.([...fileStatuses.values()]);
          }
        }
      };

      // ── Upload workers ──
      // Pull from the encrypted queue and upload concurrently.

      const uploadWorker = async () => {
        while (true) {
          if (callbacks.signal?.aborted) return;

          await waitForQueue();

          const item = encryptedQueue.shift();
          if (item) signalSpace(); // notify encrypt workers that queue has room
          if (!item) {
            if (encryptDone) return; // all items processed
            continue;
          }

          const status = fileStatuses.get(item.row.local_asset_id);
          if (status) { status.status = 'uploading'; status.progress = 0; }
          callbacks.onQueueUpdate?.([...fileStatuses.values()]);

          try {
            const { fileId } = await callbacks.encryptAndUpload(item.asset, (progress) => {
              if (!status) return;
              const percent = progress.bytesTotal > 0
                ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100)
                : 0;
              status.status = 'uploading';
              status.progress = Math.max(0, Math.min(100, percent));
              status.sizeBytes = progress.bytesTotal || status.sizeBytes;
              callbacks.onQueueUpdate?.([...fileStatuses.values()]);
            });
            await photoBackupMark(item.row.local_asset_id, fileId);
            await markUploadComplete(item.row.local_asset_id, fileId);
            if (status) { status.status = 'done'; status.progress = 100; }
            totalUploaded++;
            consecutiveFailures = 0;

            // Periodic backup integrity verification (every 100 uploads)
            if (callbacks.getMasterKeyHandleId) {
              void maybeVerify({ getMasterKeyHandleId: callbacks.getMasterKeyHandleId }).catch(() => {});
            }
          } catch (err) {
            const rateLimitWait = isRateLimitError(err);
            if (rateLimitWait !== null) {
              await markFailed(item.row.local_asset_id, 'rate_limited');
              if (status) { status.status = 'failed'; }
              // Rate limited — pause ALL upload workers briefly
              await delay(rateLimitWait);
              consecutiveFailures++;
            } else {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              await markFailed(item.row.local_asset_id, msg);
              if (status) { status.status = 'failed'; }
              consecutiveFailures++;
            }

            if (consecutiveFailures >= 5) {
              await delay(RATE_LIMIT_BACKOFF_MS);
              consecutiveFailures = 0;
            }
          }

          callbacks.onQueueUpdate?.([...fileStatuses.values()]);

          if (callbacks.onProgress) {
            const counts = await getStatusCounts();
            callbacks.onProgress(counts);
          }
        }
      };

      // Start encrypt workers (up to 9, but no more than batch size)
      const encryptWorkers = Array.from(
        { length: Math.min(MAX_ENCRYPT_CONCURRENT, batch.length) },
        () => encryptWorker(),
      );
      // Start upload workers (up to 3, but no more than batch size)
      const uploadWorkers = Array.from(
        { length: Math.min(MAX_UPLOAD_CONCURRENT, batch.length) },
        () => uploadWorker(),
      );

      // Wait for all encrypt workers to finish producing
      await Promise.all(encryptWorkers);
      encryptDone = true;
      signalQueue(); // wake any upload workers blocked on empty queue

      // Wait for all upload workers to finish consuming
      await Promise.all(uploadWorkers);

      // Clear the queue display after batch completes
      callbacks.onQueueUpdate?.([]);
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

  // 2. Fetch all backed-up IDs from server in one paginated call
  const serverBackedUp = await photoBackupListIds();

  // 3. Queue uploads for assets not on server and not already pending locally
  const alreadyTracked = await getAllUploadedIds();
  for (const [id, info] of allAssetIds) {
    if (!serverBackedUp.has(id) && !alreadyTracked.has(id)) {
      await upsertPendingUpload(id, info.type, 0, info.time);
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

  // 5. Store scan timestamp in SQLite (not SecureStore — works in background)
  await setSyncMeta(LAST_FULL_SCAN_KEY, String(Date.now()));

  // 6. Process queued work
  await processUploads(callbacks);
  await processDeletes(callbacks);
}

// ─── SQLite key-value for sync metadata (background-safe) ────────────────────

const SYNC_META_DB_NAME = 'beebeeb-backup.db';

async function getSyncMetaDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(SYNC_META_DB_NAME);
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

async function getSyncMeta(key: string): Promise<string | null> {
  try {
    const db = await getSyncMetaDb();
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM sync_meta WHERE key = ?',
      [key],
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function setSyncMeta(key: string, value: string): Promise<void> {
  try {
    const db = await getSyncMetaDb();
    await db.runAsync(
      'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
      [key, value, value],
    );
  } catch {
    // Non-critical — next scan will just run slightly early
  }
}

// ─── Scheduling helpers ──────────────────────────────────────────────────────

export async function needsFullScan(): Promise<boolean> {
  const lastScan = await getSyncMeta(LAST_FULL_SCAN_KEY);
  if (!lastScan) return true;
  return Date.now() - Number(lastScan) > FULL_SCAN_INTERVAL_MS;
}

export async function getLastFullScanAt(): Promise<number | null> {
  const val = await getSyncMeta(LAST_FULL_SCAN_KEY);
  return val ? Number(val) : null;
}
