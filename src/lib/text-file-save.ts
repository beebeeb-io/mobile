/**
 * Task 1563 — saving an edited text/markdown/code file as a new version.
 *
 * Save = UTF-8 encode (in memory) → AES-256-GCM encrypt via the existing
 * per-file key (`encryptChunkFn` from `useCrypto()`) → the EXISTING
 * upload/versioning wire protocol (`uploadEncryptedChunked`, api.ts) — no
 * new server endpoints, no plaintext ever written to disk. Conflict
 * detection reuses the server's already-documented optimistic-concurrency
 * check on `POST /api/v1/uploads/init` (`file_id` + `base_version_number` →
 * 409 on a stale version — see `initUploadV2`'s doc comment in api.ts).
 *
 * The pure save/conflict DECISION logic (what the UI does next, "Keep
 * both" naming) lives in `text-save-decision.ts`, which has no `api.ts` /
 * React Native dependency at all and is what the unit tests exercise
 * directly. This file is the thin, RN-dependent layer that actually talks
 * to the network — re-exported here so callers only need one import.
 */

import { ApiError, uploadEncryptedChunked } from './api'
import type { EncryptedData } from '../../modules/beebeeb-crypto'
import type { FileEntry, UploadProgress } from './api'

export {
  buildKeepBothName,
  decideAfterConflictChoice,
  decideAfterSaveAttempt,
  type ConflictChoice,
  type ConflictNextAction,
  type SaveAttemptResult,
  type SaveNextAction,
} from './text-save-decision'

/** True when `err` is the server's typed 409 for a stale `base_version_number`. */
export function isStaleVersionConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

function combineNonceCiphertext(enc: EncryptedData): Uint8Array {
  const out = new Uint8Array(enc.nonce.length + enc.ciphertext.length)
  out.set(enc.nonce, 0)
  out.set(enc.ciphertext, enc.nonce.length)
  return out
}

export interface SaveTextFileVersionParams {
  /** The file id to write under — the existing file for a plain save/new-version, or a freshly generated one for "Keep both". */
  fileId: string
  /** The (already E2E-encrypted) name JSON to send — reused byte-for-byte, never re-derived here. Callers choose the existing name (plain save) or a freshly re-encrypted "Keep both" name. */
  nameEncrypted: string
  parentId?: string
  isMedia?: boolean
  text: string
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>
  /**
   * Present for a version-replace (plain save / "Save as new version anyway"):
   * pairs with `fileId` as the server's optimistic-concurrency check.
   * Omit for a brand-new file ("Keep both").
   */
  versionReplace?: { baseVersionNumber: number }
  onProgress?: (p: UploadProgress) => void
}

/**
 * UTF-8 encodes `text` in memory and uploads it as either a new version of
 * `fileId` (when `versionReplace` is given) or a brand-new file (when it is
 * omitted) via the existing chunked upload wire protocol. Never touches disk.
 */
export async function saveTextFileVersion(params: SaveTextFileVersionParams): Promise<FileEntry> {
  const bytes = new TextEncoder().encode(params.text)
  return uploadEncryptedChunked({
    fileId: params.fileId,
    nameEncrypted: params.nameEncrypted,
    v2InitNameEncrypted: params.nameEncrypted,
    parentId: params.parentId,
    isMedia: params.isMedia ?? false,
    plaintextSizeBytes: bytes.byteLength,
    versionReplace: params.versionReplace
      ? { fileId: params.fileId, baseVersionNumber: params.versionReplace.baseVersionNumber }
      : undefined,
    onProgress: params.onProgress,
    readEncryptedChunk: async (index, chunkSizeBytes, effectiveFileId) => {
      const start = index * chunkSizeBytes
      const end = Math.min(bytes.byteLength, start + chunkSizeBytes)
      const slice = start >= bytes.byteLength ? new Uint8Array(0) : bytes.slice(start, end)
      const enc = await params.encryptChunkFn(effectiveFileId, slice)
      return combineNonceCiphertext(enc)
    },
  })
}
