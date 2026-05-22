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
import {
  downloadAndDecryptFileNative,
  isNativeAvailable,
  type PreviewLoadProgressEvent,
} from '../../modules/beebeeb-crypto';
import {
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from './encrypted-download';
import {
  ApiError,
  getApiUrl,
  getDownloadUrl,
  getToken,
} from './api';
import { rateLimitedFetch } from './rate-limited-fetch';

const PREVIEW_CACHE_DIR = `${FileSystem.cacheDirectory}preview/`;
const MAX_PREVIEW_CACHE_ITEMS = 24;
const MAX_PREVIEW_CACHE_BYTES = 512 * 1024 * 1024;
const PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface PreviewDecryptOptions {
  onProgress?: (event: PreviewLoadProgressEvent) => void;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abortError(): Error {
  const error = new Error('Preview load cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

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

async function prunePreviewCache(keepPath?: string): Promise<void> {
  try {
    const names = await FileSystem.readDirectoryAsync(PREVIEW_CACHE_DIR);
    const entries = await Promise.all(
      names.map(async (name) => {
        const uri = `${PREVIEW_CACHE_DIR}${name}`;
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) return null;
        return {
          uri,
          sizeBytes: info.size ?? 0,
          modifiedAt: (info.modificationTime ?? 0) * 1000,
        };
      }),
    );

    const now = Date.now();
    let totalBytes = 0;
    let kept = 0;
    const sorted = entries
      .filter((entry): entry is { uri: string; sizeBytes: number; modifiedAt: number } => entry != null)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    await Promise.all(
      sorted.map(async (entry) => {
        if (entry.uri === keepPath) {
          totalBytes += entry.sizeBytes;
          kept += 1;
          return;
        }

        const expired = now - entry.modifiedAt >= PREVIEW_CACHE_TTL_MS;
        totalBytes += entry.sizeBytes;
        kept += 1;

        if (expired || kept > MAX_PREVIEW_CACHE_ITEMS || totalBytes > MAX_PREVIEW_CACHE_BYTES) {
          await FileSystem.deleteAsync(entry.uri, { idempotent: true }).catch(() => {});
        }
      }),
    );
  } catch {
    // Best-effort cleanup only.
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
 * @param masterKeyHandleId Opaque native master-key handle for native download/decrypt
 */
export async function decryptToTempFile(
  fileId: string,
  fileKey: Uint8Array | (() => Promise<Uint8Array>) | null,
  extension: string,
  sizeBytes?: number | null,
  chunkCount?: number | null,
  masterKeyHandleId?: number | null,
  options: PreviewDecryptOptions = {},
): Promise<string> {
  if (!isNativeAvailable) {
    throw new Error('Preview requires a dev client build with native crypto.');
  }

  throwIfAborted(options.signal);
  await ensureCacheDir();
  throwIfAborted(options.signal);

  const ext = extension.replace(/^\./, '');
  const outputPath = `${PREVIEW_CACHE_DIR}${fileId}.${ext}`;

  // Check cache — return immediately if a non-empty file exists
  const cached = await FileSystem.getInfoAsync(outputPath);
  if (cached.exists && cached.size && cached.size > 0) {
    throwIfAborted(options.signal);
    options.onProgress?.({ requestId: '', fileId, stage: 'complete' });
    return outputPath;
  }

  const token = await getToken();
  if (!token) throw new Error('Not signed in');
  throwIfAborted(options.signal);

  if (masterKeyHandleId != null) {
    try {
      const result = await downloadAndDecryptFileNative(
        masterKeyHandleId,
        getApiUrl(),
        token,
        fileId,
        outputPath,
        { onProgress: options.onProgress, signal: options.signal },
      );
      if (options.signal?.aborted) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw abortError();
      }
      await prunePreviewCache(outputPath);
      return result.outputUri || outputPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('downloadAndDecryptFileNative is not available')) {
        throw error;
      }
    }
  }

  if (!fileKey) {
    throw new Error('Native preview decrypt requires a master key handle.');
  }
  const resolvedFileKey = typeof fileKey === 'function' ? await fileKey() : fileKey;
  throwIfAborted(options.signal);

  // Fallback for older native builds: download the full encrypted blob through
  // JS, decrypt through the chunk bridge, and write base64. New iOS builds
  // should use the native handle path above.
  const res = await rateLimitedFetch(getDownloadUrl(fileId), {
    headers: { Authorization: `Bearer ${token}` },
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessageFromResponse(res));
  }

  const contentLength = responseHeaderInt(res.headers, 'Content-Length');
  options.onProgress?.({
    requestId: '',
    fileId,
    stage: 'downloading',
    bytesDownloaded: contentLength ?? 0,
    bytesTotal: contentLength ?? 0,
  });
  const encBytes = new Uint8Array(await res.arrayBuffer());
  throwIfAborted(options.signal);

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
    resolvedFileKey,
    encBytes,
    effectiveChunkCount,
    effectiveSize,
    effectiveChunkSize,
    (chunksCompleted, chunksTotal) => {
      options.onProgress?.({
        requestId: '',
        fileId,
        stage: 'decrypting',
        chunksCompleted,
        chunksTotal,
      });
    },
  );
  throwIfAborted(options.signal);

  // Write plaintext to temp file
  await FileSystem.writeAsStringAsync(outputPath, uint8ArrayToBase64(decrypted), {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (options.signal?.aborted) {
    await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
    throw abortError();
  }
  await prunePreviewCache(outputPath);

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
