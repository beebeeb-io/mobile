/**
 * PhotoBackupRunner — JS-side foreground photo backup.
 *
 * Flow per session:
 *   1. Enumerate assets from MediaLibrary (ascending, oldest first)
 *      starting after the checkpoint timestamp (Day 2 resume).
 *   2. Batch-check server for which identifiers still need backup.
 *   3. Upload-loop with adaptive batch sizing:
 *        - Probe the first PROBE_SIZE uploads to measure throughput (B/s)
 *        - Adjust session limit: Fast Wi-Fi → 200 · Normal → 50 · Slow → 25
 *   4. Per-photo checkpoint + progress reported every 5 uploads.
 *
 * Wi-Fi gate and checkpoint I/O are handled by the caller (PhotoBackupBridge).
 * MVP: foreground only — no BGProcessingTask / BGAppRefreshTask.
 */

import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';

// ─── MediaLibrary lazy import ─────────────────────────────────────────────────

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

type MLAssetInfo = MLAsset & { localUri?: string };

type MLLib = {
  getAssetsAsync: (opts: {
    first: number;
    sortBy: unknown[];
    mediaType: string[];
    after?: string;
    createdAfter?: number;
  }) => Promise<{ assets: MLAsset[]; hasNextPage: boolean; endCursor: string; totalCount: number }>;
  getAssetInfoAsync: (asset: { id: string }) => Promise<MLAssetInfo>;
  SortBy: { creationTime: unknown };
  MediaType: { photo: string; video: string };
};

let MediaLibrary: MLLib | null = null;
try { MediaLibrary = require('expo-media-library') as MLLib; } catch { /* web */ }

// ─── Project imports ──────────────────────────────────────────────────────────

import type { EncryptedData } from '../../modules/beebeeb-crypto';
import type { UploadProgress } from '../lib/api';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { photoBackupCheck, photoBackupMark, createFolder, listFiles } from '../lib/api';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Assets to enumerate per getAssetsAsync page. */
const ENUMERATE_PAGE = 200;
/** Assets to check against server in one batch. */
const CHECK_BATCH = 200;
/** Number of uploads before we measure throughput and set the adaptive limit. */
const PROBE_SIZE = 3;
/** Default session upload limit (used until after the probe). */
const LIMIT_NORMAL = 50;
/** Session limit for fast connections (> 5 MB/s). */
const LIMIT_FAST = 200;
/** Session limit for slow connections (< 1 MB/s). */
const LIMIT_SLOW = 25;
/** Throughput thresholds in bytes/sec. */
const FAST_THRESHOLD = 5 * 1024 * 1024;
const SLOW_THRESHOLD = 1 * 1024 * 1024;
/** Report progress every N successful uploads to reduce UI churn. */
const PROGRESS_REPORT_EVERY = 5;
/** Photos folder name at vault root. */
export const PHOTOS_FOLDER_NAME = 'Photos';
/**
 * Maximum ciphertext bytes per foreground session.
 * Prevents a single session from uploading unlimited video data.
 * 2 GB ≈ ~400 photos or ~10 min of 4K video — generous but bounded.
 */
const SESSION_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PhotoProgressInfo {
  uploaded: number;
  /** Current adaptive session limit (may grow after probe). */
  total: number;
  /** Bytes/sec measured over this session. 0 before any data flows. */
  throughputBps: number;
  /** Estimated seconds remaining. null when not enough data yet. */
  etaSeconds: number | null;
  /** Filename of the asset currently being uploaded. */
  currentFileName: string;
  /**
   * Ciphertext size of the current file in bytes.
   * Available after the first onProgress callback from encryptedUpload.
   * 0 when unknown (e.g. first report before any data flows).
   */
  currentFileSizeBytes: number;
}

export interface PhotoBackupRunnerOpts {
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
  includeVideos: boolean;
  /**
   * Only process assets created after this Unix timestamp (seconds).
   * Null → process everything (first ever backup, or explicit reset).
   */
  createdAfterTs: number | null;
  /** Called every PROGRESS_REPORT_EVERY uploads and on completion. */
  onProgress?: (info: PhotoProgressInfo) => void;
  /** Called after each successful upload — caller persists the checkpoint. */
  onCheckpoint?: (creationTimeSecs: number) => void;
  signal?: AbortSignal;
}

export interface PhotoBackupResult {
  uploaded: number;
  failed: number;
  /** Assets beyond the adaptive session limit — need another session. */
  remaining: number;
  /** Final measured throughput in bytes/sec. */
  throughputBps: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeAdaptiveLimit(throughputBps: number): number {
  if (throughputBps >= FAST_THRESHOLD) return LIMIT_FAST;
  if (throughputBps >= SLOW_THRESHOLD) return LIMIT_NORMAL;
  return LIMIT_SLOW;
}

const PHOTOS_FOLDER_ID_KEY = 'beebeeb_photos_folder_id';
let cachedPhotosFolderId: string | null = null;

/** Encode EncryptedData to the JSON wire format the server stores and web decodes. */
function encryptedDataToJson(enc: EncryptedData): string {
  function uint8ToBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return JSON.stringify({
    nonce: uint8ToBase64(enc.nonce),
    ciphertext: uint8ToBase64(enc.ciphertext),
  });
}

async function ensurePhotosFolder(
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>,
): Promise<string> {
  // 1. In-memory cache (fast path within a session)
  if (cachedPhotosFolderId) return cachedPhotosFolderId;
  // 2. Persistent cache across sessions (SecureStore)
  const stored = await SecureStore.getItemAsync(PHOTOS_FOLDER_ID_KEY).catch(() => null);
  if (stored) {
    cachedPhotosFolderId = stored;
    return stored;
  }
  // 3. Create with a properly-encrypted name in JSON {nonce, ciphertext} format.
  // The client-generated folderId is passed to the server so the server record
  // is addressable by this ID from the first request.
  const folderId = generateFileId();
  const enc = await encryptMetadataFn(folderId, PHOTOS_FOLDER_NAME);
  const nameEncrypted = encryptedDataToJson(enc);
  const folder = await createFolder(nameEncrypted, undefined, folderId);
  cachedPhotosFolderId = folder.id;
  await SecureStore.setItemAsync(PHOTOS_FOLDER_ID_KEY, folder.id).catch(() => {});
  return folder.id;
}

function formatEtaSeconds(secs: number): string {
  if (secs < 60) return '< 1 min';
  const mins = Math.ceil(secs / 60);
  return `~${mins} min`;
}
// Exported for use in SettingsScreen
export { formatEtaSeconds };

/**
 * Detect MIME type from filename extension + MediaLibrary mediaType.
 * Falls back to `image/jpeg` for unknown photos, `video/mp4` for unknown videos.
 */
function detectMimeType(filename: string, mediaType: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const VIDEO_MIME: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    avi: 'video/avi',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    '3gp': 'video/3gpp',
  };
  const IMAGE_MIME: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif',
    avif: 'image/avif',
    tiff: 'image/tiff', tif: 'image/tiff',
  };
  if (mediaType === 'video') return VIDEO_MIME[ext] ?? 'video/mp4';
  return IMAGE_MIME[ext] ?? 'image/jpeg';
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runPhotoBackupSession(
  opts: PhotoBackupRunnerOpts,
): Promise<PhotoBackupResult> {
  const result: PhotoBackupResult = { uploaded: 0, failed: 0, remaining: 0, throughputBps: 0 };

  if (!MediaLibrary) {
    console.warn('[PhotoBackupRunner] expo-media-library not available');
    return result;
  }

  const { encryptChunkFn, encryptMetadataFn, includeVideos, createdAfterTs, onProgress, onCheckpoint, signal } = opts;

  // ── 1. Enumerate assets (oldest-first for checkpoint-based resume) ────────
  const mediaTypes: string[] = [MediaLibrary.MediaType.photo];
  if (includeVideos) mediaTypes.push(MediaLibrary.MediaType.video);

  let allAssets: MLAsset[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore && allAssets.length < CHECK_BATCH) {
    if (signal?.aborted) return result;
    const page = await MediaLibrary.getAssetsAsync({
      first: ENUMERATE_PAGE,
      sortBy: [MediaLibrary.SortBy.creationTime], // ascending (oldest first)
      mediaType: mediaTypes,
      ...(cursor ? { after: cursor } : {}),
      ...(createdAfterTs != null ? { createdAfter: createdAfterTs } : {}),
    });
    allAssets = allAssets.concat(page.assets);
    hasMore = page.hasNextPage;
    cursor = page.endCursor;
  }

  if (allAssets.length === 0) return result;

  // ── 2. Check server: which identifiers still need backup? ─────────────────
  if (signal?.aborted) return result;

  const identifiers = allAssets.map((a) => a.id);
  let needsBackup: string[] = identifiers;
  try {
    const r = await photoBackupCheck(identifiers);
    needsBackup = r.needs_backup;
  } catch (err) {
    console.warn('[PhotoBackupRunner] check endpoint unavailable, backing up all:', err);
  }

  if (needsBackup.length === 0) return result;

  const needsSet = new Set(needsBackup);
  const toUpload = allAssets.filter((a) => needsSet.has(a.id));

  // ── 3. Ensure Photos folder ────────────────────────────────────────────────
  if (signal?.aborted) return result;
  let photosFolderId: string | undefined;
  try {
    photosFolderId = await ensurePhotosFolder(encryptMetadataFn);
  } catch (err) {
    console.warn('[PhotoBackupRunner] could not ensure Photos folder:', err);
  }

  // ── 4. Adaptive upload loop ────────────────────────────────────────────────
  //
  // `adaptiveLimit` starts at LIMIT_NORMAL (50). After PROBE_SIZE uploads we
  // compute throughput and adjust it up or down. The loop stops at whichever
  // comes first: toUpload.length, adaptiveLimit, or SESSION_MAX_BYTES.
  //
  // Videos can be 4+ GB each — the byte cap prevents runaway foreground uploads.
  // The streaming upload (encryptedUpload) reads one 4 MB chunk at a time so
  // memory usage is O(chunk_size) regardless of video size.
  //
  let adaptiveLimit = LIMIT_NORMAL;
  let bytesThisSession = 0;
  const sessionStartMs = Date.now();
  let lastProgressAt = 0;  // uploaded count at last progress report
  let currentFileName = '';
  let currentFileSizeBytes = 0;

  // Initial progress report
  onProgress?.({ uploaded: 0, total: adaptiveLimit, throughputBps: 0, etaSeconds: null, currentFileName: '', currentFileSizeBytes: 0 });

  for (let i = 0; i < toUpload.length && result.uploaded < adaptiveLimit; i++) {
    if (signal?.aborted) break;

    // Byte cap: stop before uploading the next file if we'd exceed the session limit
    if (bytesThisSession >= SESSION_MAX_BYTES) {
      console.log(`[PhotoBackupRunner] session byte cap reached (${(bytesThisSession / 1024 / 1024).toFixed(0)} MB)`);
      break;
    }

    const asset = toUpload[i];

    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri ?? info.uri;
      if (!uri || !uri.startsWith('file://')) {
        console.warn('[PhotoBackupRunner] no local URI for', asset.filename);
        result.failed++;
        continue;
      }

      const fileId = generateFileId();
      let fileBytesTotal = 0;
      let fileBytesUploaded = 0;

      currentFileName = asset.filename;
      currentFileSizeBytes = 0;

      await encryptedUpload({
        fileId,
        uri,
        name: asset.filename,
        parentId: photosFolderId,
        mimeType: detectMimeType(asset.filename, asset.mediaType),
        encryptChunkFn,
        encryptMetadataFn,
        onProgress: (p: UploadProgress) => {
          fileBytesTotal = p.bytesTotal;
          fileBytesUploaded = p.bytesUploaded;
          currentFileSizeBytes = fileBytesTotal;
        },
      });

      await photoBackupMark(asset.id, fileId);

      bytesThisSession += fileBytesUploaded || fileBytesTotal;
      result.uploaded++;

      // Per-photo checkpoint — fire-and-forget
      if (asset.creationTime) {
        onCheckpoint?.(asset.creationTime);
      }

      // After the probe phase: measure throughput and tune the limit
      if (result.uploaded === PROBE_SIZE) {
        const elapsedSecs = (Date.now() - sessionStartMs) / 1000;
        const probeThroughput = elapsedSecs > 0 ? bytesThisSession / elapsedSecs : 0;
        adaptiveLimit = computeAdaptiveLimit(probeThroughput);
        console.log(
          `[PhotoBackupRunner] probe: ${(probeThroughput / 1024 / 1024).toFixed(2)} MB/s → limit=${adaptiveLimit}`,
        );
      }

      // Report progress every PROGRESS_REPORT_EVERY uploads (or at the end)
      const isLast = result.uploaded >= adaptiveLimit || i === toUpload.length - 1;
      if (result.uploaded - lastProgressAt >= PROGRESS_REPORT_EVERY || isLast) {
        lastProgressAt = result.uploaded;
        const elapsedSecs = Math.max((Date.now() - sessionStartMs) / 1000, 0.001);
        const throughputBps = bytesThisSession / elapsedSecs;
        let etaSeconds: number | null = null;
        if (throughputBps > 0 && bytesThisSession > 0) {
          const avgBytesPerFile = bytesThisSession / result.uploaded;
          const remaining = Math.max(adaptiveLimit - result.uploaded, 0);
          etaSeconds = (remaining * avgBytesPerFile) / throughputBps;
        }
        result.throughputBps = throughputBps;
        onProgress?.({
          uploaded: result.uploaded, total: adaptiveLimit,
          throughputBps, etaSeconds,
          currentFileName, currentFileSizeBytes,
        });
      }
    } catch (err) {
      if (signal?.aborted) break;
      console.warn('[PhotoBackupRunner] failed to backup', asset.filename, ':', err);
      result.failed++;
    }
  }

  // Count remaining (beyond adaptive limit)
  result.remaining = Math.max(0, toUpload.length - result.uploaded - result.failed);

  // Final throughput
  const totalElapsedSecs = Math.max((Date.now() - sessionStartMs) / 1000, 0.001);
  result.throughputBps = bytesThisSession > 0 ? bytesThisSession / totalElapsedSecs : 0;

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
