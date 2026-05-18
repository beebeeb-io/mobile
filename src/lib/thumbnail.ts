/**
 * Thumbnail generation for all media uploads: images, videos, and RAW photos.
 *
 * Thumbnails are encrypted with the file's AES-256-GCM key before upload,
 * matching the web client's format: nonce(12) || ciphertext.
 *
 * Supported formats:
 * - JPEG, PNG, HEIC, WebP, etc.: expo-image-manipulator resizes to 256px JPEG
 * - DNG (RAW photos): native UIImage/CoreImage decodes the embedded preview
 * - MP4, MOV (videos): native AVAssetImageGenerator extracts a frame at ~1s
 *
 * Best-effort: a failed thumbnail must never block or rollback the
 * underlying upload. Callers should not await the result.
 */

import { uploadThumbnail, downloadFile, getToken, thumbnailUrl } from './api';
import {
  encryptChunk,
  decryptChunk,
  generateVideoThumbnail as nativeGenerateVideoThumbnail,
  generateDngThumbnail as nativeGenerateDngThumbnail,
} from '../../modules/beebeeb-crypto';
import * as FileSystem from 'expo-file-system';
import { EncodingType } from 'expo-file-system';
import {
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from './encrypted-download';
import {
  getCachedThumbnail,
  cacheThumbnailBase64,
} from './thumbnail-cache';

let ImageManipulator: typeof import('expo-image-manipulator') | null = null;
try { ImageManipulator = require('expo-image-manipulator'); } catch {}

const THUMB_WIDTH = 256;
const THUMB_QUALITY = 0.7;
const MAX_THUMB_CACHE_ITEMS = 15000;
const PREFETCH_CONCURRENCY = 4;

const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';
const DNG_MIME = 'image/x-adobe-dng';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith(IMAGE_MIME_PREFIX);
}

export function isVideoMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith(VIDEO_MIME_PREFIX);
}

export function isDngMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType === DNG_MIME;
}

/** Whether thumbnails can be generated for this MIME type. */
export function isThumbnailable(mimeType: string | null | undefined): boolean {
  return isImageMime(mimeType) || isVideoMime(mimeType);
}

/**
 * Resize an image at `sourceUri` down to a 256-px-wide JPEG and
 * return its bytes. Returns null if the source can't be processed.
 */
export async function generateThumbnail(sourceUri: string): Promise<Uint8Array | null> {
  try {
    if (!ImageManipulator) return null;
    const result = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: THUMB_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    if (!result.base64) return null;
    return base64ToBytes(result.base64);
  } catch {
    return null;
  }
}

/**
 * Generate a thumbnail for a DNG (RAW) photo using the native CoreImage
 * decoder. Returns bytes of a JPEG thumbnail, or null on failure.
 */
async function generateDngThumbnailBytes(sourceUri: string): Promise<Uint8Array | null> {
  try {
    const thumbPath = await nativeGenerateDngThumbnail(sourceUri, THUMB_WIDTH);
    const b64 = await FileSystem.readAsStringAsync(thumbPath, { encoding: EncodingType.Base64 });
    await FileSystem.deleteAsync(thumbPath, { idempotent: true }).catch(() => {});
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

/**
 * Generate a thumbnail for a video file (MP4/MOV) using the native
 * AVAssetImageGenerator. Returns bytes of a JPEG thumbnail, or null on failure.
 */
async function generateVideoThumbnailBytes(sourceUri: string): Promise<Uint8Array | null> {
  try {
    const thumbPath = await nativeGenerateVideoThumbnail(sourceUri, THUMB_WIDTH);
    const b64 = await FileSystem.readAsStringAsync(thumbPath, { encoding: EncodingType.Base64 });
    await FileSystem.deleteAsync(thumbPath, { idempotent: true }).catch(() => {});
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

/**
 * Generate thumbnail bytes for any supported media type.
 * Routes to the appropriate generator based on MIME type:
 * - DNG: native CoreImage decoder
 * - Video (MP4/MOV): native AVAssetImageGenerator
 * - Other images: expo-image-manipulator
 */
async function generateThumbnailForMedia(
  sourceUri: string,
  mimeType: string | null | undefined,
): Promise<Uint8Array | null> {
  if (isDngMime(mimeType)) {
    return generateDngThumbnailBytes(sourceUri);
  }
  if (isVideoMime(mimeType)) {
    return generateVideoThumbnailBytes(sourceUri);
  }
  return generateThumbnail(sourceUri);
}

/**
 * Generate a thumbnail, encrypt it with the file key, and upload it.
 * Also caches the plaintext thumbnail locally so the Photos grid can display
 * it immediately without a server round-trip.
 *
 * Supports all media types: standard images, DNG (RAW), and video (MP4/MOV).
 * Fire-and-forget: never throws, never blocks the caller's success flow.
 */
export async function generateAndUploadThumbnail(
  fileId: string,
  sourceUri: string,
  mimeType: string | null | undefined,
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>,
): Promise<void> {
  if (!isThumbnailable(mimeType)) return;
  try {
    const thumb = await generateThumbnailForMedia(sourceUri, mimeType);
    if (!thumb) return;

    // Cache the plaintext thumbnail in persistent storage for instant display
    const b64 = bytesToBase64(thumb);
    try {
      const persistedPath = await cacheThumbnailBase64(fileId, b64);
      thumbCache.set(fileId, persistedPath);
    } catch {
      // Persist failed — still upload the thumbnail to server
    }

    const fileKey = await getFileKeyBytes(fileId);
    const { nonce, ciphertext } = await encryptChunk(fileKey, thumb);

    // Wire format: nonce(12) || ciphertext — matches the web client.
    const wire = new Uint8Array(nonce.length + ciphertext.length);
    wire.set(nonce, 0);
    wire.set(ciphertext, nonce.length);

    await uploadThumbnail(fileId, wire);
  } catch {
    // Best-effort — swallow.
  }
}

/**
 * Generate a thumbnail from a local camera-roll URI and cache it locally.
 * This avoids a server download+decrypt for photos that already exist on device.
 * Returns the cached thumbnail URI, or null on failure.
 *
 * Supports all media types when mimeType is provided: standard images,
 * DNG (RAW), and video (MP4/MOV). Falls back to image-only if omitted.
 */
export async function cacheLocalThumbnail(
  fileId: string,
  localUri: string,
  mimeType?: string | null,
): Promise<string | null> {
  try {
    // Already cached in persistent storage?
    const existing = await cachedThumbnailUri(fileId);
    if (existing) return existing;

    const thumb = await generateThumbnailForMedia(localUri, mimeType);
    if (!thumb) return null;

    const b64 = bytesToBase64(thumb);
    const persistedPath = await cacheThumbnailBase64(fileId, b64);
    thumbCache.set(fileId, persistedPath);
    return persistedPath;
  } catch {
    return null;
  }
}

function responseHeaderInt(headers: Headers, key: string): number | null {
  const value = headers.get(key) ?? headers.get(key.toLowerCase());
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Best-effort repair for media files that predate thumbnail generation.
 * Only call this for visible/recent items: it downloads the full encrypted
 * file, decrypts it locally, creates the normal encrypted thumbnail, uploads
 * that thumbnail, then leaves the visible cell to fetch the small thumbnail.
 *
 * Supports images, DNG (RAW photos), and video (MP4/MOV).
 */
export async function ensureThumbnailForImage(
  fileId: string,
  fileName: string | null | undefined,
  sizeBytes: number | null | undefined,
  chunkCount: number | null | undefined,
  mimeType: string | null | undefined,
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>,
): Promise<boolean> {
  if (!isThumbnailable(mimeType)) return false;
  const pending = repairInflight.get(fileId);
  if (pending) return pending;

  const repairPromise = (async () => {
    if (!FileSystem.cacheDirectory) return false;
    let sourceUri: string | null = null;
    try {
      const res = await downloadFile(fileId);
      const encryptedBytes = new Uint8Array(await res.arrayBuffer());
      const effectiveSize =
        responseHeaderInt(res.headers, 'X-Original-Size') ?? sizeBytes ?? encryptedBytes.length - 28;
      if (effectiveSize <= 0) return false;

      const headerChunkCount = responseHeaderInt(res.headers, 'X-Chunk-Count');
      const headerChunkSize = responseHeaderInt(res.headers, 'X-Chunk-Size');
      const inferred = inferChunkCountFromEncryptedSize(encryptedBytes.length, effectiveSize);
      const effectiveChunkCount = headerChunkCount ?? chunkCount ?? inferred ?? 1;
      const effectiveChunkSize = headerChunkSize && headerChunkSize > 0 ? headerChunkSize : undefined;

      const fileKey = await getFileKeyBytes(fileId);
      const plaintext = await decryptEncryptedBytes(
        fileKey,
        encryptedBytes,
        effectiveChunkCount,
        effectiveSize,
        effectiveChunkSize,
      );

      const mime = mimeType ?? '';
      const ext = mime.includes('png') ? 'png'
        : mime.includes('webp') ? 'webp'
          : mime.includes('heic') || mime.includes('heif') ? 'heic'
            : mime.includes('dng') ? 'dng'
              : mime.includes('quicktime') ? 'mov'
                : mime.includes('mp4') || mime.includes('mpeg-4') ? 'mp4'
                  : 'jpg';
      const safeName = (fileName ?? fileId).replace(/[^a-zA-Z0-9._()-]/g, '_').slice(0, 64);
      sourceUri = `${FileSystem.cacheDirectory}thumb_source_${fileId}_${safeName || 'media'}.${ext}`;
      await FileSystem.writeAsStringAsync(sourceUri, bytesToBase64(plaintext), {
        encoding: EncodingType.Base64,
      });

      const thumb = await generateThumbnailForMedia(sourceUri, mimeType);
      if (!thumb) return false;

      const { nonce, ciphertext } = await encryptChunk(fileKey, thumb);
      const wire = new Uint8Array(nonce.length + ciphertext.length);
      wire.set(nonce, 0);
      wire.set(ciphertext, nonce.length);

      await uploadThumbnail(fileId, wire);
      return true;
    } catch {
      return false;
    } finally {
      if (sourceUri) {
        await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
      }
    }
  })();

  repairInflight.set(fileId, repairPromise);
  try {
    return await repairPromise;
  } finally {
    repairInflight.delete(fileId);
  }
}

// In-memory cache: fileId → local file URI. Thumbnails are now stored in
// documentDirectory (persistent) via thumbnail-cache.ts so iOS doesn't
// evict them between app launches.
const thumbCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const repairInflight = new Map<string, Promise<boolean>>();

/** Persistent thumbnail directory (documentDirectory, survives cache purges). */
const PERSISTENT_THUMB_DIR = `${FileSystem.documentDirectory}beebeeb-thumbnails/`;

function thumbPath(fileId: string): string | null {
  if (!FileSystem.documentDirectory) return null;
  return `${PERSISTENT_THUMB_DIR}${fileId}.jpg`;
}

/** Legacy volatile cache path — checked during migration only. */
function legacyThumbPath(fileId: string): string | null {
  if (!FileSystem.cacheDirectory) return null;
  return `${FileSystem.cacheDirectory}thumb_${fileId}.jpg`;
}

async function cachedThumbnailUri(fileId: string): Promise<string | null> {
  // Fast path: in-memory map
  const memory = thumbCache.get(fileId);
  if (memory) return memory;

  // Check persistent storage (documentDirectory)
  const persistent = await getCachedThumbnail(fileId);
  if (persistent) {
    thumbCache.set(fileId, persistent);
    return persistent;
  }

  // Check legacy volatile cache (cacheDirectory) and migrate if found
  const legacy = legacyThumbPath(fileId);
  if (legacy) {
    try {
      const legacyInfo = await FileSystem.getInfoAsync(legacy);
      if (legacyInfo.exists && legacyInfo.size && legacyInfo.size > 0) {
        // Migrate to persistent storage
        await FileSystem.makeDirectoryAsync(PERSISTENT_THUMB_DIR, { intermediates: true });
        const destPath = thumbPath(fileId);
        if (destPath) {
          await FileSystem.copyAsync({ from: legacy, to: destPath });
          thumbCache.set(fileId, destPath);
          // Clean up old volatile copy
          await FileSystem.deleteAsync(legacy, { idempotent: true }).catch(() => {});
          return destPath;
        }
      }
    } catch {
      // Migration failed — not critical, will re-fetch from server
    }
  }

  return null;
}

export async function pruneThumbnailCache(maxItems = MAX_THUMB_CACHE_ITEMS): Promise<void> {
  // Prune persistent thumbnail directory (documentDirectory)
  try {
    await FileSystem.makeDirectoryAsync(PERSISTENT_THUMB_DIR, { intermediates: true });
    const names = await FileSystem.readDirectoryAsync(PERSISTENT_THUMB_DIR);
    const thumbs = names.filter((name) => /\.jpg$/.test(name));
    if (thumbs.length > maxItems) {
      const infos = await Promise.all(thumbs.map(async (name) => {
        const uri = `${PERSISTENT_THUMB_DIR}${name}`;
        const info = await FileSystem.getInfoAsync(uri);
        const mtime = info.exists && 'modificationTime' in info && typeof info.modificationTime === 'number'
          ? info.modificationTime
          : 0;
        return { name, uri, mtime };
      }));

      infos.sort((a, b) => a.mtime - b.mtime);
      const toDelete = infos.slice(0, Math.max(0, infos.length - maxItems));
      for (const item of toDelete) {
        await FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
        thumbCache.delete(item.name.replace(/\.jpg$/, ''));
      }
    }
  } catch {
    // Pruning is best-effort; failure must not affect the photo grid.
  }

  // Also clean up any remaining legacy thumbnails in cacheDirectory
  if (FileSystem.cacheDirectory) {
    try {
      const names = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
      const legacyThumbs = names.filter((name) => /^thumb_[^/]+\.jpg$/.test(name));
      for (const name of legacyThumbs) {
        const uri = `${FileSystem.cacheDirectory}${name}`;
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Download, decrypt, and cache a thumbnail for display.
 * Accepts the pre-derived per-file key from the crypto context.
 * Returns a local file URI suitable for <Image source={{ uri }} />,
 * or null if the thumbnail is unavailable or decryption fails.
 *
 * Thumbnails are stored in persistent documentDirectory so they survive
 * iOS cache purges and app restarts.
 */
export async function fetchDecryptedThumbnailUri(
  fileId: string,
  fileKey: Uint8Array,
): Promise<string | null> {
  const cached = await cachedThumbnailUri(fileId);
  if (cached) return cached;

  const pending = inflight.get(fileId);
  if (pending) return pending;

  const fetchPromise = (async () => {
    const token = await getToken();
    if (!token) return null;

    const res = await fetch(thumbnailUrl(fileId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;

    const encryptedBytes = new Uint8Array(await res.arrayBuffer());
    if (encryptedBytes.length < 4) return null;

    // Detect unencrypted legacy thumbnails (plain JPEG starts with FF D8 FF).
    // These were uploaded by old mobile code that didn't encrypt thumbnails.
    let plainBytes: Uint8Array;
    if (encryptedBytes[0] === 0xFF && encryptedBytes[1] === 0xD8 && encryptedBytes[2] === 0xFF) {
      thumbCache.delete(fileId);
      return null;
    } else {
      if (encryptedBytes.length < 13) return null;
      const nonce = encryptedBytes.slice(0, 12);
      const ciphertext = encryptedBytes.slice(12);
      plainBytes = await decryptChunk(fileKey, nonce, ciphertext);
    }

    // Write decrypted JPEG to persistent storage so it survives app restarts.
    const b64 = bytesToBase64(plainBytes);
    const persistedPath = await cacheThumbnailBase64(fileId, b64);
    thumbCache.set(fileId, persistedPath);
    return persistedPath;
  })();

  inflight.set(fileId, fetchPromise);
  try {
    return await fetchPromise;
  } catch {
    return null;
  } finally {
    inflight.delete(fileId);
  }
}

export async function prefetchDecryptedThumbnails(
  fileIds: string[],
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>,
): Promise<void> {
  const unique = Array.from(new Set(fileIds)).slice(0, MAX_THUMB_CACHE_ITEMS);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const fileId = unique[cursor++];
      if (!fileId || await cachedThumbnailUri(fileId)) continue;
      try {
        const fileKey = await getFileKeyBytes(fileId);
        await fetchDecryptedThumbnailUri(fileId, fileKey);
      } catch {
        // Prefetch is opportunistic; visible cells can retry on demand.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, unique.length) }, () => worker()));
}
