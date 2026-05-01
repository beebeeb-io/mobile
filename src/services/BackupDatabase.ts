/**
 * Local sync index for the device backup system.
 *
 * Tracks which local assets (photos, videos, contacts, calendar events) have
 * been uploaded to the user's encrypted Backups/ folder, so we can perform
 * incremental syncs without listing remote files every cycle.
 *
 * Uses an in-memory store that works in Expo Go. For production dev builds
 * with native modules, this can be swapped to expo-sqlite for persistence
 * across app restarts.
 *
 * See docs/specs/010-device-backup-system.md for the full design.
 */

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

const store = new Map<string, BackupAsset>();

export async function initDatabase(): Promise<void> {}

export async function getAsset(localAssetId: string): Promise<BackupAsset | null> {
  return store.get(localAssetId) ?? null;
}

export async function upsertAsset(
  asset: Partial<BackupAsset> & { local_asset_id: string }
): Promise<void> {
  const existing = store.get(asset.local_asset_id);
  store.set(asset.local_asset_id, {
    local_asset_id: asset.local_asset_id,
    remote_file_id: asset.remote_file_id ?? existing?.remote_file_id ?? null,
    remote_path: asset.remote_path ?? existing?.remote_path ?? null,
    content_hash: asset.content_hash ?? existing?.content_hash ?? '',
    file_size: asset.file_size ?? existing?.file_size ?? 0,
    created_at: asset.created_at ?? existing?.created_at ?? new Date().toISOString(),
    uploaded_at: asset.uploaded_at ?? existing?.uploaded_at ?? null,
    asset_type: asset.asset_type ?? existing?.asset_type ?? 'photo',
    status: asset.status ?? existing?.status ?? 'pending',
  });
}

export async function getPendingAssets(assetType?: BackupAssetType): Promise<BackupAsset[]> {
  const results: BackupAsset[] = [];
  for (const a of store.values()) {
    if (a.status === 'pending' || a.status === 'failed') {
      if (!assetType || a.asset_type === assetType) results.push(a);
    }
  }
  return results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getUploadedCount(assetType: BackupAssetType): Promise<number> {
  let count = 0;
  for (const a of store.values()) {
    if (a.status === 'uploaded' && a.asset_type === assetType) count++;
  }
  return count;
}

export async function getTotalCount(assetType: BackupAssetType): Promise<number> {
  let count = 0;
  for (const a of store.values()) {
    if (a.asset_type === assetType) count++;
  }
  return count;
}

export async function getTotalBytes(assetType: BackupAssetType): Promise<number> {
  let total = 0;
  for (const a of store.values()) {
    if (a.asset_type === assetType) total += a.file_size;
  }
  return total;
}

export async function getUploadedBytes(assetType: BackupAssetType): Promise<number> {
  let total = 0;
  for (const a of store.values()) {
    if (a.status === 'uploaded' && a.asset_type === assetType) total += a.file_size;
  }
  return total;
}

export async function markUploaded(
  localAssetId: string,
  remoteFileId: string,
  remotePath: string
): Promise<void> {
  const asset = store.get(localAssetId);
  if (asset) {
    asset.status = 'uploaded';
    asset.remote_file_id = remoteFileId;
    asset.remote_path = remotePath;
    asset.uploaded_at = new Date().toISOString();
  }
}

export async function markFailed(localAssetId: string, _error?: string): Promise<void> {
  const asset = store.get(localAssetId);
  if (asset) asset.status = 'failed';
}

export async function markUploading(localAssetId: string): Promise<void> {
  const asset = store.get(localAssetId);
  if (asset) asset.status = 'uploading';
}

export async function resetFailedAssets(): Promise<number> {
  let count = 0;
  for (const a of store.values()) {
    if (a.status === 'failed') {
      a.status = 'pending';
      count++;
    }
  }
  return count;
}

export async function clearAssets(assetType: BackupAssetType): Promise<void> {
  for (const [key, a] of store) {
    if (a.asset_type === assetType) store.delete(key);
  }
}
