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
 * Public surface is shared by the native backup engine and React Native
 * status/insights screens.
 *
 * See docs/specs/010-device-backup-system.md for the full design.
 */

import * as SQLite from 'expo-sqlite';

export type BackupAssetType = 'photo' | 'video' | 'contact' | 'calendar';
export type BackupAssetStatus =
  | 'pending_upload'
  | 'staging'
  | 'staged_upload'
  | 'uploading'
  | 'uploaded'
  | 'pending_delete'
  | 'pending_reupload'
  | 'orphaned'
  | 'remote_deleted'
  | 'local_missing'
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
  staged_file_id?: string | null;
  staged_name_encrypted?: string | null;
  staged_mime_type?: string | null;
  staged_is_media?: number | null;
  staged_original_size?: number | null;
  staged_chunk_count?: number | null;
  staged_dir?: string | null;
  staged_at?: number | null;
  selected_for_backup?: number | null;
}

const DB_NAME = 'beebeeb-backup.db';
const LEGACY_STATUS_ENUM_MIGRATION_VERSION = 1;

// Module-level handle, set by initDatabase(). All other functions await
// `getDb()` so they're safe to call before initDatabase() resolves — they'll
// just block on the in-flight init.
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let localMissingMigrationLastRunAt = 0;
let localMissingMigrationInFlight: Promise<void> | null = null;
const LOCAL_MISSING_MIGRATION_MIN_INTERVAL_MS = 60_000;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = openAndMigrate();
  return dbPromise;
}

async function migrateLocalMissingRows(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    UPDATE backup_assets
       SET status = 'local_missing',
           retry_count = 0,
           error_message = 'Photo removed from this iPhone before backup completed'
     WHERE status != 'uploaded'
       AND (
         error_message LIKE '%Photo asset not found%'
         OR error_message LIKE '%not found in library%'
       );
  `).catch(() => {});
  localMissingMigrationLastRunAt = Date.now();
}

async function migrateLocalMissingRowsIfNeeded(db: SQLite.SQLiteDatabase): Promise<void> {
  if (localMissingMigrationInFlight) {
    await localMissingMigrationInFlight;
    return;
  }
  if (Date.now() - localMissingMigrationLastRunAt < LOCAL_MISSING_MIGRATION_MIN_INTERVAL_MS) {
    return;
  }
  localMissingMigrationInFlight = migrateLocalMissingRows(db).finally(() => {
    localMissingMigrationInFlight = null;
  });
  await localMissingMigrationInFlight;
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
    CREATE TABLE IF NOT EXISTS backup_verification (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verified_at TEXT NOT NULL DEFAULT (datetime('now')),
      remote_file_id TEXT NOT NULL,
      success INTEGER NOT NULL,
      error_message TEXT,
      file_size INTEGER
    );
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
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_file_id TEXT;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_name_encrypted TEXT;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_mime_type TEXT;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_is_media INTEGER DEFAULT 0;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_original_size INTEGER DEFAULT 0;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_chunk_count INTEGER DEFAULT 0;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_dir TEXT;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN staged_at INTEGER;
  `).catch(() => {});
  await db.execAsync(`
    ALTER TABLE backup_assets ADD COLUMN selected_for_backup INTEGER DEFAULT 1;
  `).catch(() => {});
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS backup_upload_chunks (
      local_asset_id TEXT NOT NULL,
      server_file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id INTEGER,
      last_error TEXT,
      uploaded_at INTEGER,
      PRIMARY KEY(local_asset_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_backup_upload_chunks_asset_status
      ON backup_upload_chunks(local_asset_id, status);
  `);

  // One-time legacy status enum migration. Do not rerun on every launch:
  // `uploading` is now a live in-progress state and must only be recovered by
  // recoverStuckUploads(), which applies the staleness timeout.
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const schemaVersion = versionRow?.user_version ?? 0;
  if (schemaVersion < LEGACY_STATUS_ENUM_MIGRATION_VERSION) {
    await db.execAsync(`
      UPDATE backup_assets SET status = 'pending_upload' WHERE status = 'pending';
      UPDATE backup_assets SET status = 'uploaded' WHERE status = 'uploading';
      PRAGMA user_version = ${LEGACY_STATUS_ENUM_MIGRATION_VERSION};
    `);
  }
  await migrateLocalMissingRows(db);

  return db;
}

export async function initDatabase(): Promise<void> {
  await getDb();
}

export async function getUploadedCount(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
      FROM backup_assets
      WHERE COALESCE(selected_for_backup, 1) = 1 AND status = 'uploaded' AND asset_type = ?`,
    [assetType],
  );
  return row?.count ?? 0;
}

export async function getTotalCount(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM backup_assets WHERE COALESCE(selected_for_backup, 1) = 1 AND asset_type = ?`,
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
      WHERE COALESCE(selected_for_backup, 1) = 1 AND asset_type = ?`,
    [assetType],
  );
  return row?.total ?? 0;
}

export interface BackupCategorySummary {
  uploadedCount: number;
  totalCount: number;
  uploadedBytes: number;
  totalBytes: number;
}

export async function getCategorySummaries(): Promise<
  Partial<Record<BackupAssetType, BackupCategorySummary>>
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    asset_type: BackupAssetType;
    uploaded_count: number;
    total_count: number;
    uploaded_bytes: number | null;
    total_bytes: number | null;
  }>(
    `SELECT
       asset_type,
       SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) AS uploaded_count,
       COUNT(*) AS total_count,
       SUM(CASE WHEN status = 'uploaded' THEN file_size ELSE 0 END) AS uploaded_bytes,
       SUM(file_size) AS total_bytes
     FROM backup_assets
     WHERE COALESCE(selected_for_backup, 1) = 1
     GROUP BY asset_type`,
  );

  const summaries: Partial<Record<BackupAssetType, BackupCategorySummary>> = {};
  for (const row of rows) {
    summaries[row.asset_type] = {
      uploadedCount: row.uploaded_count ?? 0,
      totalCount: row.total_count ?? 0,
      uploadedBytes: row.uploaded_bytes ?? 0,
      totalBytes: row.total_bytes ?? 0,
    };
  }
  return summaries;
}

export async function getUploadedBytes(
  assetType: BackupAssetType,
): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(file_size) AS total
      FROM backup_assets
      WHERE COALESCE(selected_for_backup, 1) = 1 AND status = 'uploaded' AND asset_type = ?`,
    [assetType],
  );
  return row?.total ?? 0;
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

// ─── Sync queue queries (v2) ──────────────────────────────────────────────────

export async function getPendingUploads(
  limit: number = 10,
): Promise<BackupAsset[]> {
  const db = await getDb();
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets
      WHERE status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading')
        AND COALESCE(selected_for_backup, 1) = 1
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
  await migrateLocalMissingRowsIfNeeded(db);
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets
      WHERE status != 'local_missing'
        AND COALESCE(retry_count, 0) >= 10
      ORDER BY last_attempt_at DESC`,
  );
}

export async function getPendingDeletes(): Promise<BackupAsset[]> {
  const db = await getDb();
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets WHERE status = 'pending_delete'`,
  );
}

export async function getFailedAssets(limit?: number): Promise<BackupAsset[]> {
  const db = await getDb();
  await migrateLocalMissingRowsIfNeeded(db);
  const params = typeof limit === 'number' ? [limit] : [];
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets
      WHERE status = 'failed'
         OR (status != 'local_missing' AND COALESCE(retry_count, 0) >= 10)
      ORDER BY last_attempt_at DESC${typeof limit === 'number' ? ' LIMIT ?' : ''}`,
    params,
  );
}

export async function getLocalMissingAssets(
  limit: number = 10,
): Promise<BackupAsset[]> {
  const db = await getDb();
  await migrateLocalMissingRowsIfNeeded(db);
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets
      WHERE status = 'local_missing'
      ORDER BY last_attempt_at DESC
      LIMIT ?`,
    [limit],
  );
}

export async function getStatusCounts(): Promise<
  Record<BackupAssetStatus, number>
> {
  const db = await getDb();
  await migrateLocalMissingRowsIfNeeded(db);
  const rows = await db.getAllAsync<{ status: string; count: number }>(
    `SELECT status, COUNT(*) as count
       FROM backup_assets
      WHERE COALESCE(selected_for_backup, 1) = 1
      GROUP BY status`,
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts as Record<BackupAssetStatus, number>;
}

export async function getTotalUploadedBytes(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(file_size), 0) as total
       FROM backup_assets
      WHERE COALESCE(selected_for_backup, 1) = 1 AND status = 'uploaded'`,
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
    `INSERT INTO backup_assets (local_asset_id, status, asset_type, file_size, created_at, queued_at, content_hash, selected_for_backup)
     VALUES (?, 'pending_upload', ?, ?, ?, ?, '', 1)
     ON CONFLICT(local_asset_id) DO UPDATE SET
      selected_for_backup = 1,
      status = CASE WHEN status IN ('failed', 'orphaned', 'local_missing') THEN 'pending_upload' ELSE status END,
      queued_at = CASE WHEN status IN ('failed', 'orphaned', 'local_missing') THEN ? ELSE queued_at END,
      retry_count = CASE WHEN status = 'local_missing' THEN 0 ELSE retry_count END,
      error_message = CASE WHEN status = 'local_missing' THEN NULL ELSE error_message END`,
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

export async function markRemoteDeleted(localId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets
        SET status = 'remote_deleted',
            remote_file_id = NULL,
            uploaded_at = NULL,
            error_message = NULL
      WHERE local_asset_id = ?
        AND status IN ('uploaded', 'orphaned', 'pending_delete')`,
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
  await migrateLocalMissingRows(db);
  const result = await db.runAsync(
    `UPDATE backup_assets
      SET status = 'pending_upload',
          retry_count = 0,
          error_message = NULL
      WHERE status = 'failed'
         OR (status != 'local_missing' AND COALESCE(retry_count, 0) >= 10)`,
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
    `SELECT local_asset_id FROM backup_assets WHERE status IN ('uploaded', 'orphaned', 'remote_deleted')`,
  );
  return new Set(rows.map((r) => r.local_asset_id));
}

// ---------------------------------------------------------------------------
// 0817 — reconcile primitives (server-truth diff against /files/index). Also
// reused by the 0818 delete-cascade dispatcher.
// ---------------------------------------------------------------------------

/** SQLite bind-variable limit is ~999; chunk IN(...) lists well under it. */
const SQL_IN_CHUNK = 400;

/** REMOTE file ids of every still-"uploaded"/"orphaned" backup asset. The
 *  reconcile diffs these against /files/index to find orphans whose server copy
 *  is gone. */
export async function getAllUploadedRemoteIds(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ remote_file_id: string }>(
    `SELECT remote_file_id FROM backup_assets
      WHERE status IN ('uploaded', 'orphaned') AND remote_file_id IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.remote_file_id));
}

/** Re-queue uploaded/orphaned backup assets for re-upload: status →
 *  'pending_upload', remote_file_id/uploaded_at cleared. With `remoteFileIds`,
 *  only those rows reset (per-file reconcile); without, ALL uploaded/orphaned
 *  rows reset (the "Backups root deleted" case). Conservative — re-queue, never
 *  delete — so re-upload is automatic and nothing is lost if /files/index was
 *  briefly wrong. Returns rows changed. */
export async function resetUploadedState(remoteFileIds?: string[]): Promise<number> {
  const db = await getDb();
  const SET_CLAUSE =
    `SET status = 'pending_upload', remote_file_id = NULL, uploaded_at = NULL, ` +
    `error_message = NULL, retry_count = 0, queued_at = NULL`;

  if (remoteFileIds === undefined) {
    const result = await db.runAsync(
      `UPDATE backup_assets ${SET_CLAUSE} WHERE status IN ('uploaded', 'orphaned')`,
    );
    return result.changes;
  }

  let changed = 0;
  for (let i = 0; i < remoteFileIds.length; i += SQL_IN_CHUNK) {
    const batch = remoteFileIds.slice(i, i + SQL_IN_CHUNK);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const result = await db.runAsync(
      `UPDATE backup_assets ${SET_CLAUSE}
        WHERE status IN ('uploaded', 'orphaned') AND remote_file_id IN (${placeholders})`,
      batch,
    );
    changed += result.changes;
  }
  return changed;
}

/** Bulk-mark backup assets as remote-deleted by REMOTE file id (status →
 *  'remote_deleted', ids cleared). Unlike resetUploadedState these are NOT
 *  re-queued — for the EXPLICIT delete-cascade (0818) where the user deleted the
 *  file on purpose, so it must not silently re-upload. Returns rows changed. */
export async function markRemoteDeletedByFileIds(remoteFileIds: string[]): Promise<number> {
  const db = await getDb();
  let changed = 0;
  for (let i = 0; i < remoteFileIds.length; i += SQL_IN_CHUNK) {
    const batch = remoteFileIds.slice(i, i + SQL_IN_CHUNK);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const result = await db.runAsync(
      `UPDATE backup_assets
          SET status = 'remote_deleted', remote_file_id = NULL, uploaded_at = NULL, error_message = NULL
        WHERE remote_file_id IN (${placeholders})
          AND status IN ('uploaded', 'orphaned', 'pending_delete')`,
      batch,
    );
    changed += result.changes;
  }
  return changed;
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

/**
 * Build a map from remote_file_id → original local asset creation time.
 * The server index can only report what the uploader sent; this local map lets
 * the Photos tab repair display grouping for rows uploaded by older native
 * builds that accidentally sent upload time instead of PHAsset.creationDate.
 */
export async function getRemoteCreatedAtMap(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ remote_file_id: string; created_at: string }>(
    `SELECT remote_file_id, created_at FROM backup_assets
      WHERE status IN ('uploaded', 'orphaned')
        AND remote_file_id IS NOT NULL
        AND created_at IS NOT NULL`,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.remote_file_id, row.created_at);
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
    `SELECT DATE(uploaded_at, 'localtime') as date, COUNT(*) as count, SUM(file_size) as bytes
     FROM backup_assets WHERE status = 'uploaded' AND uploaded_at >= ?
     GROUP BY DATE(uploaded_at, 'localtime') ORDER BY date DESC`,
    [cutoff.toISOString()],
  );
}

// ─── Backup verification ────────────────────────────────────────────────────

export interface VerificationRecord {
  id: number;
  verified_at: string;
  remote_file_id: string;
  success: boolean;
  error_message: string | null;
  file_size: number | null;
}

/**
 * Record a verification result. Keeps only the last 20 rows to avoid
 * unbounded growth.
 */
export async function recordVerification(
  remoteFileId: string,
  success: boolean,
  errorMessage?: string,
  fileSize?: number,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO backup_verification (remote_file_id, success, error_message, file_size)
     VALUES (?, ?, ?, ?)`,
    [remoteFileId, success ? 1 : 0, errorMessage ?? null, fileSize ?? null],
  );
  // Trim to last 20 rows
  await db.runAsync(
    `DELETE FROM backup_verification WHERE id NOT IN (
       SELECT id FROM backup_verification ORDER BY id DESC LIMIT 20
     )`,
  );
}

/**
 * Get the most recent verification result.
 */
export async function getLastVerification(): Promise<VerificationRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: number;
    verified_at: string;
    remote_file_id: string;
    success: number;
    error_message: string | null;
    file_size: number | null;
  }>(
    `SELECT id, verified_at, remote_file_id, success, error_message, file_size
       FROM backup_verification ORDER BY id DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: row.id,
    verified_at: row.verified_at,
    remote_file_id: row.remote_file_id,
    success: row.success === 1,
    error_message: row.error_message,
    file_size: row.file_size,
  };
}

/**
 * Pick a random uploaded backup asset with a remote_file_id.
 */
export async function getRandomUploadedAsset(): Promise<BackupAsset | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<BackupAsset>(
    `SELECT * FROM backup_assets
      WHERE status = 'uploaded' AND remote_file_id IS NOT NULL
      ORDER BY RANDOM() LIMIT 1`,
  );
  return row ?? null;
}
