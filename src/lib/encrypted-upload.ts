/**
 * Streaming encrypted upload for the Beebeeb mobile client.
 *
 * Reads the file one 4 MB chunk at a time via expo-file-system to avoid
 * loading the whole file into memory (which would OOM on large videos).
 * Each chunk is AES-256-GCM encrypted and sent immediately after reading —
 * at most one plaintext + one ciphertext chunk live in memory at once.
 *
 * Wire format matches the web client:
 *   name_encrypted → JSON { nonce: base64, ciphertext: base64 }
 *   each chunk     → raw binary: nonce (12 bytes) || ciphertext
 *
 * The caller must supply a client-generated `fileId` (UUID v4). The same ID
 * is used to derive the file-encryption key AND is sent to the server so the
 * server stores it — download and decryption later use that same file_id.
 *
 * AES-256-GCM overhead per chunk = 12 (nonce) + 16 (auth tag) = 28 bytes,
 * so total ciphertext size is deterministically: plaintextSize + chunkCount × 28.
 * This lets us compute size_bytes before reading any file data.
 */

import * as FileSystem from 'expo-file-system'
import type { EncryptedData } from '../../modules/beebeeb-crypto'
import { uploadEncryptedChunked } from './api'
import type { FileEntry, UploadProgress } from './api'

// Must match server CHUNK_SIZE and web client CHUNK_SIZE (both are 4 MiB)
const CHUNK_SIZE = 4 * 1024 * 1024

// AES-256-GCM per-chunk overhead: 12-byte nonce + 16-byte auth tag
const AES_GCM_OVERHEAD = 28

export interface EncryptedUploadOptions {
  /** Client-generated UUID v4 — used for key derivation AND stored by server. */
  fileId: string
  /** Local file URI (expo DocumentPicker / ImagePicker asset.uri). */
  uri: string
  /** Plaintext filename — will be encrypted before upload. */
  name: string
  parentId?: string
  mimeType?: string
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>
  onProgress?: (p: UploadProgress) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Decode a base64 string (as returned by expo-file-system) to Uint8Array. */
function b64ToUint8Array(b64: string): Uint8Array {
  const binaryStr = atob(b64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
  return bytes
}

/** Encode Uint8Array to base64 (for name_encrypted JSON). */
function uint8ArrayToB64(arr: Uint8Array): string {
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s)
}

/** Produce the wire-format binary for a chunk: nonce || ciphertext. */
function combineNonceCiphertext(enc: EncryptedData): Uint8Array {
  const out = new Uint8Array(enc.nonce.length + enc.ciphertext.length)
  out.set(enc.nonce, 0)
  out.set(enc.ciphertext, enc.nonce.length)
  return out
}

/**
 * Generate a UUID v4 for the file_id.
 * Uses crypto.randomUUID() (Hermes ≥ 0.75 / RN 0.76+) with a manual fallback.
 */
export function generateFileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback: manual UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Perform an end-to-end encrypted upload of a file identified by its local URI.
 *
 * Streaming: reads and encrypts one chunk at a time — memory footprint is
 * O(CHUNK_SIZE) regardless of file size.
 */
export async function encryptedUpload(opts: EncryptedUploadOptions): Promise<FileEntry> {
  const {
    fileId, uri, name, parentId, mimeType,
    encryptChunkFn, encryptMetadataFn, onProgress,
  } = opts

  // ── 1. Get file size ────────────────────────────────────────────────────
  const info = await FileSystem.getInfoAsync(uri, { size: true })
  if (!info.exists) throw new Error(`File not found: ${uri}`)
  // Expo types: size is on FileInfo when { size: true } is passed
  const plaintextSize: number = (info as FileSystem.FileInfo & { size?: number }).size ?? 0

  // ── 2. Deterministic ciphertext-size calculation ─────────────────────────
  // AES-GCM adds a fixed 28-byte overhead per chunk (12 nonce + 16 auth tag).
  // No need to encrypt upfront — this lets us send size_bytes in the init call.
  const chunkCount = Math.max(1, Math.ceil(plaintextSize / CHUNK_SIZE))
  const ciphertextSize = plaintextSize + chunkCount * AES_GCM_OVERHEAD

  // ── 3. Encrypt filename ──────────────────────────────────────────────────
  const encName = await encryptMetadataFn(fileId, name)
  const nameEncrypted = JSON.stringify({
    nonce: uint8ArrayToB64(encName.nonce),
    ciphertext: uint8ArrayToB64(encName.ciphertext),
  })

  // ── 4. Stream: read one chunk, encrypt it, hand back to uploader ─────────
  //
  // `readEncryptedChunk` is called by `uploadEncryptedChunked` per-chunk in
  // sequence. Each call reads CHUNK_SIZE bytes from the file at the correct
  // position, encrypts them, and returns the nonce||ciphertext wire bytes.
  // At most one plaintext chunk (4 MB) + one ciphertext chunk (4 MB + 28 B)
  // are in memory at any point.
  const readEncryptedChunk = async (index: number): Promise<Uint8Array> => {
    const position = index * CHUNK_SIZE
    const length = Math.min(CHUNK_SIZE, plaintextSize - position)

    let plaintext: Uint8Array
    if (length <= 0) {
      // Empty chunk (e.g. empty file — at least one chunk required by server)
      plaintext = new Uint8Array(0)
    } else {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        position,
        length,
      })
      plaintext = b64ToUint8Array(b64)
    }

    const enc = await encryptChunkFn(fileId, plaintext)
    return combineNonceCiphertext(enc)
  }

  // ── 5. Init → upload chunks → complete ──────────────────────────────────
  return uploadEncryptedChunked({
    fileId,
    nameEncrypted,
    parentId,
    mimeType,
    sizeBytes: ciphertextSize,
    chunkCount,
    onProgress,
    readEncryptedChunk,
  })
}
