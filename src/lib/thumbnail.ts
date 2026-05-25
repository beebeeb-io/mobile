/**
 * Thumbnail generation for all media uploads: images, videos, and RAW photos.
 *
 * Thumbnails are encrypted with the file's AES-256-GCM key before upload,
 * matching the web client's format: nonce(12) || ciphertext.
 *
 * Supported formats:
 * - JPEG, PNG, HEIC, WebP, etc.: expo-image-manipulator resizes to medium WebP
 * - DNG (RAW photos): native UIImage/CoreImage decodes the embedded preview
 * - MP4, MOV (videos): native AVAssetImageGenerator extracts a frame at ~1s
 *
 * Best-effort: a failed thumbnail must never block or rollback the
 * underlying upload. Callers should not await the result.
 */

import { uploadThumbnail, downloadFile, getApiUrl, getToken, thumbnailUrl } from './api';
import { rateLimitedFetch } from './rate-limited-fetch';

import {
  encryptChunk,
  decryptChunk,
  generateVideoThumbnail as nativeGenerateVideoThumbnail,
  generateDngThumbnail as nativeGenerateDngThumbnail,
  generateAndUploadPhotoLibraryThumbnailNative,
} from '../../modules/beebeeb-crypto';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { EncodingType } from 'expo-file-system';
import {
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from './encrypted-download';
import {
  cacheThumbnailBase64,
  enqueueThumbnailLoad,
  getCachedThumbnail,
} from './thumbnail-cache';
import {
  LEGACY_THUMB_CACHE_DIR_NAMES,
  MAX_THUMB_BYTES_BY_SIZE,
  THUMB_CACHE_DIR_NAME,
  THUMB_VARIANTS_BY_SIZE,
  THUMB_WIDTH,
  type ThumbnailVariant,
} from './thumbnail-policy';
import { getLocalIdentifier } from './local-identifier-map';

let ImageManipulator: typeof import('expo-image-manipulator') | null = null;
try { ImageManipulator = require('expo-image-manipulator'); } catch {}

// Task 0552: blurhash placeholder. We load the binding dynamically because the
// native module is only present after a fresh build — JS-only sims (or any
// tooling that imports this file without the prebuilt binary) must keep
// working. Encoding falls back to null when unavailable.
type BlurhashLike = {
  encode?: (uri: string, componentsX: number, componentsY: number) => Promise<string>;
};
let blurhashModule: BlurhashLike | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('react-native-blurhash');
  blurhashModule = (mod?.Blurhash as BlurhashLike) ?? (mod as BlurhashLike) ?? null;
} catch {
  blurhashModule = null;
}

/**
 * Best-effort blurhash encoding from a local file URI. Returns null if the
 * native binding isn't loaded or encoding throws. Used for the placeholder
 * gradient that renders before either PhotoKit or the encrypted thumbnail
 * resolves a tile.
 */
export async function encodeBlurhashFromUri(localUri: string): Promise<string | null> {
  if (!blurhashModule?.encode) return null;
  try {
    const hash = await blurhashModule.encode(localUri, 4, 3);
    if (!hash || hash.length === 0 || hash.length > 64) return null;
    return hash;
  } catch {
    return null;
  }
}

const MAX_THUMB_CACHE_ITEMS = 15000;
const THUMBNAIL_BACKOFF_BASE_MS = 4_000;
const THUMBNAIL_BACKOFF_MAX_MS = 30_000;
const THUMBNAIL_WARN_INTERVAL_MS = 10_000;
export const THUMBNAIL_REPAIR_RETRY_MS = 60_000;

const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';
const DNG_MIME = 'image/x-adobe-dng';
const THUMBNAIL_ENCRYPTION_OVERHEAD_BYTES = 28;
const MAX_ENCRYPTED_THUMB_BYTES_BY_SIZE: Record<ThumbnailVariant, number> = {
  small: 32 * 1024,
  medium: 128 * 1024,
  large: 192 * 1024,
};
let thumbnailBackoffUntil = 0;
let thumbnailServerFailureCount = 0;
let lastThumbnailWarnAt = 0;

export interface ThumbnailPrefetchStats {
  attempted: number;
  cached: number;
  loaded: number;
  failed: number;
  skipped: number;
}

function warnThumbnailOnce(message: string, details?: unknown): void {
  const now = Date.now();
  if (now - lastThumbnailWarnAt < THUMBNAIL_WARN_INTERVAL_MS) return;
  lastThumbnailWarnAt = now;
  if (details !== undefined) {
    console.warn(message, details);
  } else {
    console.warn(message);
  }
}

function thumbnailBackoffRemainingMs(): number {
  return Math.max(0, thumbnailBackoffUntil - Date.now());
}

function applyThumbnailBackoff(status: number, retryAfter: string | null): void {
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1000
    : null;
  thumbnailServerFailureCount += 1;
  const exponentialMs = Math.min(
    THUMBNAIL_BACKOFF_MAX_MS,
    THUMBNAIL_BACKOFF_BASE_MS * (2 ** Math.min(thumbnailServerFailureCount - 1, 3)),
  );
  const pauseMs = Math.min(THUMBNAIL_BACKOFF_MAX_MS, retryAfterMs ?? exponentialMs);
  thumbnailBackoffUntil = Math.max(thumbnailBackoffUntil, Date.now() + pauseMs);
  warnThumbnailOnce('[thumbnail] remote thumbnail fetch is backing off', {
    status,
    pauseMs,
    failureCount: thumbnailServerFailureCount,
  });
}

function clearThumbnailBackoff(): void {
  thumbnailServerFailureCount = 0;
  thumbnailBackoffUntil = 0;
}

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
 * Resize an image at `sourceUri` down to a medium WebP and
 * return its bytes. Returns null if the source can't be processed.
 */
export async function generateThumbnail(
  sourceUri: string,
  variant: ThumbnailVariant = 'medium',
): Promise<Uint8Array | null> {
  try {
    if (!ImageManipulator) return null;
    const maxUploadPlaintextBytes = MAX_ENCRYPTED_THUMB_BYTES_BY_SIZE[variant] - THUMBNAIL_ENCRYPTION_OVERHEAD_BYTES;
    let cappedFallback: Uint8Array | null = null;
    for (const option of THUMB_VARIANTS_BY_SIZE[variant]) {
      const result = await ImageManipulator.manipulateAsync(
        sourceUri,
        [{ resize: { width: option.width } }],
        { compress: option.quality, format: ImageManipulator.SaveFormat.WEBP, base64: true },
      );
      if (!result.base64) continue;
      const bytes = base64ToBytes(result.base64);
      if (bytes.byteLength <= maxUploadPlaintextBytes) {
        cappedFallback = bytes;
      }
      if (bytes.byteLength <= MAX_THUMB_BYTES_BY_SIZE[variant]) return bytes;
    }
    return cappedFallback;
  } catch {
    return null;
  }
}

/**
 * Generate a thumbnail for a DNG (RAW) photo using the native CoreImage
 * decoder. Returns bytes of a WebP thumbnail, or null on failure.
 */
async function generateDngThumbnailBytes(sourceUri: string, maxSize = THUMB_WIDTH): Promise<Uint8Array | null> {
  try {
    const thumbPath = await nativeGenerateDngThumbnail(sourceUri, maxSize);
    const b64 = await FileSystem.readAsStringAsync(thumbPath, { encoding: EncodingType.Base64 });
    await FileSystem.deleteAsync(thumbPath, { idempotent: true }).catch(() => {});
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

/**
 * Generate a thumbnail for a video file (MP4/MOV) using the native
 * AVAssetImageGenerator. Returns bytes of a WebP thumbnail, or null on failure.
 */
async function generateVideoThumbnailBytes(sourceUri: string, maxSize = THUMB_WIDTH): Promise<Uint8Array | null> {
  try {
    const thumbPath = await nativeGenerateVideoThumbnail(sourceUri, maxSize);
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
  variant: ThumbnailVariant = 'medium',
): Promise<Uint8Array | null> {
  const resolvedUri = await resolveLocalMediaUri(sourceUri);
  const maxSize = THUMB_VARIANTS_BY_SIZE[variant][0]?.width ?? THUMB_WIDTH;
  if (isDngMime(mimeType)) {
    return generateDngThumbnailBytes(resolvedUri, maxSize);
  }
  if (isVideoMime(mimeType)) {
    return generateVideoThumbnailBytes(resolvedUri, maxSize);
  }
  return generateThumbnail(resolvedUri, variant);
}

async function resolveLocalMediaUri(sourceUri: string): Promise<string> {
  if (!sourceUri.startsWith('ph://')) return sourceUri;
  try {
    const assetId = sourceUri.slice('ph://'.length);
    const assetInfo = await MediaLibrary.getAssetInfoAsync(assetId, {
      shouldDownloadFromNetwork: true,
    });
    return assetInfo.localUri ?? assetInfo.uri ?? sourceUri;
  } catch {
    return sourceUri;
  }
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
  variant: ThumbnailVariant = 'medium',
): Promise<boolean> {
  if (!isThumbnailable(mimeType)) return false;
  try {
    const thumb = await generateThumbnailForMedia(sourceUri, mimeType, variant);
    if (!thumb) return false;

    // Task 0552: encode a blurhash from the same source URI for the medium
    // variant. Best-effort — null when the native binding isn't loaded.
    // We intentionally do NOT block thumbnail upload on this; if encoding
    // fails the placeholder gradient simply doesn't appear.
    let blurhash: string | null = null;
    if (variant === 'medium' && !isVideoMime(mimeType)) {
      blurhash = await encodeBlurhashFromUri(sourceUri).catch(() => null);
    }

    // Cache the plaintext thumbnail in persistent storage for instant display
    if (variant === 'medium') {
      const b64 = bytesToBase64(thumb);
      try {
        const persistedPath = await cacheThumbnailBase64(fileId, b64, variant);
        thumbCache.set(fileId, persistedPath);
      } catch {
        // Persist failed — still upload the thumbnail to server
      }
    }

    const fileKey = await getFileKeyBytes(fileId);
    const { nonce, ciphertext } = await encryptChunk(fileKey, thumb);

    // Wire format: nonce(12) || ciphertext — matches the web client.
    const wire = new Uint8Array(nonce.length + ciphertext.length);
    wire.set(nonce, 0);
    wire.set(ciphertext, nonce.length);
    if (wire.byteLength > MAX_ENCRYPTED_THUMB_BYTES_BY_SIZE[variant]) {
      warnThumbnailOnce('[thumbnail] generated thumbnail exceeded upload limit', {
        fileId,
        variant,
        bytes: wire.byteLength,
        limit: MAX_ENCRYPTED_THUMB_BYTES_BY_SIZE[variant],
      });
      return false;
    }

    await uploadThumbnail(fileId, wire, variant, blurhash);
    return true;
  } catch {
    // Best-effort — swallow.
    return false;
  }
}

/**
 * Repair a missing medium thumbnail from a local iOS Photos asset.
 *
 * The thumbnail bytes, file-key derivation, encryption and upload all stay in
 * native code; JS only passes the opaque master-key handle and progress state.
 */
export async function generateAndUploadPhotoLibraryThumbnail(
  fileId: string,
  localIdentifier: string,
  mimeType: string | null | undefined,
  getMasterKeyHandleId: () => number,
  variant: ThumbnailVariant = 'medium',
): Promise<boolean> {
  if (!isThumbnailable(mimeType)) return false;
  try {
    const token = await getToken();
    if (!token) return false;
    return await generateAndUploadPhotoLibraryThumbnailNative(
      getMasterKeyHandleId(),
      getApiUrl(),
      token,
      fileId,
      localIdentifier,
      mimeType,
      THUMB_VARIANTS_BY_SIZE[variant][0]?.width ?? THUMB_WIDTH,
      variant,
    );
  } catch {
    return false;
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
    } catch (err) {
      warnThumbnailOnce('[thumbnail] visible thumbnail repair failed', {
        fileId,
        error: err instanceof Error ? err.message : String(err),
      });
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

/**
 * Drop the in-memory thumbnail-URI cache entry for `fileId`. Used by the
 * thumbnail repair worker and the local-identifier-map refresh path: after
 * either pipeline replaces a thumbnail on disk, the next render must
 * re-stat instead of returning the stale path from `thumbCache`. The
 * persistent disk cache is invalidated separately via
 * `invalidateCachedThumbnail` in `thumbnail-cache.ts`.
 */
export function invalidateInMemoryThumbCache(fileId: string): void {
  if (!fileId) return;
  thumbCache.delete(fileId);
}

/** Persistent thumbnail directory (documentDirectory, survives cache purges). */
const PERSISTENT_THUMB_DIR = `${FileSystem.documentDirectory}${THUMB_CACHE_DIR_NAME}/`;

function thumbPath(fileId: string): string | null {
  if (!FileSystem.documentDirectory) return null;
  return `${PERSISTENT_THUMB_DIR}${fileId}.webp`;
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
    const thumbs = names.filter((name) => /\.(webp|jpg)$/.test(name));
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
        thumbCache.delete(item.name.replace(/\.(webp|jpg)$/, ''));
      }
    }
  } catch {
    // Pruning is best-effort; failure must not affect the photo grid.
  }

  for (const legacyDirName of LEGACY_THUMB_CACHE_DIR_NAMES) {
    const legacyDir = `${FileSystem.documentDirectory}${legacyDirName}/`;
    if (legacyDir === PERSISTENT_THUMB_DIR) continue;
    await FileSystem.deleteAsync(legacyDir, { idempotent: true }).catch(() => {});
  }

  // Also clean up any remaining legacy thumbnails in cacheDirectory
  if (FileSystem.cacheDirectory) {
    try {
      const names = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
      const legacyThumbs = names.filter((name) => /^thumb_[^/]+\.(webp|jpg)$/.test(name));
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
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  // Central PhotoKit guard: caller-side checks can race the async map hydrate.
  // Once a file resolves to a local PHAsset, never surface or write the
  // encrypted server thumbnail from this path.
  if (getLocalIdentifier(fileId)) return null;

  const cached = await cachedThumbnailUri(fileId);
  if (cached) return cached;

  const pending = inflight.get(fileId);
  if (pending) return pending;

  const fetchPromise = (async () => {
    const backoffRemaining = thumbnailBackoffRemainingMs();
    if (backoffRemaining > 0) {
      warnThumbnailOnce('[thumbnail] remote thumbnail fetch skipped during backoff', {
        backoffRemainingMs: backoffRemaining,
      });
      return null;
    }

    const token = await getToken();
    if (!token) return null;

    const res = await rateLimitedFetch(thumbnailUrl(fileId), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        applyThumbnailBackoff(res.status, res.headers.get('Retry-After'));
      } else if (res.status !== 404) {
        warnThumbnailOnce('[thumbnail] remote thumbnail fetch failed', {
          status: res.status,
          fileId,
        });
      }
      return null;
    }
    clearThumbnailBackoff();

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

    // Write decrypted thumbnail to persistent storage so it survives app restarts.
    if (getLocalIdentifier(fileId)) return null;
    const b64 = bytesToBase64(plainBytes);
    const persistedPath = await cacheThumbnailBase64(fileId, b64);
    thumbCache.set(fileId, persistedPath);
    return persistedPath;
  })();

  inflight.set(fileId, fetchPromise);
  try {
    return await fetchPromise;
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return null;
    }
    warnThumbnailOnce('[thumbnail] remote thumbnail fetch threw', {
      fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    inflight.delete(fileId);
  }
}

export interface PrefetchOptions {
  signal?: AbortSignal;
  /** Called as soon as a thumbnail URI is known (cache hit or freshly fetched). */
  onLoaded?: (fileId: string, uri: string) => void;
}

/**
 * Ensure thumbnails for the given file IDs are cached locally.
 *
 * Each ID is routed through the bounded queue in `thumbnail-cache.ts` so
 * concurrency is shared with on-screen `<ThumbnailImage>` loads. Cache hits
 * resolve immediately without entering the queue. If `signal` aborts, pending
 * queue entries are dropped and in-flight fetches are cancelled.
 */
export async function prefetchDecryptedThumbnails(
  fileIds: string[],
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>,
  options?: PrefetchOptions,
): Promise<ThumbnailPrefetchStats> {
  const unique = Array.from(new Set(fileIds)).slice(0, MAX_THUMB_CACHE_ITEMS);
  const stats: ThumbnailPrefetchStats = {
    attempted: 0,
    cached: 0,
    loaded: 0,
    failed: 0,
    skipped: 0,
  };
  const { signal, onLoaded } = options ?? {};

  await Promise.all(unique.map(async (fileId) => {
    if (signal?.aborted) {
      stats.skipped += 1;
      return;
    }
    if (!fileId) {
      stats.skipped += 1;
      return;
    }
    // Task 0552 follow-up: if this file is PhotoKit-backed (camera roll), do
    // NOT fetch the encrypted thumbnail here. Otherwise we race with the
    // tile-level PhotoKit short-circuit: PhotoKit caches a high-quality
    // render first; this prefetch then overwrites the same cache file with
    // the lower-quality encrypted blob, so the next render flips to the
    // worse version. Skip — the tile will render via PhotoKit on demand.
    if (getLocalIdentifier(fileId)) {
      stats.skipped += 1;
      return;
    }
    const cached = await cachedThumbnailUri(fileId);
    if (cached) {
      stats.cached += 1;
      onLoaded?.(fileId, cached);
      return;
    }
    stats.attempted += 1;
    try {
      const uri = await enqueueThumbnailLoad(fileId, async (fId, innerSignal) => {
        const fileKey = await getFileKeyBytes(fId);
        return fetchDecryptedThumbnailUri(fId, fileKey, innerSignal);
      }, signal);
      if (uri) {
        stats.loaded += 1;
        onLoaded?.(fileId, uri);
      } else {
        stats.failed += 1;
      }
    } catch {
      stats.failed += 1;
      // Prefetch is opportunistic; visible cells can retry on demand.
    }
  }));

  return stats;
}
