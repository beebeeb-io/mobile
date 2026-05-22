/**
 * One-shot migration of the legacy `BackupDatabase` (expo-sqlite) rows into
 * the Swift-owned backup store for task 0437.
 *
 * Reads the existing `backup_assets` table, shapes each row into the
 * `LegacyBackupRow` payload that Swift's `migrateLegacyBackupState` ingests,
 * and posts them in batches. Swift is idempotent — re-running this is safe.
 *
 * A success flag (`backup.migrated@0437`) is written to AsyncStorage so the
 * migration only runs once per device.
 *
 * Dead code until the Swift bridge ships; safe to import at App-load time.
 * See `.claude/tasks/in-development/0437-single-owner-backup-state.md`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { BackupAsset } from '../services/BackupDatabase';
import {
  type LegacyBackupRow,
  isBridgeReady,
  migrateLegacyBackupState,
} from './backup-bridge';

const MIGRATION_FLAG_KEY = 'backup.migrated@0437';
const BATCH_SIZE = 500;

export function legacyRowFromAsset(asset: BackupAsset): LegacyBackupRow {
  return {
    localAssetId: asset.local_asset_id,
    remoteFileId: asset.remote_file_id,
    contentHash: asset.content_hash,
    fileSize: asset.file_size,
    createdAt: asset.created_at,
    uploadedAt: asset.uploaded_at,
    assetType: asset.asset_type,
    status: asset.status,
    retryCount: asset.retry_count,
    errorMessage: asset.error_message,
  };
}

export function chunkRows(
  rows: LegacyBackupRow[],
  batchSize: number = BATCH_SIZE,
): LegacyBackupRow[][] {
  if (rows.length === 0) return [];
  const size = Math.max(1, Math.floor(batchSize));
  const batches: LegacyBackupRow[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}

export async function hasMigrated(): Promise<boolean> {
  try {
    const flag = await AsyncStorage.getItem(MIGRATION_FLAG_KEY);
    return flag === '1';
  } catch {
    return false;
  }
}

async function markMigrated(): Promise<void> {
  try {
    await AsyncStorage.setItem(MIGRATION_FLAG_KEY, '1');
  } catch {
    // Best-effort — if the flag write fails we re-attempt next launch; Swift
    // is idempotent so a duplicate migration is harmless.
  }
}

export interface LegacyRowSource {
  /** All rows currently in the legacy SQLite `backup_assets` table. */
  fetchAll(): Promise<BackupAsset[]>;
}

/**
 * Run the migration if (a) the Swift bridge is available, and (b) the flag is
 * not already set. Safe to call on every app launch — it's a no-op once done.
 *
 * `source` is injected so tests can supply a fake; production callers pass a
 * thin wrapper around `BackupDatabase`'s row enumerator.
 */
export async function runLegacyBackupMigration(
  source: LegacyRowSource,
): Promise<{ skipped: boolean; rowsMigrated: number }> {
  if (!isBridgeReady()) return { skipped: true, rowsMigrated: 0 };
  if (await hasMigrated()) return { skipped: true, rowsMigrated: 0 };

  const assets = await source.fetchAll();
  const rows = assets.map(legacyRowFromAsset);
  for (const batch of chunkRows(rows)) {
    await migrateLegacyBackupState(batch);
  }

  await markMigrated();
  return { skipped: false, rowsMigrated: rows.length };
}

// ---------------------------------------------------------------------------
// Test helpers — exported so the unit test can reset state between cases.
// ---------------------------------------------------------------------------

export const __testing = {
  MIGRATION_FLAG_KEY,
  BATCH_SIZE,
};
