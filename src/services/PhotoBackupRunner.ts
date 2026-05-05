/**
 * PhotoBackupRunner — JS-side foreground photo backup.
 *
 * Flow per session:
 *   1. Enumerate up to BATCH_SIZE + CHECK_BATCH_SIZE assets from MediaLibrary
 *      (most recent first, photos + optionally videos)
 *   2. Check server: which identifiers still need backup?
 *   3. For each un-backed asset: getAssetInfoAsync → encryptedUpload → mark
 *   4. Report progress via onProgress callback
 *
 * Wi-Fi gate is handled by the caller (PhotoBackupBridge).
 * MVP: foreground only — no BGProcessingTask / BGAppRefreshTask.
 */

import NetInfo from '@react-native-community/netinfo';

let MediaLibrary: {
  getAssetsAsync: (opts: {
    first: number;
    sortBy: unknown[];
    mediaType: string[];
    after?: string;
  }) => Promise<{
    assets: Array<{
      id: string;
      filename: string;
      uri: string;
      mediaType: string;
      duration: number;
      width: number;
      height: number;
    }>;
    hasNextPage: boolean;
    endCursor: string;
    totalCount: number;
  }>;
  getAssetInfoAsync: (asset: { id: string }) => Promise<{
    localUri?: string;
    id: string;
    filename: string;
    uri: string;
    mediaType: string;
  }>;
  SortBy: { creationTime: unknown };
  MediaType: { photo: string; video: string };
} | null = null;

try {
  MediaLibrary = require('expo-media-library');
} catch {
  // expo-media-library not available (e.g. web preview)
}

import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import {
  photoBackupCheck,
  photoBackupMark,
  createFolder,
  listFiles,
} from '../lib/api';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum assets to upload per foreground session (battery guard). */
const SESSION_UPLOAD_LIMIT = 50;
/** How many asset IDs to send in a single check batch. */
const CHECK_BATCH_SIZE = 200;
/** How many assets to enumerate from MediaLibrary per getAssetsAsync call. */
const ENUMERATE_BATCH = 200;
/** Name of the top-level Photos folder in the user's vault. */
const PHOTOS_FOLDER_NAME = 'Photos';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PhotoBackupRunnerOpts {
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
  /** Include video assets in addition to photos. */
  includeVideos: boolean;
  /** Called after each upload with (uploaded, totalNeedingBackup). */
  onProgress?: (uploaded: number, total: number) => void;
  /** Abort the session early. */
  signal?: AbortSignal;
}

export interface PhotoBackupResult {
  uploaded: number;
  skipped: number;
  failed: number;
}

// ─── Folder helpers ───────────────────────────────────────────────────────────

async function ensurePhotosFolder(): Promise<string> {
  // Reuse cached folder ID if available
  const files = await listFiles(undefined);
  const existing = files.find((f) => f.is_folder && f.name_encrypted === PHOTOS_FOLDER_NAME);
  if (existing) return existing.id;
  const created = await createFolder(PHOTOS_FOLDER_NAME, undefined);
  return created.id;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

/**
 * Run a single foreground backup session.
 * Call from PhotoBackupBridge when the app becomes active.
 *
 * Returns a summary of what happened.
 * Does nothing (returns zeros) when MediaLibrary is unavailable.
 */
export async function runPhotoBackupSession(
  opts: PhotoBackupRunnerOpts,
): Promise<PhotoBackupResult> {
  const result: PhotoBackupResult = { uploaded: 0, skipped: 0, failed: 0 };

  if (!MediaLibrary) {
    console.warn('[PhotoBackupRunner] expo-media-library not available — skipping session');
    return result;
  }

  const { encryptChunkFn, encryptMetadataFn, includeVideos, onProgress, signal } = opts;

  // ── 1. Enumerate the most recent assets from MediaLibrary ────────────────
  const mediaTypes: string[] = [MediaLibrary.MediaType.photo];
  if (includeVideos) mediaTypes.push(MediaLibrary.MediaType.video);

  // Gather enough assets to find SESSION_UPLOAD_LIMIT that need backup.
  // We over-fetch because many may already be backed up.
  let allAssets: Array<{ id: string; filename: string; uri: string; mediaType: string }> = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore && allAssets.length < CHECK_BATCH_SIZE) {
    if (signal?.aborted) return result;

    const page = await MediaLibrary.getAssetsAsync({
      first: ENUMERATE_BATCH,
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: mediaTypes,
      ...(cursor ? { after: cursor } : {}),
    });

    allAssets = allAssets.concat(page.assets);
    hasMore = page.hasNextPage;
    cursor = page.endCursor;
  }

  if (allAssets.length === 0) return result;

  // ── 2. Check server: which identifiers need backup? ───────────────────────
  if (signal?.aborted) return result;

  const identifiers = allAssets.map((a) => a.id);
  let needsBackup: string[] = identifiers; // default: all need backup if endpoint 404s

  try {
    const checkResult = await photoBackupCheck(identifiers);
    needsBackup = checkResult.needs_backup;
  } catch (err) {
    console.warn('[PhotoBackupRunner] check endpoint unavailable, backing up all:', err);
    // Fall through with all assets — server will deduplicate on the file_id
  }

  if (needsBackup.length === 0) return result;

  // Build a quick lookup set and filter the asset list
  const needsSet = new Set(needsBackup);
  const toUpload = allAssets
    .filter((a) => needsSet.has(a.id))
    .slice(0, SESSION_UPLOAD_LIMIT);

  result.skipped = needsBackup.length - toUpload.length; // over-limit ones

  // ── 3. Ensure /Photos folder exists ──────────────────────────────────────
  if (signal?.aborted) return result;

  let photosFolderId: string | undefined;
  try {
    photosFolderId = await ensurePhotosFolder();
  } catch (err) {
    console.warn('[PhotoBackupRunner] could not ensure Photos folder:', err);
    // Continue — files will land at root
  }

  const total = toUpload.length;
  onProgress?.(0, total);

  // ── 4. Upload loop ────────────────────────────────────────────────────────
  for (let i = 0; i < toUpload.length; i++) {
    if (signal?.aborted) break;

    const asset = toUpload[i];

    try {
      // Resolve the local filesystem URI (ph:// → file://)
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri ?? info.uri;
      if (!uri || !uri.startsWith('file://')) {
        console.warn('[PhotoBackupRunner] no local URI for', asset.filename);
        result.failed++;
        continue;
      }

      const fileId = generateFileId();
      await encryptedUpload({
        fileId,
        uri,
        name: asset.filename,
        parentId: photosFolderId,
        mimeType: asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
        encryptChunkFn,
        encryptMetadataFn,
      });

      // Mark success with the asset's local identifier
      await photoBackupMark(asset.id, fileId);

      result.uploaded++;
      onProgress?.(result.uploaded, total);
    } catch (err) {
      console.warn('[PhotoBackupRunner] failed to backup', asset.filename, err);
      result.failed++;
    }
  }

  return result;
}

// ─── Wi-Fi check (re-exported for use by PhotoBackupBridge) ──────────────────

export async function isOnWifi(): Promise<boolean> {
  try {
    const net = await NetInfo.fetch();
    return net.type === 'wifi' && net.isConnected !== false;
  } catch {
    return false;
  }
}
