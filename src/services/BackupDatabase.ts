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
 * `BackupService.ts` and `PhotoBackupRunner.ts` keep working with no edits.
 *
 * See docs/specs/010-device-backup-system.md for the full design.
 */

import * as SQLite from 'expo-sqlite';

export type BackupAssetType = 'photo' | 'video' | 'contact' | 'calendar';
export type BackupAssetStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

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
    status: asset.status ?? existing?.status ?? 'pending',
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
          WHERE status IN ('pending','failed')
            AND asset_type = ?
          ORDER BY created_at ASC`,
        [assetType],
      )
    : await db.getAllAsync<BackupAsset>(
        `SELECT * FROM backup_assets
          WHERE status IN ('pending','failed')
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
  _error?: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'failed' WHERE local_asset_id = ?`,
    [localAssetId],
  );
}

export async function markUploading(localAssetId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'uploading' WHERE local_asset_id = ?`,
    [localAssetId],
  );
}

export async function resetFailedAssets(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE backup_assets SET status = 'pending' WHERE status = 'failed'`,
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
