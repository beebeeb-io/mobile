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

import * as FileSystem from 'expo-file-system/legacy';
import {
  decryptLocalFileNative,
  downloadAndDecryptFileNative,
  isNativeAvailable,
  type PreviewLoadProgressEvent,
} from '../../modules/beebeeb-crypto';
import {
  CHUNK_SIZE,
  decryptEncryptedBytes,
  inferChunkCountFromEncryptedSize,
} from './encrypted-download';
import {
  decryptChunksToFile,
  DecryptToFileUnavailableError,
  isDecryptToFileReady,
} from './decrypt-to-file';
import {
  ApiError,
  getApiUrl,
  getDownloadUrl,
  getToken,
} from './api';
import { rateLimitedFetch } from './rate-limited-fetch';
import { recordRuntimeTrace } from './runtime-trace';
import { createInFlightShare } from './inflight-share';
import { PLAINTEXT_DRAIN_TIMEOUT_MS, plaintextGate, withPlaintextLease } from './plaintext-gate';
import { offlineManager, offlineFilePath } from './offline-manager';
import NetInfo from '@react-native-community/netinfo';

const PREVIEW_CACHE_DIR = `${FileSystem.cacheDirectory}preview/`;
const MAX_PREVIEW_CACHE_ITEMS = 24;
const MAX_PREVIEW_CACHE_BYTES = 512 * 1024 * 1024;
const PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface PreviewDecryptOptions {
  onProgress?: (event: PreviewLoadProgressEvent) => void;
  onOfflineFallback?: (event: { fileId: string; reason: string }) => void;
  signal?: AbortSignal;
  /**
   * Task 1593 — where the returned plaintext came from:
   * - `cache`     an existing decrypted copy was reused;
   * - `joined`    another caller was already decrypting this exact file +
   *               extension and this call shared its result;
   * - `decrypted` THIS call downloaded + decrypted it (the caller that owns
   *               the fresh copy — "Prove it" deletes it after its 512-byte
   *               read in that case only).
   */
  onSource?: (source: PreviewDecryptSource) => void;
}

export type PreviewDecryptSource = 'cache' | 'joined' | 'decrypted';

/** `Library/Caches/preview/<fileId>.<ext>` — the preview cache key. */
export function previewCachePath(fileId: string, extension: string): string {
  return `${PREVIEW_CACHE_DIR}${fileId}.${extension.replace(/^\./, '')}`;
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

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function responseHeaderInt(headers: Headers, key: string): number | null {
  const value = headers.get(key);
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function errorTraceFields(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return {
      name: error.name,
      status: error.status,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }
  return { message: String(error) };
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
          previewLeases.delete(entry.uri);
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
  throwIfAborted(options.signal);
  const outputPath = previewCachePath(fileId, extension);
  // Task 1593 — one in-flight decrypt per output path. See inflight-share.ts:
  // a second caller joins the first instead of racing it into the same file
  // (or returning its half-written file as a "cache hit"), and the shared job
  // is aborted only once EVERY caller's signal has aborted.
  let listeners = sharedListeners.get(outputPath);
  if (!listeners) {
    listeners = new Set();
    sharedListeners.set(outputPath, listeners);
  }
  const listener: SharedListener = {
    onProgress: options.onProgress,
    onOfflineFallback: options.onOfflineFallback,
  };
  listeners.add(listener);
  // Task 1593 round 2 (P2-F) — one lease per caller that asked for this path.
  // `releasePreviewCopy` only deletes the file when no other caller holds one.
  previewLeases.set(outputPath, (previewLeases.get(outputPath) ?? 0) + 1);
  let leased = true;
  try {
    const { value, joined } = await previewDecrypts.run(
      outputPath,
      async (signal) => {
        let cacheHit = false;
        const path = await decryptToTempFileUnshared(
          fileId,
          fileKey,
          extension,
          sizeBytes,
          chunkCount,
          masterKeyHandleId,
          {
            signal,
            onProgress: (event) => {
              sharedListeners.get(outputPath)?.forEach((l) => l.onProgress?.(event));
            },
            onOfflineFallback: (event) => {
              sharedListeners.get(outputPath)?.forEach((l) => l.onOfflineFallback?.(event));
            },
            onSource: (source) => {
              cacheHit = source === 'cache';
            },
          },
        );
        // Task 1593 round 2 (P2-C) — every caller walked away (or the
        // sign-out purge aborted the job) while the decrypt was finishing:
        // the late `signal.aborted` checks inside the unshared path have a
        // window after them (prunePreviewCache), and nobody will ever receive
        // this path to delete it. A file this job decrypted is removed here;
        // a cache hit is the preview's copy and stays.
        if (signal.aborted) {
          if (!cacheHit) {
            await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
          }
          throw abortError();
        }
        return { path, cacheHit };
      },
      options.signal,
    );
    options.onSource?.(joined ? 'joined' : value.cacheHit ? 'cache' : 'decrypted');
    leased = false;
    return value.path;
  } catch (error) {
    if (leased) dropLease(outputPath);
    throw error;
  } finally {
    listeners.delete(listener);
    if (listeners.size === 0 && sharedListeners.get(outputPath) === listeners) {
      sharedListeners.delete(outputPath);
    }
  }
}

interface SharedListener {
  onProgress?: PreviewDecryptOptions['onProgress'];
  onOfflineFallback?: PreviewDecryptOptions['onOfflineFallback'];
}

// Task 1593 round 3 (#141 Codex P1) — every preview decrypt holds a lease from
// the plaintext gate: a sign-out purge aborts them all, waits for them to
// settle, and while it runs (and until the next session) new ones are REFUSED
// rather than queued behind the aborted job.
const previewDecrypts = createInFlightShare<{ path: string; cacheHit: boolean }>({
  gate: plaintextGate,
  label: 'preview decrypt',
});
/** Per cache path: callers that asked for it since the file was last removed. */
const previewLeases = new Map<string, number>();

function dropLease(path: string): number {
  const left = (previewLeases.get(path) ?? 0) - 1;
  if (left > 0) previewLeases.set(path, left);
  else previewLeases.delete(path);
  return Math.max(left, 0);
}

/**
 * Task 1593 round 2 (P2-F) — give back ONE caller's lease on the preview-cache
 * copy of (fileId, extension) and delete the file only if no other caller
 * holds one. "Prove it" used to delete a copy it had decrypted itself even
 * when the preview had joined that decrypt (or cache-hit it right after) and
 * was rendering from it. Returns true when the file was deleted.
 */
export async function releasePreviewCopy(fileId: string, extension: string): Promise<boolean> {
  const path = previewCachePath(fileId, extension);
  if (dropLease(path) > 0) return false;
  await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
  return true;
}
const sharedListeners = new Map<string, Set<SharedListener>>();

async function decryptToTempFileUnshared(
  fileId: string,
  fileKey: Uint8Array | (() => Promise<Uint8Array>) | null,
  extension: string,
  sizeBytes: number | null | undefined,
  chunkCount: number | null | undefined,
  masterKeyHandleId: number | null | undefined,
  options: PreviewDecryptOptions,
): Promise<string> {
  if (!isNativeAvailable) {
    recordRuntimeTrace('preview.decrypt.native_unavailable', { fileId });
    throw new Error('Preview requires a dev client build with native crypto.');
  }

  const startedAt = Date.now();
  throwIfAborted(options.signal);
  await ensureCacheDir();
  throwIfAborted(options.signal);

  const ext = extension.replace(/^\./, '');
  const outputPath = `${PREVIEW_CACHE_DIR}${fileId}.${ext}`;
  recordRuntimeTrace('preview.decrypt.start', {
    fileId,
    extension: ext,
    sizeBytes: sizeBytes ?? null,
    chunkCount: chunkCount ?? null,
    hasMasterKeyHandle: masterKeyHandleId != null,
    hasFileKeyProvider: fileKey != null,
  });

  // Check cache — return immediately if a non-empty file exists
  const cached = await FileSystem.getInfoAsync(outputPath);
  if (cached.exists && cached.size && cached.size > 0) {
    throwIfAborted(options.signal);
    recordRuntimeTrace('preview.decrypt.cache_hit', {
      fileId,
      extension: ext,
      cachedSize: cached.size,
      elapsedMs: Date.now() - startedAt,
    });
    options.onSource?.('cache');
    options.onProgress?.({ requestId: '', fileId, stage: 'complete' });
    return outputPath;
  }
  recordRuntimeTrace('preview.decrypt.cache_miss', {
    fileId,
    extension: ext,
    cachedExists: cached.exists,
    cachedSize: cached.exists ? cached.size ?? 0 : 0,
  });

  // 0803 — offline-first. If this file has a local encrypted copy (pinned via
  // "available offline"), decrypt it on-device with NO network — works in
  // airplane mode, across every preview type (PDF, image, video, text, …) since
  // they all funnel through here. Falls through to the network path only if the
  // local copy is unreadable.
  await offlineManager.init();
  if (offlineManager.isAvailable(fileId)) {
    try {
      // Prefer the chunk metadata captured at download time (exact upload chunk
      // size); fall back to the caller's file-metadata values.
      const meta = offlineManager.getMeta(fileId);
      return await decryptLocalFileToTempFile(
        fileId,
        fileKey,
        ext,
        offlineFilePath(fileId),
        meta?.sizeBytes ?? sizeBytes,
        meta?.chunkCount ?? chunkCount,
        meta?.chunkSize,
        options,
      );
    } catch (err) {
      if (options.signal?.aborted) throw err;
      const traceFields = errorTraceFields(err);
      const reason = typeof traceFields.message === 'string' && traceFields.message.length > 0
        ? traceFields.message
        : 'Offline copy could not be decrypted.';
      recordRuntimeTrace('preview.decrypt.offline_fallback', { fileId, ...traceFields });
      options.onOfflineFallback?.({ fileId, reason });
    }
  } else {
    // Not pinned for offline — if there's also no connectivity, surface a clear
    // "not available offline" state instead of a confusing server timeout.
    const net = await NetInfo.fetch().catch(() => null);
    if (net && net.isConnected === false) {
      throw new Error('Not available offline. Connect to the internet, or mark this file available offline first.');
    }
  }

  const token = await getToken();
  if (!token) {
    recordRuntimeTrace('preview.decrypt.no_token', { fileId });
    throw new Error('Not signed in');
  }
  throwIfAborted(options.signal);

  // Task 1683h: null handleId no longer routes around the native path — the
  // module resolves the master key itself (awaiting its internal key-loaded
  // latch, completed by the keychain auto-unlock). This is the direct fix for
  // the relaunch-tap race (a preview tapped ~1.5 s after launch used to fall
  // to the JS-fetch fallback with a null handle and buffer the whole body in
  // the Java heap). The 1683g fail-closed gate below remains only for legacy
  // native builds, where a null handle fails argument conversion → treated
  // as not-available → gated fallback.
  if (isNativeAvailable) {
    try {
      recordRuntimeTrace('preview.decrypt.native.request', {
        fileId,
        extension: ext,
        handleResolvedNatively: masterKeyHandleId == null,
      });
      const result = await downloadAndDecryptFileNative(
        masterKeyHandleId ?? null,
        getApiUrl(),
        token,
        fileId,
        outputPath,
        { onProgress: options.onProgress, signal: options.signal },
      );
      if (options.signal?.aborted) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        recordRuntimeTrace('preview.decrypt.native.aborted_after_result', { fileId });
        throw abortError();
      }
      await prunePreviewCache(outputPath);
      recordRuntimeTrace('preview.decrypt.native.success', {
        fileId,
        extension: ext,
        plaintextSize: result.plaintextSize,
        chunksDecrypted: result.chunksDecrypted,
        elapsedMs: Date.now() - startedAt,
      });
      return result.outputUri || outputPath;
    } catch (error) {
      // Task 1593 — never leave a partial plaintext behind: a cancelled or
      // failed decrypt may have written part of outputPath, which the next
      // open would otherwise serve as a (corrupt) cache hit. Safe: the
      // in-flight share guarantees no other decrypt owns this path now.
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('downloadAndDecryptFileNative is not available')) {
        recordRuntimeTrace('preview.decrypt.native.failed', {
          fileId,
          extension: ext,
          elapsedMs: Date.now() - startedAt,
          ...errorTraceFields(error),
        });
        throw error;
      }
      recordRuntimeTrace('preview.decrypt.native.not_available_fallback', { fileId });
    }
  }

  if (!fileKey) {
    recordRuntimeTrace('preview.decrypt.no_key_material', { fileId });
    throw new Error('Native preview decrypt requires a master key handle.');
  }
  recordRuntimeTrace('preview.decrypt.file_key.request', { fileId });
  const resolvedFileKey = typeof fileKey === 'function' ? await fileKey() : fileKey;
  recordRuntimeTrace('preview.decrypt.file_key.ready', {
    fileId,
    keyLength: resolvedFileKey.length,
  });
  throwIfAborted(options.signal);

  // Fallback for older native builds: download the full encrypted blob through
  // JS, decrypt through the chunk bridge, and write base64. New iOS builds
  // should use the native handle path above.
  //
  // Task 1683g — this path buffers the WHOLE body in the Java heap (expo fetch
  // → arrayBuffer): Guus's 800 MB video OOMed the 384 MB largeHeap dead
  // (2026-10-02, three crashes: 19:29/20:08/20:11 — the last two on relaunch
  // taps that raced the keychain auto-unlock, landing here with a null handle
  // + a fileKey getter). Refuse beyond the bound — recoverable error, not a
  // crash; a retry after the unlock takes the native streaming path.
  const FALLBACK_MAX_BYTES = 100 * 1024 * 1024;
  // FAIL-CLOSED (task 1683g, second crash): an UNKNOWN size must refuse too —
  // Guus's retry OOMed with a null sizeBytes AND a chunked response (no
  // Content-Length), skipping both known-size checks. This path buffers the
  // whole body in the Java heap; without a known bound it is unsafe, period.
  // (The real fix — the native layer resolving the key itself so this fallback
  // never runs on new builds — is task 1683h.)
  if (sizeBytes == null || sizeBytes > FALLBACK_MAX_BYTES) {
    recordRuntimeTrace('preview.decrypt.js_download.refused_too_large', {
      fileId,
      sizeBytes,
    });
    throw new Error('This file is too large to open right now. Please wait a moment and try again.');
  }
  let res: Response;
  try {
    recordRuntimeTrace('preview.decrypt.js_download.request', { fileId });
    res = await rateLimitedFetch(getDownloadUrl(fileId), {
      headers: { Authorization: `Bearer ${token}` },
      signal: options.signal,
    });
  } catch (error) {
    recordRuntimeTrace('preview.decrypt.js_download.network_failed', {
      fileId,
      ...errorTraceFields(error),
    });
    throw error;
  }
  throwIfAborted(options.signal);
  recordRuntimeTrace('preview.decrypt.js_download.response', {
    fileId,
    status: res.status,
    ok: res.ok,
    contentLength: responseHeaderInt(res.headers, 'Content-Length'),
    originalSizeHeader: responseHeaderInt(res.headers, 'X-Original-Size'),
    chunkCountHeader: responseHeaderInt(res.headers, 'X-Chunk-Count'),
    chunkSizeHeader: responseHeaderInt(res.headers, 'X-Chunk-Size'),
  });
  if (!res.ok) {
    const message = await errorMessageFromResponse(res);
    recordRuntimeTrace('preview.decrypt.js_download.http_failed', {
      fileId,
      status: res.status,
      message,
    });
    throw new ApiError(res.status, message);
  }

  const contentLength = responseHeaderInt(res.headers, 'Content-Length');
  // Task 1683g belt-and-braces: fail-closed here too — an unknown
  // Content-Length (chunked/streamed response) must refuse: the body would be
  // buffered whole in the Java heap. (The real fix is 1683h — the native layer
  // resolving the key itself so this fallback never runs on new builds.)
  if (contentLength == null || contentLength > FALLBACK_MAX_BYTES) {
    recordRuntimeTrace('preview.decrypt.js_download.refused_too_large', {
      fileId,
      sizeBytes: contentLength,
    });
    throw new Error('This file is too large to open right now. Please wait a moment and try again.');
  }
  options.onProgress?.({
    requestId: '',
    fileId,
    stage: 'downloading',
    bytesDownloaded: contentLength ?? 0,
    bytesTotal: contentLength ?? 0,
  });
  const encBytes = new Uint8Array(await res.arrayBuffer());
  recordRuntimeTrace('preview.decrypt.js_download.body_read', {
    fileId,
    encryptedBytes: encBytes.length,
  });
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
  recordRuntimeTrace('preview.decrypt.chunk_metadata', {
    fileId,
    encryptedBytes: encBytes.length,
    effectiveSize,
    effectiveChunkCount,
    effectiveChunkSize: effectiveChunkSize ?? CHUNK_SIZE,
    headerOriginalSize,
    headerChunkCount,
    headerChunkSize,
    inferredChunkCount: inferred,
  });

  // Fast path: when the native batched decrypt (task 0438) is available,
  // hand the contiguous encrypted body to Rust in one call and let it slice,
  // decrypt, and write the plaintext directly to `outputPath`. Avoids the
  // ~100 per-chunk JSI round-trips the legacy `decryptEncryptedBytes` loop
  // makes for a 100 MB file.
  console.info('[decrypt] FINGERPRINT-2026-05-23 entering decryptToTempFile', {
    fileId,
    probeReady: isDecryptToFileReady(),
    bytes: encBytes.length,
    chunks: effectiveChunkCount,
  });
  if (isDecryptToFileReady()) {
    console.info('[decrypt] fast-path: decryptContiguousToFile (0438)', {
      fileId,
      chunkCount: effectiveChunkCount,
      bytes: encBytes.length,
    });
    try {
      recordRuntimeTrace('preview.decrypt.fast_path.request', {
        fileId,
        encryptedBytes: encBytes.length,
        effectiveChunkCount,
        effectiveChunkSize: effectiveChunkSize ?? CHUNK_SIZE,
      });
      options.onProgress?.({
        requestId: '',
        fileId,
        stage: 'decrypting',
        chunksCompleted: 0,
        chunksTotal: effectiveChunkCount,
      });
      const written = await decryptChunksToFile(
        resolvedFileKey,
        encBytes,
        effectiveChunkSize ?? CHUNK_SIZE,
        outputPath,
      );
      if (options.signal?.aborted) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw abortError();
      }
      options.onProgress?.({
        requestId: '',
        fileId,
        stage: 'decrypting',
        chunksCompleted: effectiveChunkCount,
        chunksTotal: effectiveChunkCount,
      });
      if (written <= 0) {
        // Rust returned zero bytes — treat as a decrypt failure, clean up so
        // the cache layer doesn't pick up a corrupt empty file later.
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw new Error('Native batched decrypt returned zero bytes.');
      }
      await prunePreviewCache(outputPath);
      recordRuntimeTrace('preview.decrypt.fast_path.success', {
        fileId,
        written,
        elapsedMs: Date.now() - startedAt,
      });
      return outputPath;
    } catch (err) {
      // On any failure mid-batch, scrub the partial file so the cache doesn't
      // surface it as complete. Then surface the error so the caller can
      // retry (which may fall back via the probe if the native path is
      // unhealthy).
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      if (err instanceof DecryptToFileUnavailableError) {
        // Probe lied (e.g. bridge ripped out at runtime) — fall through to
        // the per-chunk JS loop below.
        recordRuntimeTrace('preview.decrypt.fast_path.unavailable_fallback', { fileId });
      } else {
        recordRuntimeTrace('preview.decrypt.fast_path.failed', {
          fileId,
          elapsedMs: Date.now() - startedAt,
          ...errorTraceFields(err),
        });
        throw err;
      }
    }
  }

  // Fallback: decrypt all chunks via the per-chunk JS bridge and write
  // base64. Retained per the spec's "Existing per-chunk path retained as a
  // fallback" criterion — covers older builds without the batched method
  // and the unlikely runtime-unhealthy scenario above.
  let decrypted: Uint8Array;
  try {
    recordRuntimeTrace('preview.decrypt.js_loop.request', {
      fileId,
      encryptedBytes: encBytes.length,
      effectiveChunkCount,
      effectiveChunkSize: effectiveChunkSize ?? CHUNK_SIZE,
    });
    decrypted = await decryptEncryptedBytes(
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
    recordRuntimeTrace('preview.decrypt.js_loop.success', {
      fileId,
      plaintextBytes: decrypted.length,
    });
  } catch (error) {
    recordRuntimeTrace('preview.decrypt.js_loop.failed', {
      fileId,
      ...errorTraceFields(error),
    });
    throw error;
  }
  throwIfAborted(options.signal);

  // Write plaintext to temp file
  try {
    await FileSystem.writeAsStringAsync(outputPath, uint8ArrayToBase64(decrypted), {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (error) {
    recordRuntimeTrace('preview.decrypt.write_failed', {
      fileId,
      ...errorTraceFields(error),
    });
    throw error;
  }
  if (options.signal?.aborted) {
    await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
    recordRuntimeTrace('preview.decrypt.aborted_after_write', { fileId });
    throw abortError();
  }
  await prunePreviewCache(outputPath);
  recordRuntimeTrace('preview.decrypt.success', {
    fileId,
    extension: ext,
    plaintextBytes: decrypted.length,
    elapsedMs: Date.now() - startedAt,
  });

  return outputPath;
}

/**
 * Decrypt a LOCAL encrypted file (an offline copy in `OFFLINE_DIR`) to a temp
 * file — the read-from-local half of "available offline" (task 0803).
 *
 * Identical decryption to `decryptToTempFile`, but the ciphertext is read from
 * `localEncryptedUri` instead of fetched from the API, so it works with NO
 * network. The offline blob is the exact `nonce||ct||tag` chunk stream the
 * server stores; since the HTTP size/chunk headers aren't persisted alongside
 * it, plaintext size + chunk count come from the file metadata (`sizeBytes`,
 * `chunkCount`) with a fallback inference. Plaintext is written only to the
 * sandboxed, auto-pruned preview cache — never persisted in the clear.
 */
export async function decryptLocalFileToTempFile(
  fileId: string,
  fileKey: Uint8Array | (() => Promise<Uint8Array>) | null,
  extension: string,
  localEncryptedUri: string,
  sizeBytes?: number | null,
  chunkCount?: number | null,
  chunkSize?: number | null,
  options: PreviewDecryptOptions = {},
): Promise<string> {
  // Task 1593 round 3 — a plaintext writer: hold a gate lease; a purge closing
  // the gate aborts this exactly like a cancelled caller (every write below is
  // followed by an abort check that deletes the output).
  return withPlaintextLease('offline decrypt', (lease) => {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (options.signal?.aborted || lease.signal.aborted) controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    lease.signal.addEventListener('abort', forward, { once: true });
    return decryptLocalFileLeased(
      fileId, fileKey, extension, localEncryptedUri, sizeBytes, chunkCount, chunkSize,
      { ...options, signal: controller.signal },
    ).finally(() => {
      options.signal?.removeEventListener('abort', forward);
      lease.signal.removeEventListener('abort', forward);
    });
  });
}

async function decryptLocalFileLeased(
  fileId: string,
  fileKey: Uint8Array | (() => Promise<Uint8Array>) | null,
  extension: string,
  localEncryptedUri: string,
  sizeBytes: number | null | undefined,
  chunkCount: number | null | undefined,
  chunkSize: number | null | undefined,
  options: PreviewDecryptOptions,
): Promise<string> {
  await ensureCacheDir();
  throwIfAborted(options.signal);

  const ext = extension.replace(/^\./, '');
  const outputPath = `${PREVIEW_CACHE_DIR}${fileId}.${ext}`;

  // Reuse a previously-decrypted plaintext copy when present.
  const cached = await FileSystem.getInfoAsync(outputPath);
  if (cached.exists && cached.size && cached.size > 0) {
    options.onProgress?.({ requestId: '', fileId, stage: 'complete' });
    return outputPath;
  }

  if (!fileKey) {
    throw new Error('Decrypting an offline file requires the file key.');
  }
  const resolvedFileKey = typeof fileKey === 'function' ? await fileKey() : fileKey;
  throwIfAborted(options.signal);

  // Framing resolved from the file's SIZE (never a whole-file read): the
  // offline blob is the exact server chunk stream, so size math + the
  // manifest meta captured at download time decide the windows — the same
  // math the legacy path below runs over the in-memory bytes.
  const info = await FileSystem.getInfoAsync(localEncryptedUri);
  if (!info.exists || !(info.size && info.size > 0)) {
    throw new Error('Offline copy is missing.');
  }
  const encryptedSize = info.size;
  const effectiveSize = sizeBytes ?? encryptedSize - 28;
  if (effectiveSize <= 0) {
    throw new Error('Could not determine plaintext size for the offline file.');
  }
  const inferred = inferChunkCountFromEncryptedSize(encryptedSize, effectiveSize);
  const effectiveChunkCount = chunkCount ?? inferred ?? 1;
  // The exact upload chunk size is required to slice a multi-chunk body. It is
  // captured from the download headers (offlineManager.getMeta); fall back to
  // the default only when unknown — matching the network path's own fallback.
  const effectiveChunkSize = chunkSize && chunkSize > 0 ? chunkSize : CHUNK_SIZE;

  recordRuntimeTrace('offline.decrypt.start', {
    fileId,
    extension: ext,
    encryptedBytes: encryptedSize,
    effectiveSize,
    effectiveChunkCount,
    effectiveChunkSize,
  });

  // Native path (task 1683d): stream the local ciphertext through Kotlin's
  // chunk-window loop — no whole-file base64 buffer in the JS heap (the 1683
  // OOM class at offline sizes). Errors are real decrypt/IO failures and
  // propagate (mirrors the fast-path contract below): a truncated or corrupt
  // blob fails identically in the JS fallback, which at these sizes OOMs
  // instead of succeeding.
  if (typeof decryptLocalFileNative === 'function') {
    const requestId = `offline-${fileId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      options.onProgress?.({
        requestId,
        fileId,
        stage: 'decrypting',
        chunksCompleted: 0,
        chunksTotal: effectiveChunkCount,
      });
      const result = await decryptLocalFileNative({
        fileKey: resolvedFileKey,
        inputUri: localEncryptedUri,
        outputUri: outputPath,
        chunkSizeBytes: effectiveChunkSize,
        chunkCount: effectiveChunkCount,
        originalSize: effectiveSize,
        requestId,
        fileId,
        signal: options.signal,
      });
      if (options.signal?.aborted) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw abortError();
      }
      if (!(result.plaintextSize > 0)) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw new Error('Native offline decrypt returned zero bytes.');
      }
      await prunePreviewCache(outputPath);
      options.onProgress?.({ requestId, fileId, stage: 'complete' });
      recordRuntimeTrace('offline.decrypt.native.success', {
        fileId,
        plaintextSize: result.plaintextSize,
        chunksDecrypted: result.chunksDecrypted,
      });
      return outputPath;
    } catch (err) {
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      recordRuntimeTrace('offline.decrypt.native.failed', { fileId, ...errorTraceFields(err) });
      throw err;
    }
  }

  // Read the local ENCRYPTED bytes (same blob the server stores).
  const b64 = await FileSystem.readAsStringAsync(localEncryptedUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const encBytes = base64ToUint8Array(b64);
  throwIfAborted(options.signal);

  recordRuntimeTrace('offline.decrypt.legacy_whole_file', {
    fileId,
    encryptedBytes: encBytes.length,
  });

  // Fast path: hand the contiguous body to Rust to slice + decrypt + write.
  if (isDecryptToFileReady()) {
    try {
      options.onProgress?.({
        requestId: '',
        fileId,
        stage: 'decrypting',
        chunksCompleted: 0,
        chunksTotal: effectiveChunkCount,
      });
      const written = await decryptChunksToFile(resolvedFileKey, encBytes, effectiveChunkSize, outputPath);
      if (options.signal?.aborted) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw abortError();
      }
      if (written <= 0) {
        await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
        throw new Error('Native batched decrypt returned zero bytes.');
      }
      await prunePreviewCache(outputPath);
      options.onProgress?.({ requestId: '', fileId, stage: 'complete' });
      recordRuntimeTrace('offline.decrypt.fast_path.success', { fileId, written });
      return outputPath;
    } catch (err) {
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      if (!(err instanceof DecryptToFileUnavailableError)) {
        recordRuntimeTrace('offline.decrypt.fast_path.failed', { fileId, ...errorTraceFields(err) });
        throw err;
      }
      // Probe lied — fall through to the per-chunk JS loop.
    }
  }

  // Fallback: per-chunk JS decrypt, then write base64.
  const decrypted = await decryptEncryptedBytes(
    resolvedFileKey,
    encBytes,
    effectiveChunkCount,
    effectiveSize,
    effectiveChunkSize,
    (chunksCompleted, chunksTotal) => {
      options.onProgress?.({ requestId: '', fileId, stage: 'decrypting', chunksCompleted, chunksTotal });
    },
  );
  throwIfAborted(options.signal);

  await FileSystem.writeAsStringAsync(outputPath, uint8ArrayToBase64(decrypted), {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (options.signal?.aborted) {
    await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
    throw abortError();
  }
  await prunePreviewCache(outputPath);
  options.onProgress?.({ requestId: '', fileId, stage: 'complete' });
  recordRuntimeTrace('offline.decrypt.success', { fileId, plaintextBytes: decrypted.length });
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
 * Clear all cached preview files — every decrypted plaintext copy under
 * `Library/Caches/preview/`.
 *
 * Task 1593 (P1): this had ZERO callers, and the native sign-out purge
 * (`purgePlaintextStorage`) deliberately skips `Library/Caches/`, so up to
 * 512 MiB / 24 files of decrypted previews survived sign-out. It is now part
 * of `purgeAllPlaintextCaches()` (sign-out, account deletion) and runs on a
 * launch / session end with nobody signed in (App.tsx).
 *
 * Order: delete the directory, abort every decrypt still in flight and wait
 * for them to settle — an in-flight download would otherwise finish AFTER the
 * purge and write a fresh plaintext file — then delete again to catch
 * anything written in between. Never throws.
 *
 * Round 3 (#141 Codex P1): this runs INSIDE `plaintextGate.purge()` (see
 * account-cleanup.ts), which has already closed the gate — so no replacement
 * decrypt can be queued behind an aborted one — and drained every job's lease
 * (bounded by PLAINTEXT_DRAIN_TIMEOUT_MS, not the old fixed 3 s). A job still
 * running past that bound finds its lease invalid and deletes its own output.
 */
export async function clearPreviewCache(): Promise<void> {
  const remove = () => FileSystem.deleteAsync(PREVIEW_CACHE_DIR, { idempotent: true }).catch(() => {});
  previewLeases.clear();
  await remove();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    previewDecrypts.abortAll(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PLAINTEXT_DRAIN_TIMEOUT_MS);
    }),
  ]).catch(() => {});
  if (timer) clearTimeout(timer);
  await remove();
}

/**
 * Task 1563 — evict ONE file's cached decrypted preview, keyed the same way
 * `decryptToTempFile` builds `outputPath` (fileId + extension). Every prior
 * caller of this cache only ever produced a NEW plaintext for a fileId that
 * had never been decrypted before (a fresh upload, a different file); the
 * text editor's Save is the first flow that replaces the content BEHIND an
 * already-cached fileId while the app is still running. Without this,
 * reopening the file right after a save served the stale pre-edit bytes
 * from disk — confirmed on-device (bb-ios27): the server's `size_bytes`
 * updated correctly, but `decryptToTempFile`'s cache-hit rung
 * (`cachedSize` in the runtime trace) still reported the OLD size. Call
 * this right after a save succeeds, for every extension the file could
 * plausibly have been opened under this session (cheap — deleting a
 * nonexistent path is a no-op).
 */
export async function invalidatePreviewCache(fileId: string, extension: string): Promise<void> {
  try {
    const ext = extension.replace(/^\./, '');
    previewLeases.delete(`${PREVIEW_CACHE_DIR}${fileId}.${ext}`);
    await FileSystem.deleteAsync(`${PREVIEW_CACHE_DIR}${fileId}.${ext}`, { idempotent: true });
  } catch {
    // Best-effort — a failed delete just means the next open re-decrypts
    // into a fresh temp file's normal cache-miss path instead of reusing this one.
  }
}
