/**
 * TS-side wrapper for the future UniFFI `decryptContiguousToFile` (task 0438).
 *
 * Today, `encrypted-download.ts:79–145` calls `nativeDecryptChunk` once per
 * chunk inside a JS loop. For a 100 MB file in 1 MB chunks that's 100
 * JSI ↔ native round-trips, each marshalling ~1 MB of bytes. The new method
 * folds the whole encrypted body + AES key + chunk size + target path into
 * one Rust call: Rust slices, decrypts, appends to the output file, returns
 * total bytes written.
 *
 * **API shape:** after weighing the spec's pre-sliced `List<EncryptedChunk>`
 * shape against a contiguous `Vec<u8>` + metadata variant, rust-engineer
 * recommended the contiguous form — fewer per-chunk allocations on the iOS
 * side, less UniFFI marshalling overhead, reuses the slice math already in
 * `beebeeb-upload::download_and_decrypt_file`, and aligns with the future
 * mmap'd-decrypt path planned for desktop sync. The pre-sliced helper
 * (`sliceEncryptedBody`) stays in this module because the existing per-chunk
 * JS fallback in `decryptEncryptedBytes` already needs the same offset math.
 *
 * **Status:** the Rust method does not yet exist (rust-engineer ships it
 * after team-lead routes 0438; ios-engineer then regenerates UniFFI Swift
 * bindings + exposes via `BeebeebCryptoModule`). Until both halves ship,
 * `isDecryptToFileReady()` returns false and `decryptChunksToFile()` throws
 * `DecryptToFileUnavailableError`. Callers detect that and fall through to
 * the existing per-chunk JS loop.
 *
 * Wire signature (matches rust-engineer's recommendation):
 *
 *   decryptContiguousToFile(
 *     fileKey: ByteArray,    // 32-byte AES-256-GCM key
 *     body: ByteArray,       // contiguous encrypted blob — nonce(12) || ct || tag(16) per chunk
 *     chunkSize: u64,        // plaintext bytes per chunk (last is remainder)
 *     outputPath: String,    // absolute path on the device filesystem
 *   ) -> Result<UInt64>      // bytes written, or Err on decrypt/IO failure
 *
 * Coordination notes in
 * `.claude/tasks/in-development/0438-uniffi-decrypt-chunks-to-file.md`.
 */

import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Convenience shape for the per-chunk JS fallback path
 * (`decryptEncryptedBytes` in `encrypted-download.ts`). The bridged native
 * path no longer accepts this — it takes a contiguous body — but the helper
 * `sliceEncryptedBody` still returns it for the fallback consumer.
 */
export interface EncryptedChunk {
  /** 12-byte AES-GCM nonce. */
  nonce: Uint8Array;
  /** Ciphertext + 16-byte GCM auth tag (plaintext_len + 16). */
  ciphertext: Uint8Array;
}

interface DecryptToFileNative {
  decryptContiguousToFile(
    fileKey: Uint8Array,
    body: Uint8Array,
    chunkSize: number,
    outputPath: string,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Native bridge probe — mirrors the backup-bridge pattern (0437)
// ---------------------------------------------------------------------------

let bridgeOverride: Partial<DecryptToFileNative> | null = null;

/**
 * Test-only injection point. Lets unit tests exercise the adapter without
 * mounting the `modules/beebeeb-crypto` namespace (whose mutations aren't
 * visible across `import *` namespace freezing under bun:test). Production
 * code never calls this; pass `null` to restore the real bridge.
 */
export function __setDecryptToFileBridgeForTest(
  bridge: Partial<DecryptToFileNative> | null,
): void {
  bridgeOverride = bridge;
}

function nativeBridge(): Partial<DecryptToFileNative> {
  if (bridgeOverride) return bridgeOverride;
  return BeebeebCrypto as unknown as Partial<DecryptToFileNative>;
}

/**
 * True once the UniFFI `decryptContiguousToFile` has been added to the Rust
 * crate and exposed on `BeebeebCryptoModule`. Callers should branch on this
 * rather than catching the throw — the legacy per-chunk loop remains the
 * production path until this flips.
 */
export function isDecryptToFileReady(): boolean {
  const m = nativeBridge();
  return typeof m.decryptContiguousToFile === 'function';
}

export class DecryptToFileUnavailableError extends Error {
  constructor() {
    super(
      'decryptContiguousToFile is not available — Rust UniFFI method has not shipped yet.',
    );
    this.name = 'DecryptToFileUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Public adapter — JS-friendly façade over the native method
// ---------------------------------------------------------------------------

const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/**
 * Decrypt the entire encrypted body sequentially in native Rust and write
 * the plaintext to `outputPath`. Returns total plaintext bytes written.
 *
 * The output file must NOT already exist (or must be empty) — Rust appends.
 * The caller is responsible for clearing any previous attempt before
 * invoking this.
 *
 * On decrypt failure (auth tag mismatch, malformed ciphertext, IO error)
 * Rust returns an `Err`; the caller MUST delete any partially-written file
 * at `outputPath` so the cache layer doesn't treat it as a complete result.
 *
 * Throws `DecryptToFileUnavailableError` when the bridge has not yet
 * shipped. Callers should catch that and fall back to
 * `decryptEncryptedBytes` (the existing per-chunk JS loop).
 *
 * @param fileKey     32-byte AES-256-GCM key.
 * @param body        Contiguous encrypted blob: `nonce(12) || ciphertext || tag(16)`
 *                    per chunk, concatenated in upload order.
 * @param chunkSize   Plaintext bytes per chunk. The last chunk may be smaller.
 * @param outputPath  Absolute path on the device filesystem to write to.
 */
export async function decryptChunksToFile(
  fileKey: Uint8Array,
  body: Uint8Array,
  chunkSize: number,
  outputPath: string,
): Promise<number> {
  const m = nativeBridge();
  if (typeof m.decryptContiguousToFile !== 'function') {
    throw new DecryptToFileUnavailableError();
  }
  if (fileKey.length !== 32) {
    throw new Error(
      `decryptChunksToFile: expected 32-byte fileKey, got ${fileKey.length}`,
    );
  }
  if (body.length === 0) {
    throw new Error('decryptChunksToFile: body is empty');
  }
  if (chunkSize < 1 || !Number.isInteger(chunkSize)) {
    throw new Error(
      `decryptChunksToFile: chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }
  return m.decryptContiguousToFile(fileKey, body, chunkSize, outputPath);
}

// ---------------------------------------------------------------------------
// Pure helper — used by the in-JS-decrypt fallback, NOT by the native path
// ---------------------------------------------------------------------------

/**
 * Slice a concatenated encrypted body (`nonce(12) || ciphertext || tag(16)`
 * repeated) into the `EncryptedChunk[]` form the per-chunk JS decrypt loop
 * expects.
 *
 * Kept here because the existing fallback path in `encrypted-download.ts`
 * does the same offset math inline; centralising it lets the fallback
 * eventually delegate to this helper without behaviour change. The native
 * `decryptChunksToFile` path does NOT use this helper — Rust slices the
 * contiguous body itself with the same math.
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
