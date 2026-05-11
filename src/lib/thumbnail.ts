/**
 * Thumbnail generation for image uploads.
 *
 * Thumbnails are encrypted with the file's AES-256-GCM key before upload,
 * matching the web client's format: nonce(12) || ciphertext.
 *
 * Best-effort: a failed thumbnail must never block or rollback the
 * underlying upload. Callers should not await the result.
 */

import { uploadThumbnail, getToken, thumbnailUrl } from './api';
import { encryptChunk, decryptChunk } from '../../modules/beebeeb-crypto';
import * as FileSystem from 'expo-file-system';
import { EncodingType } from 'expo-file-system';

let ImageManipulator: typeof import('expo-image-manipulator') | null = null;
try { ImageManipulator = require('expo-image-manipulator'); } catch {}

const THUMB_WIDTH = 256;
const THUMB_QUALITY = 0.7;
const MAX_THUMB_CACHE_ITEMS = 200;
const PREFETCH_CONCURRENCY = 4;

const IMAGE_MIME_PREFIX = 'image/';

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
 * Generate a thumbnail, encrypt it with the file key, and upload it.
 * Fire-and-forget: never throws, never blocks the caller's success flow.
 */
export async function generateAndUploadThumbnail(
  fileId: string,
  sourceUri: string,
  mimeType: string | null | undefined,
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>,
): Promise<void> {
  if (!isImageMime(mimeType)) return;
  try {
    const thumb = await generateThumbnail(sourceUri);
    if (!thumb) return;

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

// In-memory cache: fileId → local temp file URI. Disk cache is bounded by
// pruneThumbnailCache(); callers trigger it after list refreshes.
const thumbCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function thumbPath(fileId: string): string | null {
  if (!FileSystem.cacheDirectory) return null;
  return `${FileSystem.cacheDirectory}thumb_${fileId}.jpg`;
}

async function cachedThumbnailUri(fileId: string): Promise<string | null> {
  const memory = thumbCache.get(fileId);
  if (memory) return memory;
  const dest = thumbPath(fileId);
  if (!dest) return null;
  const cached = await FileSystem.getInfoAsync(dest);
  if (cached.exists && cached.size && cached.size > 0) {
    thumbCache.set(fileId, dest);
    return dest;
  }
  return null;
}

export async function pruneThumbnailCache(maxItems = MAX_THUMB_CACHE_ITEMS): Promise<void> {
  if (!FileSystem.cacheDirectory) return;
  try {
    const names = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
    const thumbs = names.filter((name) => /^thumb_[^/]+\.jpg$/.test(name));
    if (thumbs.length <= maxItems) return;

    const infos = await Promise.all(thumbs.map(async (name) => {
      const uri = `${FileSystem.cacheDirectory}${name}`;
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
      thumbCache.delete(item.name.replace(/^thumb_/, '').replace(/\.jpg$/, ''));
    }
  } catch {
    // Cache pruning is best-effort; failure must not affect the photo grid.
  }
}

/**
 * Download, decrypt, and cache a thumbnail for display.
 * Accepts the pre-derived per-file key from the crypto context.
 * Returns a local file URI suitable for <Image source={{ uri }} />,
 * or null if the thumbnail is unavailable or decryption fails.
 */
export async function fetchDecryptedThumbnailUri(
  fileId: string,
  fileKey: Uint8Array,
): Promise<string | null> {
  const cached = await cachedThumbnailUri(fileId);
  if (cached) return cached;

  const dest = thumbPath(fileId);
  if (!dest) return null;
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
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
      thumbCache.delete(fileId);
      return null;
    } else {
      if (encryptedBytes.length < 13) return null;
      const nonce = encryptedBytes.slice(0, 12);
      const ciphertext = encryptedBytes.slice(12);
      plainBytes = await decryptChunk(fileKey, nonce, ciphertext);
    }

    // Write decrypted JPEG to local cache so <Image> can read it.
    const b64 = bytesToBase64(plainBytes);
    await FileSystem.writeAsStringAsync(dest, b64, { encoding: EncodingType.Base64 });

    thumbCache.set(fileId, dest);
    return dest;
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
