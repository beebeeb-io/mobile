/**
 * Native decryption wrapper for preview.
 *
 * Downloads encrypted chunks from the API, decrypts via the native crypto
 * module (AES-256-GCM in Rust via UniFFI), and writes the plaintext to a
 * temp file. Returns the local file path for native renderers to consume.
 *
 * Caches by fileId — if the decrypted temp file already exists and is
 * non-empty, returns immediately without re-downloading.
 *
 * When `decryptChunksToFile` becomes available in the native module (Task 1),
 * this can be swapped to pass encrypted chunks directly to Rust for file I/O.
 * Until then, it uses the existing per-chunk JS bridge decryption.
 */

import * as FileSystem from 'expo-file-system';
import { isNativeAvailable } from '../../modules/beebeeb-crypto';
import {
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from './encrypted-download';
import { getToken, getDownloadUrl, ApiError } from './api';

const PREVIEW_CACHE_DIR = `${FileSystem.cacheDirectory}preview/`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function responseHeaderInt(headers: Headers, key: string): number | null {
  const value = headers.get(key);
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function errorMessageFromResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText || `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Plain text error body.
  }
  return text;
}

async function ensureCacheDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(PREVIEW_CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(PREVIEW_CACHE_DIR, { intermediates: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Download encrypted file from API, decrypt via native crypto, write to temp
 * file. Returns the local file URI ready for native renderers.
 *
 * Caches by fileId + extension — if a non-empty temp file already exists for
 * this combination, returns immediately without re-downloading.
 *
 * @param fileId        Server file ID
 * @param fileKey       Per-file encryption key (32 bytes), derived from master key
 * @param extension     File extension (e.g. "pdf", "jpg") for the temp file
 * @param sizeBytes     Original plaintext file size in bytes (optional, from file metadata)
 * @param chunkCount    Number of chunks the file was split into (optional, from file metadata)
 */
export async function decryptToTempFile(
  fileId: string,
  fileKey: Uint8Array,
  extension: string,
  sizeBytes?: number | null,
  chunkCount?: number | null,
): Promise<string> {
  if (!isNativeAvailable) {
    throw new Error('Preview requires a dev client build with native crypto.');
  }

  await ensureCacheDir();

  const ext = extension.replace(/^\./, '');
  const outputPath = `${PREVIEW_CACHE_DIR}${fileId}.${ext}`;

  // Check cache — return immediately if a non-empty file exists
  const cached = await FileSystem.getInfoAsync(outputPath);
  if (cached.exists && cached.size && cached.size > 0) {
    return outputPath;
  }

  // Download the full encrypted blob
  const token = await getToken();
  if (!token) throw new Error('Not signed in');

  const res = await fetch(getDownloadUrl(fileId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessageFromResponse(res));
  }

  const encBytes = new Uint8Array(await res.arrayBuffer());

  // Resolve plaintext size
  const headerOriginalSize = responseHeaderInt(res.headers, 'X-Original-Size');
  const effectiveSize = headerOriginalSize ?? sizeBytes ?? encBytes.length - 28;
  if (effectiveSize <= 0) {
    throw new Error('Could not determine plaintext size for decryption.');
  }

  // Resolve chunk count
  const headerChunkCount = responseHeaderInt(res.headers, 'X-Chunk-Count');
  const headerChunkSize = responseHeaderInt(res.headers, 'X-Chunk-Size');
  const inferred = inferChunkCountFromEncryptedSize(encBytes.length, effectiveSize);
  const effectiveChunkCount = headerChunkCount ?? chunkCount ?? inferred ?? 1;
  const effectiveChunkSize =
    headerChunkSize && headerChunkSize > 0 ? headerChunkSize : undefined;

  // Decrypt all chunks via native crypto bridge
  const decrypted = await decryptEncryptedBytes(
    fileKey,
    encBytes,
    effectiveChunkCount,
    effectiveSize,
    effectiveChunkSize,
  );

  // Write plaintext to temp file
  await FileSystem.writeAsStringAsync(outputPath, uint8ArrayToBase64(decrypted), {
    encoding: FileSystem.EncodingType.Base64,
  });

  return outputPath;
}

/**
 * Decrypt a file and return its content as a UTF-8 string.
 * Suitable for small text/code files that will be rendered as text.
 */
export async function decryptToString(
  fileId: string,
  fileKey: Uint8Array,
  sizeBytes?: number | null,
  chunkCount?: number | null,
): Promise<string> {
  const path = await decryptToTempFile(fileId, fileKey, 'txt', sizeBytes, chunkCount);
  return FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/**
 * Clear all cached preview files. Call on sign-out or when freeing space.
 */
export async function clearPreviewCache(): Promise<void> {
  try {
    await FileSystem.deleteAsync(PREVIEW_CACHE_DIR, { idempotent: true });
  } catch {
    // Best-effort cleanup
  }
}
