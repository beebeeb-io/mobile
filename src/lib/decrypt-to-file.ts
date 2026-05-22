/**
 * TS-side wrapper for the future UniFFI `decryptChunksToFile` (task 0438).
 *
 * Today, `encrypted-download.ts:79–145` calls `nativeDecryptChunk` once per
 * chunk inside a JS loop. For a 100 MB file in 1 MB chunks that is 100
 * JSI ↔ native round-trips, each marshalling ~1 MB of bytes. The new
 * UniFFI method folds the entire chunk list + the AES key + a target output
 * path into a single Rust call: Rust iterates, decrypts, appends to the
 * file, and returns total bytes written.
 *
 * **Status:** the Rust method does not yet exist (rust-engineer is currently
 * on 0431 — UniFFI dedup — which is the keystone for this work). The Swift
 * bindings + `BeebeebCryptoModule` glue then come from ios-engineer. Until
 * both halves ship, `isDecryptToFileReady()` returns false and
 * `decryptChunksToFile()` throws `DecryptToFileUnavailableError`. Callers
 * detect that and fall through to the existing per-chunk JS loop.
 *
 * The wire signature matches the spec exactly:
 *
 *   decryptChunksToFile(
 *     fileKey: ByteArray,             // 32-byte AES-256 key
 *     chunks: List<EncryptedChunk>,   // (nonce, ciphertext) pairs in upload order
 *     outputPath: String,             // absolute path on the device filesystem
 *   ) -> Result<UInt64>               // bytes written, or Err on decrypt failure
 *
 * Coordination notes + final shape in
 * `.claude/tasks/in-development/0438-uniffi-decrypt-chunks-to-file.md`.
 */

import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface EncryptedChunk {
  /** 12-byte AES-GCM nonce. */
  nonce: Uint8Array;
  /** Ciphertext + 16-byte GCM auth tag (plaintext_len + 16). */
  ciphertext: Uint8Array;
}

interface DecryptChunksToFileNative {
  decryptChunksToFile(
    fileKey: Uint8Array,
    chunks: EncryptedChunk[],
    outputPath: string,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Native bridge probe — mirrors the backup-bridge pattern (0437)
// ---------------------------------------------------------------------------

let bridgeOverride: Partial<DecryptChunksToFileNative> | null = null;

/**
 * Test-only injection point. Lets unit tests exercise the adapter without
 * mounting the `modules/beebeeb-crypto` namespace (whose mutations aren't
 * visible across `import *` namespace freezing under bun:test). Production
 * code never calls this; pass `null` to restore the real bridge.
 */
export function __setDecryptToFileBridgeForTest(
  bridge: Partial<DecryptChunksToFileNative> | null,
): void {
  bridgeOverride = bridge;
}

function nativeBridge(): Partial<DecryptChunksToFileNative> {
  if (bridgeOverride) return bridgeOverride;
  return BeebeebCrypto as unknown as Partial<DecryptChunksToFileNative>;
}

/**
 * True once the UniFFI `decryptChunksToFile` has been added to the Rust crate
 * and exposed on `BeebeebCryptoModule`. Callers should branch on this rather
 * than catching the throw — the legacy per-chunk loop remains the production
 * path until this flips.
 */
export function isDecryptToFileReady(): boolean {
  const m = nativeBridge();
  return typeof m.decryptChunksToFile === 'function';
}

export class DecryptToFileUnavailableError extends Error {
  constructor() {
    super(
      'decryptChunksToFile is not available — Rust UniFFI method has not shipped yet.',
    );
    this.name = 'DecryptToFileUnavailableError';
  }
}

/**
 * Decrypt every chunk in `chunks` sequentially and append the plaintext to
 * the file at `outputPath`. Returns total bytes written. The output file
 * must NOT already exist (or must be empty) — Rust appends; the caller is
 * responsible for clearing any previous attempt before invoking this.
 *
 * On decrypt failure (auth tag mismatch, malformed ciphertext, IO error)
 * Rust returns an `Err`; the caller MUST delete any partially-written file
 * at `outputPath` so the cache layer doesn't treat it as a complete result.
 *
 * Throws `DecryptToFileUnavailableError` when the bridge has not yet
 * shipped. Callers should catch that and fall back to
 * `decryptEncryptedBytes` (the existing per-chunk JS loop).
 */
export async function decryptChunksToFile(
  fileKey: Uint8Array,
  chunks: EncryptedChunk[],
  outputPath: string,
): Promise<number> {
  const m = nativeBridge();
  if (typeof m.decryptChunksToFile !== 'function') {
    throw new DecryptToFileUnavailableError();
  }
  if (fileKey.length !== 32) {
    throw new Error(
      `decryptChunksToFile: expected 32-byte fileKey, got ${fileKey.length}`,
    );
  }
  if (chunks.length === 0) {
    throw new Error('decryptChunksToFile: chunks list is empty');
  }
  return m.decryptChunksToFile(fileKey, chunks, outputPath);
}

// ---------------------------------------------------------------------------
// Pure helper — slice the concatenated encrypted body into chunks
// ---------------------------------------------------------------------------

const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/**
 * Slice a concatenated encrypted body (the shape `encrypted-download.ts`
 * receives from the server: `nonce(12) || ciphertext || tag(16)` repeated)
 * into the `EncryptedChunk[]` form the bridge expects.
 *
 * Caller passes the same `chunkCount`, `sizeBytes`, and `chunkSize` the
 * existing `decryptEncryptedBytes` consumes; the slicing math here mirrors
 * that function exactly so swapping the call site is a one-line change.
 *
 * Pure — no native calls, no IO. Safe to unit-test directly.
 */
export function sliceEncryptedBody(
  encrypted: Uint8Array,
  chunkCount: number,
  sizeBytes: number,
  chunkSize: number,
): EncryptedChunk[] {
  if (chunkCount < 1) {
    throw new Error(`sliceEncryptedBody: invalid chunkCount ${chunkCount}`);
  }
  if (chunkSize < 1) {
    throw new Error(`sliceEncryptedBody: invalid chunkSize ${chunkSize}`);
  }
  const chunks: EncryptedChunk[] = [];
  let offset = 0;
  for (let i = 0; i < chunkCount; i++) {
    const isLast = i === chunkCount - 1;
    let plaintextSize: number;
    if (chunkCount === 1) {
      plaintextSize = sizeBytes;
    } else if (isLast) {
      plaintextSize = sizeBytes - i * chunkSize;
    } else {
      plaintextSize = chunkSize;
    }
    const encryptedChunkSize = NONCE_LENGTH + plaintextSize + GCM_TAG_LENGTH;
    if (offset + encryptedChunkSize > encrypted.length) {
      throw new Error(
        `sliceEncryptedBody: chunk ${i} wants ${encryptedChunkSize} bytes at offset ${offset}, only ${encrypted.length - offset} remain`,
      );
    }
    const nonce = encrypted.slice(offset, offset + NONCE_LENGTH);
    const ciphertext = encrypted.slice(
      offset + NONCE_LENGTH,
      offset + encryptedChunkSize,
    );
    chunks.push({ nonce, ciphertext });
    offset += encryptedChunkSize;
  }
  if (offset !== encrypted.length) {
    throw new Error(
      `sliceEncryptedBody: ${encrypted.length - offset} bytes unread — chunk metadata likely doesn't match the upload`,
    );
  }
  return chunks;
}
