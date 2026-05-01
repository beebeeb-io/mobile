/**
 * Local SQLite sync index for the device backup system.
 *
 * Tracks which local assets (photos, videos, contacts, calendar events) have
 * been uploaded to the user's encrypted Backups/ folder, so we can perform
 * incremental syncs without listing remote files every cycle.
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

const DB_NAME = 'beebeeb_backup.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const database = await SQLite.openDatabaseAsync(DB_NAME);
      await database.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS backup_assets (
          local_asset_id TEXT PRIMARY KEY NOT NULL,
          remote_file_id TEXT,
          remote_path TEXT,
          content_hash TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          uploaded_at TEXT,
          asset_type TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backup_assets_status ON backup_assets(status);
        CREATE INDEX IF NOT EXISTS idx_backup_assets_asset_type ON backup_assets(asset_type);
      `);
      return database;
    })();
  }
  return dbPromise;
}

export async function initDatabase(): Promise<void> {
  await getDb();
}

export async function getAsset(localAssetId: string): Promise<BackupAsset | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<BackupAsset>(
    'SELECT * FROM backup_assets WHERE local_asset_id = ?',
    [localAssetId]
  );
  return row ?? null;
}

export async function upsertAsset(
  asset: Partial<BackupAsset> & { local_asset_id: string }
): Promise<void> {
  const db = await getDb();
  const existing = await getAsset(asset.local_asset_id);
  const merged: BackupAsset = {
    local_asset_id: asset.local_asset_id,
    remote_file_id: asset.remote_file_id ?? existing?.remote_file_id ?? null,
    remote_path: asset.remote_path ?? existing?.remote_path ?? null,
    content_hash: asset.content_hash ?? existing?.content_hash ?? '',
    file_size: asset.file_size ?? existing?.file_size ?? 0,
    created_at: asset.created_at ?? existing?.created_at ?? new Date().toISOString(),
    uploaded_at: asset.uploaded_at ?? existing?.uploaded_at ?? null,
    asset_type: asset.asset_type ?? existing?.asset_type ?? 'photo',
    status: asset.status ?? existing?.status ?? 'pending',
  };
  await db.runAsync(
    `INSERT OR REPLACE INTO backup_assets
     (local_asset_id, remote_file_id, remote_path, content_hash, file_size,
      created_at, uploaded_at, asset_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ]
  );
}

export async function getPendingAssets(assetType?: BackupAssetType): Promise<BackupAsset[]> {
  const db = await getDb();
  if (assetType) {
    return db.getAllAsync<BackupAsset>(
      `SELECT * FROM backup_assets
       WHERE status IN ('pending', 'failed') AND asset_type = ?
       ORDER BY created_at ASC`,
      [assetType]
    );
  }
  return db.getAllAsync<BackupAsset>(
    `SELECT * FROM backup_assets
     WHERE status IN ('pending', 'failed')
     ORDER BY created_at ASC`
  );
}

export async function getUploadedCount(assetType: BackupAssetType): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM backup_assets
     WHERE status = 'uploaded' AND asset_type = ?`,
    [assetType]
  );
  return row?.count ?? 0;
}

export async function getTotalCount(assetType: BackupAssetType): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM backup_assets WHERE asset_type = ?',
    [assetType]
  );
  return row?.count ?? 0;
}

export async function getTotalBytes(assetType: BackupAssetType): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    'SELECT SUM(file_size) AS total FROM backup_assets WHERE asset_type = ?',
    [assetType]
  );
  return row?.total ?? 0;
}

export async function getUploadedBytes(assetType: BackupAssetType): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(file_size) AS total FROM backup_assets
     WHERE status = 'uploaded' AND asset_type = ?`,
    [assetType]
  );
  return row?.total ?? 0;
}

export async function markUploaded(
  localAssetId: string,
  remoteFileId: string,
  remotePath: string
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets
     SET status = 'uploaded', remote_file_id = ?, remote_path = ?, uploaded_at = ?
     WHERE local_asset_id = ?`,
    [remoteFileId, remotePath, new Date().toISOString(), localAssetId]
  );
}

export async function markFailed(localAssetId: string, _error?: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'failed' WHERE local_asset_id = ?`,
    [localAssetId]
  );
}

export async function markUploading(localAssetId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE backup_assets SET status = 'uploading' WHERE local_asset_id = ?`,
    [localAssetId]
  );
}

export async function resetFailedAssets(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE backup_assets SET status = 'pending' WHERE status = 'failed'`
  );
  return result.changes ?? 0;
}

export async function clearAssets(assetType: BackupAssetType): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM backup_assets WHERE asset_type = ?', [assetType]);
}
