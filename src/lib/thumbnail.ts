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

const IMAGE_MIME_PREFIX = 'image/';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith(IMAGE_MIME_PREFIX);
}

/**
 * Resize an image at `sourceUri` down to a 256-px-wide JPEG and
 * return its blob. Returns null if the source can't be processed.
 */
export async function generateThumbnail(sourceUri: string): Promise<Blob | null> {
  try {
    if (!ImageManipulator) return null;
    const result = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: THUMB_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    const res = await fetch(result.uri);
    return await res.blob();
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

    const plainBytes = new Uint8Array(await thumb.arrayBuffer());
    const fileKey = await getFileKeyBytes(fileId);
    const { nonce, ciphertext } = await encryptChunk(fileKey, plainBytes);

    // Wire format: nonce(12) || ciphertext — matches the web client.
    const wire = new Uint8Array(nonce.length + ciphertext.length);
    wire.set(nonce, 0);
    wire.set(ciphertext, nonce.length);

    await uploadThumbnail(fileId, wire);
  } catch {
    // Best-effort — swallow.
  }
}

// In-memory cache: fileId → local temp file URI
const thumbCache = new Map<string, string>();

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
  if (thumbCache.has(fileId)) return thumbCache.get(fileId)!;
  const dest = `${FileSystem.cacheDirectory}thumb_${fileId}.jpg`;
  const cached = await FileSystem.getInfoAsync(dest);
  if (cached.exists && cached.size && cached.size > 0) {
    thumbCache.set(fileId, dest);
    return dest;
  }

  try {
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
      plainBytes = encryptedBytes;
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
  } catch {
    return null;
  }
}
