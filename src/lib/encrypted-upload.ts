/**
 * Streaming encrypted upload for the Beebeeb mobile client.
 *
 * Reads the file one negotiated chunk at a time via expo-file-system to avoid
 * loading the whole file into memory (which would OOM on large videos).
 * Each chunk is AES-256-GCM encrypted and sent immediately after reading —
 * at most one plaintext + one ciphertext chunk live in memory at once.
 *
 * Wire format matches beebeeb-core:
 *   name_encrypted → JSON { cipher_suite, nonce: byte[], ciphertext: byte[] }
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
import { encryptedMetadataToJson } from './encrypted-metadata'
import { isMedia } from './media'

export interface EncryptedUploadOptions {
  /** Client-generated UUID v4 — used for key derivation AND stored by server. */
  fileId: string
  /** Local file URI (expo DocumentPicker / ImagePicker asset.uri). */
  uri: string
  /** Plaintext filename — will be encrypted before upload. */
  name: string
  parentId?: string
  mimeType?: string
  /** Existing encrypted name to let v2 replacement uploads bind to the current file row. */
  v2InitNameEncrypted?: string
  /**
   * Original creation date of the file (ISO 8601 string).
   * Used for camera roll backups so the server stores the photo's real date
   * instead of the upload timestamp.
   */
  createdAt?: string
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

/** Produce the wire-format binary for a chunk: nonce || ciphertext. */
function combineNonceCiphertext(enc: EncryptedData): Uint8Array {
  const out = new Uint8Array(enc.nonce.length + enc.ciphertext.length)
  out.set(enc.nonce, 0)
  out.set(enc.ciphertext, enc.nonce.length)
  return out
}

function hashResumeKey(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Generate a UUID v4 for the file_id.
 * Uses crypto.randomUUID() which is available on Hermes ≥ 0.75 / RN 0.76+
 * and all supported iOS/Android versions.
 */
export function generateFileId(): string {
  return crypto.randomUUID()
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Perform an end-to-end encrypted upload of a file identified by its local URI.
 *
 * Streaming: reads and encrypts one chunk at a time — memory footprint is
 * O(chunk_size_bytes) regardless of file size.
 */
export async function encryptedUpload(opts: EncryptedUploadOptions): Promise<FileEntry> {
  const {
    fileId, uri, name, parentId, mimeType, createdAt,
    v2InitNameEncrypted, encryptChunkFn, encryptMetadataFn, onProgress,
  } = opts

  // ── 1. Get file size ────────────────────────────────────────────────────
  const info = await FileSystem.getInfoAsync(uri, { size: true })
  if (!info.exists) throw new Error(`File not found: ${uri}`)
  // Expo types: size is on FileInfo when { size: true } is passed
  const plaintextSize: number = (info as FileSystem.FileInfo & { size?: number }).size ?? 0

  const metadataPlain = JSON.stringify({ name, mime_type: mimeType ?? null })

  const nameEncryptedForFileId = async (targetFileId: string): Promise<string> => {
    const encName = await encryptMetadataFn(targetFileId, metadataPlain)
    return encryptedMetadataToJson(encName)
  }

  // ── 2. Stream: read one negotiated chunk, encrypt it, hand back to uploader
  //
  // `readEncryptedChunk` is called by `uploadEncryptedChunked` per-chunk in
  // sequence. Each call reads chunk_size_bytes from the file at the correct
  // position, encrypts them, and returns the nonce||ciphertext wire bytes.
  // At most one plaintext chunk + one ciphertext chunk are in memory at once.
  const readEncryptedChunk = async (
    index: number,
    chunkSizeBytes: number,
    effectiveFileId: string,
  ): Promise<Uint8Array> => {
    const position = index * chunkSizeBytes
    const length = Math.min(chunkSizeBytes, plaintextSize - position)

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

    const enc = await encryptChunkFn(effectiveFileId, plaintext)
    return combineNonceCiphertext(enc)
  }

  // ── 3. Init → upload chunks → complete ──────────────────────────────────
  const resumeKey = hashResumeKey([
    parentId ?? 'root',
    uri,
    name,
    mimeType ?? '',
    plaintextSize,
  ].join('\n'))

  // MIME type is now encrypted inside name_encrypted — never sent in plaintext.
  // Only `is_media` (a boolean) is sent so the server can index media files.
  const mediaFlag = isMedia(mimeType)

  return uploadEncryptedChunked({
    fileId,
    nameEncrypted: nameEncryptedForFileId,
    v2InitNameEncrypted,
    parentId,
    mimeType: undefined,
    isMedia: mediaFlag,
    createdAt,
    plaintextSizeBytes: plaintextSize,
    resumeKey,
    onProgress,
    readEncryptedChunk,
  })
}
