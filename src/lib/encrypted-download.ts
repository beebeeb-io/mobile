/**
 * Multi-chunk encrypted download helper for the Beebeeb mobile client.
 *
 * Mirrors the layout used by `encrypted-upload.ts` (and the web client's
 * `lib/encrypted-download.ts`):
 *
 *   per chunk on the wire = nonce(12) || ciphertext(plaintext_len + 16-byte GCM tag)
 *   total encrypted size  = sum over chunks of (plaintext_len + 28)
 *
 * Chunk sizes are now dynamic (adaptive ladder in beebeeb-types). The
 * downloader uses the server's X-Chunk-Size response header to determine
 * the correct chunk size for decryption — this handles files uploaded with
 * any historical or adaptive chunk size.
 */

import {
  decryptChunk as nativeDecryptChunk,
} from '../../modules/beebeeb-crypto'

/**
 * Legacy 4 MB fallback — only used when the server does not provide an
 * X-Chunk-Size header (pre-v2 files). New uploads negotiate chunk size
 * dynamically via the storage-v2 protocol.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024

// AES-256-GCM: 12-byte nonce, 16-byte auth tag — 28 bytes per chunk.
const NONCE_LENGTH = 12
const GCM_TAG_LENGTH = 16
const CHUNK_OVERHEAD = NONCE_LENGTH + GCM_TAG_LENGTH

/**
 * Recover the chunk count from the encrypted body length when the server
 * doesn't supply X-Chunk-Count. Returns `null` when the byte math doesn't
 * line up with any whole-chunk count (likely indicates a different chunk
 * size than this client uses — see cross-platform note above).
 */
export function inferChunkCountFromEncryptedSize(
  encryptedSize: number,
  plaintextSize: number,
): number | null {
  const overheadSize = encryptedSize - plaintextSize
  if (overheadSize <= 0 || overheadSize % CHUNK_OVERHEAD !== 0) return null
  return overheadSize / CHUNK_OVERHEAD
}

/**
 * Read a header value from a downloaded-file response in a case-insensitive
 * way. Different platforms (iOS / Android / fetch) normalize header keys
 * differently, so check both common forms.
 */
export function readHeaderInt(
  headers: Record<string, string> | null | undefined,
  key: string,
): number | null {
  if (!headers) return null
  const candidates = [key, key.toLowerCase()]
  for (const k of candidates) {
    const v = headers[k]
    if (v != null) {
      const n = Number.parseInt(v, 10)
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return null
}

/**
 * Decrypt a concatenated multi-chunk encrypted blob into a single Uint8Array.
 *
 * @param fileKey       Per-file encryption key (32 bytes). Caller derives this
 *                      once via `getFileKeyBytes(fileId)` from the crypto
 *                      context so the helper itself is context-free.
 * @param encrypted     The full encrypted body as the server returned it.
 * @param chunkCount    Number of chunks the file was split into at upload.
 * @param sizeBytes     Original plaintext file size in bytes.
 * @param chunkSize     Plaintext chunk size used at upload.
 */
export async function decryptEncryptedBytes(
  fileKey: Uint8Array,
  encrypted: Uint8Array,
  chunkCount: number,
  sizeBytes: number,
  chunkSize = CHUNK_SIZE,
): Promise<Uint8Array> {
  if (chunkCount < 1) {
    throw new Error(`Invalid chunkCount: ${chunkCount}`)
  }
  if (chunkSize < 1) {
    throw new Error(`Invalid chunkSize: ${chunkSize}`)
  }

  const decryptedParts: Uint8Array[] = []
  let offset = 0

  for (let i = 0; i < chunkCount; i++) {
    const isLast = i === chunkCount - 1
    let plaintextSize: number
    if (chunkCount === 1) {
      plaintextSize = sizeBytes
    } else if (isLast) {
      plaintextSize = sizeBytes - i * chunkSize
    } else {
      plaintextSize = chunkSize
    }

    const encryptedChunkSize = NONCE_LENGTH + plaintextSize + GCM_TAG_LENGTH
    if (offset + encryptedChunkSize > encrypted.length) {
      throw new Error(
        `Chunk ${i}: expected ${encryptedChunkSize} bytes at offset ${offset}, ` +
          `but only ${encrypted.length - offset} remain (chunk size mismatch?)`,
      )
    }

    const nonce = encrypted.slice(offset, offset + NONCE_LENGTH)
    const ciphertext = encrypted.slice(
      offset + NONCE_LENGTH,
      offset + encryptedChunkSize,
    )

    const plaintext = await nativeDecryptChunk(fileKey, nonce, ciphertext)
    decryptedParts.push(plaintext)
    offset += encryptedChunkSize
  }

  // Sanity: we should have consumed the whole body. A stray tail usually
  // indicates a CHUNK_SIZE / chunkCount mismatch.
  if (offset !== encrypted.length) {
    throw new Error(
      `Decrypt finished with ${encrypted.length - offset} bytes unread — ` +
        `chunk metadata likely doesn't match the uploaded chunk size.`,
    )
  }

  const total = decryptedParts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let writeOffset = 0
  for (const part of decryptedParts) {
    out.set(part, writeOffset)
    writeOffset += part.length
  }
  return out
}
