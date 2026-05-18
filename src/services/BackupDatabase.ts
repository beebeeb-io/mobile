/**
 * Local sync index for the device backup system, backed by expo-sqlite.
 *
 * Tracks which local assets (photos, videos, contacts, calendar events) have
 * been uploaded to the user's encrypted Backups/ folder, so we can perform
 * incremental syncs without listing remote files every cycle.
 *
 * Persistence model: a single SQLite database file
 * (`<documentDir>/SQLite/beebeeb-backup.db`) with one `backup_assets` table.
 * The previous in-memory Map implementation lost all state across app
 * restarts — every relaunch would re-upload every photo. expo-sqlite is in
 * the project dependencies and works in Expo Go as well as dev clients.
 *
 * Public surface is unchanged from the in-memory version so call sites in
 * `BackupService.ts` and `PhotoSyncEngine.ts` keep working with no edits.
 *
 * See docs/specs/010-device-backup-system.md for the full design.
 */

import * as SQLite from 'expo-sqlite';

export type BackupAssetType = 'photo' | 'video' | 'contact' | 'calendar';
export type BackupAssetStatus =
  | 'pending_upload'
  | 'uploading'
  | 'uploaded'
  | 'pending_delete'
  | 'pending_reupload'
  | 'orphaned'
  | 'failed';

export interface BackupAsset {
  local_asset_id: string;
  remote_file_id: string | null;
  remote_path: string | null;
  content_hash: string;
  file_size: number;
  created_at: string;
  uploaded_at: string | null;
  asset_type: BackupAssetType;
  status: BackupAssetStatus;
  queued_at: number | null;
  last_attempt_at: number | null;
  retry_count: number;
  error_message: string | null;
}

const DB_NAME = 'beebeeb-backup.db';

// Module-level handle, set by initDatabase(). All other functions await
// `getDb()` so they're safe to call before initDatabase() resolves — they'll
// just block on the in-flight init.
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = openAndMigrate();
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  // Foreign keys + WAL for better concurrency under the upload runner.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS backup_assets (
      local_asset_id TEXT PRIMARY KEY,
      remote_file_id TEXT,
      remote_path TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      uploaded_at TEXT,
      asset_type TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backup_assets_status_type
      ON backup_assets(status, asset_type);
    CREATE INDEX IF NOT EXISTS idx_backup_assets_type
      ON backup_assets(asset_type);
    CREATE INDEX IF NOT EXISTS idx_backup_assets_created_at
      ON backup_assets(created_at);
  `);

  // Migration: add columns for sync queue (v2)
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN queued_at INTEGER;
  `).catch(() => {});  // ignore if already exists
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN last_attempt_at INTEGER;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN retry_count INTEGER DEFAULT 0;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN error_message TEXT;
  `).catch(() => {});

  // Migrate old status values to new enum
  await db.execAsync(`
    UPDATE backup_assets SET status = 'pending_upload' WHERE status = 'pending';
    UPDATE backup_assets SET status = 'uploaded' WHERE status = 'uploading';
  `);

  return db;
}

export async function initDatabase(): Promise<void> {
  await getDb();
}

export async function getAsset(localAssetId: string): Promise<BackupAsset | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<BackupAsset>(
    `SELECT local_asset_id, remote_file_id, remote_path, content_hash, file_size,
            created_at, uploaded_at, asset_type, status
       FROM backup_assets
      WHERE local_asset_id = ?`,
    [localAssetId],
  );
  return row ?? null;
}

export async function upsertAsset(
  asset: Partial<BackupAsset> & { local_asset_id: string },
): Promise<void> {
  const db = await getDb();
  // Read first so we preserve fields the caller didn't supply, matching the
  // in-memory implementation's merge semantics. SQLite's UPSERT alone would
  // overwrite missing fields with NULL.
  const existing = await getAsset(asset.local_asset_id);
  const merged: BackupAsset = {
    local_asset_id: asset.local_asset_id,
    remote_file_id: asset.remote_file_id ?? existing?.remote_file_id ?? null,
    remote_path: asset.remote_path ?? existing?.remote_path ?? null,
    content_hash: asset.content_hash ?? existing?.content_hash ?? '',
    file_size: asset.file_size ?? existing?.file_size ?? 0,
    created_at:
      asset.created_at ?? existing?.created_at ?? new Date().toISOString(),
    uploaded_at: asset.uploaded_at ?? existing?.uploaded_at ?? null,
    asset_type: asset.asset_type ?? existing?.asset_type ?? 'photo',
    status: asset.status ?? existing?.status ?? 'pending_upload',
    queued_at: asset.queued_at ?? existing?.queued_at ?? null,
    last_attempt_at: asset.last_attempt_at ?? existing?.last_attempt_at ?? null,
    retry_count: asset.retry_count ?? existing?.retry_count ?? 0,
    error_message: asset.error_message ?? existing?.error_message ?? null,
  };

  await db.runAsync(
    `INSERT INTO backup_assets (
       local_asset_id, remote_file_id, remote_path, content_hash, file_size,
       created_at, uploaded_at, asset_type, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(local_asset_id) DO UPDATE SET
       remote_file_id = excluded.remote_file_id,
       remote_path    = excluded.remote_path,
       content_hash   = excluded.content_hash,
       file_size      = excluded.file_size,
       created_at     = excluded.created_at,
       uploaded_at    = excluded.uploaded_at,
       asset_type     = excluded.asset_type,
       status         = excluded.status`,
    [
      merged.local_asset_id,
      merged.remote_file_id,
      merged.remote_path,
      merged.content_hash,
      merged.file_size,
      merged.created_at,
      merged.uploaded_at,
      merged.asset_type,
      merged.status,
    ],
  );
}

export async function getPendingAssets(
  assetType?: BackupAssetType,
): Promise<BackupAsset[]> {
  const db = await getDb();
  const rows = assetType
    ? await db.getAllAsync<BackupAsset>(
        `SELECT * FROM backup_assets
          WHERE status IN ('pending_upload','pending_reupload','failed')
            AND asset_type = ?
          ORDER BY created_at ASC`,
        [assetType],
      )
    : await db.getAllAsync<BackupAsset>(
        `SELECT * FROM backup_assets
          WHERE status IN ('pending_upload','pending_reupload','failed')
          ORDER BY created_at ASC`,
      );
  return rows;
}

export async function getUploadedCount(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM backup_assets
      WHERE status = 'uploaded' AND asset_type = ?`,
    [assetType],
  );
  return row?.count ?? 0;
}

export async function getTotalCount(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM backup_assets WHERE asset_type = ?`,
    [assetType],
  );
  return row?.count ?? 0;
}

export async function getTotalBytes(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(file_size) AS total
       FROM backup_assets
      WHERE asset_type = ?`,
    [assetType],
  );
  return row?.total ?? 0;
}

export async function getUploadedBytes(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(file_size) AS total
       FROM backup_assets
      WHERE status = 'uploaded' AND asset_type = ?`,
    [assetType],
  );
  return row?.total ?? 0;
}

export async function markUploaded(
  localAssetId: string,
  remoteFileId: string,
  remotePath: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets
        SET status = 'uploaded',
            remote_file_id = ?,
            remote_path = ?,
            uploaded_at = ?
      WHERE local_asset_id = ?`,
    [remoteFileId, remotePath, new Date().toISOString(), localAssetId],
  );
}

export async function markFailed(
  localAssetId: string,
  error?: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'failed', error_message = ?, retry_count = COALESCE(retry_count, 0) + 1, last_attempt_at = ? WHERE local_asset_id = ?`,
    [error ?? null, Date.now(), localAssetId],
  );
}

export async function markUploading(localAssetId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'uploading', last_attempt_at = ? WHERE local_asset_id = ?`,
    [Date.now(), localAssetId],
  );
}

export async function resetFailedAssets(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE backup_assets SET status = 'pending_upload' WHERE status = 'failed'`,
  );
  return result.changes;
}

export async function clearAssets(assetType: BackupAssetType): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM backup_assets WHERE asset_type = ?`,
    [assetType],
  );
}

// ─── Sync queue queries (v2) ──────────────────────────────────────────────────

export async function getPendingUploads(
  limit: number = 10,
): Promise<BackupAsset[]> {
  const db = await getDb();
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets
      WHERE status IN ('pending_upload', 'pending_reupload', 'uploading')
        AND retry_count < 10
      ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}

/**
 * Reset rows stuck in 'uploading' for more than 5 minutes back to
 * 'pending_reupload' so they get retried. This handles the case where the
 * app was killed mid-upload or the upload timed out silently.
 */
export async function recoverStuckUploads(): Promise<number> {
  const db = await getDb();
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const result = await db.runAsync(
    `UPDATE backup_assets SET status = 'pending_reupload'
      WHERE status = 'uploading' AND last_attempt_at < ?`,
    [fiveMinAgo],
  );
  return result.changes;
}

/**
 * Items that have failed 10+ times and will no longer be retried
 * automatically. Exposed so the UI can show a "permanently failed" list.
 */
export async function getDeadLetterItems(): Promise<BackupAsset[]> {
  const db = await getDb();
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets WHERE retry_count >= 10 ORDER BY last_attempt_at DESC`,
  );
}

export async function getPendingDeletes(): Promise<BackupAsset[]> {
  const db = await getDb();
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets WHERE status = 'pending_delete'`,
  );
}

export async function getFailedAssets(): Promise<BackupAsset[]> {
  const db = await getDb();
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets WHERE status = 'failed'`,
  );
}

export async function getStatusCounts(): Promise<
  Record<BackupAssetStatus, number>
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ status: string; count: number }>(
    `SELECT status, COUNT(*) as count FROM backup_assets GROUP BY status`,
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts as Record<BackupAssetStatus, number>;
}

export async function getTotalUploadedBytes(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(file_size), 0) as total FROM backup_assets WHERE status = 'uploaded'`,
  );
  return row?.total ?? 0;
}

export async function upsertPendingUpload(
  localId: string,
  assetType: BackupAssetType,
  sizeBytes: number,
  creationAt: number,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO backup_assets (local_asset_id, status, asset_type, file_size, created_at, queued_at, content_hash)
     VALUES (?, 'pending_upload', ?, ?, ?, ?, '')
     ON CONFLICT(local_asset_id) DO UPDATE SET
       status = CASE WHEN status IN ('failed', 'orphaned') THEN 'pending_upload' ELSE status END,
       queued_at = CASE WHEN status IN ('failed', 'orphaned') THEN ? ELSE queued_at END`,
    [localId, assetType, sizeBytes, String(creationAt), now, now],
  );
}

export async function markUploadComplete(
  localId: string,
  fileId: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'uploaded', remote_file_id = ?, uploaded_at = ?, error_message = NULL, retry_count = 0 WHERE local_asset_id = ?`,
    [fileId, new Date().toISOString(), localId],
  );
}

export async function markPendingDelete(localId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'pending_delete', queued_at = ? WHERE local_asset_id = ? AND status = 'uploaded'`,
    [Date.now(), localId],
  );
}

export async function markOrphaned(localId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'orphaned' WHERE local_asset_id = ? AND status = 'uploaded'`,
    [localId],
  );
}

export async function removePendingDelete(localId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM backup_assets WHERE local_asset_id = ? AND status = 'pending_delete'`,
    [localId],
  );
}

export async function retryAllFailed(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE backup_assets SET status = 'pending_upload', retry_count = 0, error_message = NULL WHERE status = 'failed'`,
  );
  return result.changes;
}

export async function clearAllData(): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM backup_assets`);
}

export async function getAllUploadedIds(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ local_asset_id: string }>(
    `SELECT local_asset_id FROM backup_assets WHERE status IN ('uploaded', 'orphaned')`,
  );
  return new Set(rows.map((r) => r.local_asset_id));
}

/**
 * Build a map from remote_file_id → local_asset_id for all uploaded/orphaned
 * backup assets. Used by the Photos grid to resolve camera-roll thumbnails.
 */
export async function getRemoteToLocalMap(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ remote_file_id: string; local_asset_id: string }>(
    `SELECT remote_file_id, local_asset_id FROM backup_assets
      WHERE status IN ('uploaded', 'orphaned') AND remote_file_id IS NOT NULL`,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.remote_file_id, row.local_asset_id);
  }
  return map;
}

export async function getRecentActivity(
  days: number = 7,
): Promise<{ date: string; count: number; bytes: number }[]> {
  const db = await getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return db.getAllAsync<{ date: string; count: number; bytes: number }>(
    `SELECT DATE(uploaded_at) as date, COUNT(*) as count, SUM(file_size) as bytes
     FROM backup_assets WHERE status = 'uploaded' AND uploaded_at >= ?
     GROUP BY DATE(uploaded_at) ORDER BY date DESC`,
    [cutoff.toISOString()],
  );
}
