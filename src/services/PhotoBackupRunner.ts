/**
 * PhotoBackupRunner — JS-side foreground photo backup.
 *
 * Flow per session:
 *   1. Enumerate assets from MediaLibrary sorted ASCENDING (oldest first),
 *      starting after `createdAfterTs` (the last checkpoint timestamp).
 *      This means each session only sees assets that haven't been processed yet.
 *   2. Check server: which identifiers still need backup? (server-side dedup)
 *   3. For each un-backed asset: getAssetInfoAsync → encryptedUpload → mark
 *      → call onCheckpoint(asset.creationTime) for per-photo persistence
 *   4. Report progress via onProgress callback
 *
 * Wi-Fi gate and checkpoint I/O are handled by the caller (PhotoBackupBridge).
 * MVP: foreground only — no BGProcessingTask / BGAppRefreshTask.
 */

import NetInfo from '@react-native-community/netinfo';

// ─── MediaLibrary lazy import (unavailable on web) ────────────────────────────

type MLAsset = {
  id: string;
  filename: string;
  uri: string;
  mediaType: string;
  /** Unix timestamp in seconds. */
  creationTime: number;
  duration: number;
  width: number;
  height: number;
};

type MLAssetInfo = MLAsset & {
  localUri?: string;
};

type MLPageResult = {
  assets: MLAsset[];
  hasNextPage: boolean;
  endCursor: string;
  totalCount: number;
};

type MLLib = {
  getAssetsAsync: (opts: {
    first: number;
    sortBy: unknown[];
    mediaType: string[];
    after?: string;
    createdAfter?: number;
  }) => Promise<MLPageResult>;
  getAssetInfoAsync: (asset: { id: string }) => Promise<MLAssetInfo>;
  SortBy: { creationTime: unknown };
  MediaType: { photo: string; video: string };
};

let MediaLibrary: MLLib | null = null;
try {
  MediaLibrary = require('expo-media-library') as MLLib;
} catch {
  // expo-media-library not available (e.g. web preview)
}

// ─── Project imports ──────────────────────────────────────────────────────────

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
/** Assets to enumerate per getAssetsAsync page. */
const ENUMERATE_PAGE = 200;
/** Assets to include in a single check-batch request. */
const CHECK_BATCH = 200;
/** Folder name in the user's vault where photos are stored. */
const PHOTOS_FOLDER_NAME = 'Photos';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PhotoBackupRunnerOpts {
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
  /** Include video assets in addition to photos. */
  includeVideos: boolean;
  /**
   * Only include assets created after this Unix timestamp (seconds).
   * Null means "process all assets" (first-ever backup or explicit reset).
   */
  createdAfterTs: number | null;
  /** Called after each successful upload with (uploaded, totalInBatch). */
  onProgress?: (uploaded: number, total: number) => void;
  /**
   * Called after EACH successful upload with the asset's creationTime (seconds).
   * The caller should persist this so the next session can use `createdAfterTs`.
   */
  onCheckpoint?: (creationTimeSecs: number) => void;
  /** Abort the session early (e.g. app goes to background mid-session). */
  signal?: AbortSignal;
}

export interface PhotoBackupResult {
  uploaded: number;
  failed: number;
  /** Assets that needed backup but were beyond the session limit. */
  remaining: number;
}

// ─── Folder helpers ───────────────────────────────────────────────────────────

let cachedPhotosFolderId: string | null = null;

async function ensurePhotosFolder(): Promise<string> {
  if (cachedPhotosFolderId) return cachedPhotosFolderId;
  const files = await listFiles(undefined);
  const existing = files.find((f) => f.is_folder && f.name_encrypted === PHOTOS_FOLDER_NAME);
  const id = existing ? existing.id : (await createFolder(PHOTOS_FOLDER_NAME, undefined)).id;
  cachedPhotosFolderId = id;
  return id;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

/**
 * Run a single foreground backup session.
 *
 * Processes assets in ascending creation-time order (oldest first) so that
 * the checkpoint always advances forward. If the session limit (50) is
 * reached, `result.remaining` is non-zero, meaning a subsequent session
 * will continue where this one left off.
 *
 * Returns a summary of what happened.
 * Does nothing (returns zeros) when MediaLibrary is unavailable.
 */
export async function runPhotoBackupSession(
  opts: PhotoBackupRunnerOpts,
): Promise<PhotoBackupResult> {
  const result: PhotoBackupResult = { uploaded: 0, failed: 0, remaining: 0 };

  if (!MediaLibrary) {
    console.warn('[PhotoBackupRunner] expo-media-library not available — skipping session');
    return result;
  }

  const {
    encryptChunkFn, encryptMetadataFn, includeVideos,
    createdAfterTs, onProgress, onCheckpoint, signal,
  } = opts;

  // ── 1. Enumerate assets oldest-first, starting after the checkpoint ──────
  const mediaTypes: string[] = [MediaLibrary.MediaType.photo];
  if (includeVideos) mediaTypes.push(MediaLibrary.MediaType.video);

  let allAssets: MLAsset[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore && allAssets.length < CHECK_BATCH) {
    if (signal?.aborted) return result;

    const page = await MediaLibrary.getAssetsAsync({
      first: ENUMERATE_PAGE,
      // Ascending (oldest first) — correct for checkpoint-based resume
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: mediaTypes,
      ...(cursor ? { after: cursor } : {}),
      // Only fetch assets newer than the last checkpoint
      ...(createdAfterTs != null ? { createdAfter: createdAfterTs } : {}),
    });

    allAssets = allAssets.concat(page.assets);
    hasMore = page.hasNextPage;
    cursor = page.endCursor;
  }

  if (allAssets.length === 0) return result;

  // ── 2. Check server: which identifiers need backup? ───────────────────────
  if (signal?.aborted) return result;

  const identifiers = allAssets.map((a) => a.id);
  let needsBackup: string[] = identifiers; // fallback if endpoint unavailable

  try {
    const checkResult = await photoBackupCheck(identifiers);
    needsBackup = checkResult.needs_backup;
  } catch (err) {
    console.warn('[PhotoBackupRunner] check endpoint unavailable; backing up all:', err);
    // Continue — server will deduplicate on file_id
  }

  if (needsBackup.length === 0) return result;

  const needsSet = new Set(needsBackup);
  const toUpload = allAssets.filter((a) => needsSet.has(a.id));
  const sessionBatch = toUpload.slice(0, SESSION_UPLOAD_LIMIT);
  result.remaining = Math.max(0, toUpload.length - SESSION_UPLOAD_LIMIT);

  // ── 3. Ensure /Photos folder ──────────────────────────────────────────────
  if (signal?.aborted) return result;

  let photosFolderId: string | undefined;
  try {
    photosFolderId = await ensurePhotosFolder();
  } catch (err) {
    console.warn('[PhotoBackupRunner] could not ensure Photos folder:', err);
    // Continue — files will land at root
  }

  const total = sessionBatch.length;
  onProgress?.(0, total);

  // ── 4. Upload loop — one at a time, skip failures, checkpoint every success
  for (let i = 0; i < sessionBatch.length; i++) {
    if (signal?.aborted) break;

    const asset = sessionBatch[i];

    try {
      // Resolve ph:// → file:// URI
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri ?? info.uri;
      if (!uri || !uri.startsWith('file://')) {
        console.warn('[PhotoBackupRunner] no local URI for', asset.filename);
        result.failed++;
        continue;
      }

      const fileId = generateFileId();
      const mimeType = asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

      await encryptedUpload({
        fileId,
        uri,
        name: asset.filename,
        parentId: photosFolderId,
        mimeType,
        encryptChunkFn,
        encryptMetadataFn,
      });

      await photoBackupMark(asset.id, fileId);

      result.uploaded++;
      onProgress?.(result.uploaded, total);

      // Per-photo checkpoint — persist immediately so a kill doesn't lose work
      if (asset.creationTime) {
        onCheckpoint?.(asset.creationTime);
      }
    } catch (err) {
      if (signal?.aborted) break;
      console.warn('[PhotoBackupRunner] failed to backup', asset.filename, ':', err);
      result.failed++;
      // Continue with next asset — one failure must not block the rest
    }
  }

  return result;
}

// ─── Wi-Fi check ─────────────────────────────────────────────────────────────

export async function isOnWifi(): Promise<boolean> {
  try {
    const net = await NetInfo.fetch();
    return net.type === 'wifi' && net.isConnected !== false;
  } catch {
    return false;
  }
}
