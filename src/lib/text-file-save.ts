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

import { abandonFileUpload, uploadEncryptedChunked } from './api'
import { classifySaveConflict } from './text-save-flow'
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

export {
  classifySaveConflict,
  createSingleFlight,
  runTextSave,
  type SaveConflictKind,
  type TextSaveResult,
} from './text-save-flow'

/**
 * True ONLY for the server's stale-`base_version_number` 409. Task 1578: this
 * used to be `status === 409`, which also matched "upload is already in
 * progress for this file" — a single-device state left behind by an
 * interrupted save — and told the user another device had saved.
 */
export function isStaleVersionConflict(err: unknown): boolean {
  return classifySaveConflict(err) === 'stale-version'
}

const UPLOAD_STARTED = Symbol.for('beebeeb.textSave.uploadStarted')

/** True when a `saveTextFileVersion` rejection happened AFTER the server accepted `init`. */
export function saveFailedAfterUploadStarted(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<symbol, unknown>)[UPLOAD_STARTED] === true
}

/**
 * Task 1578 — clear this file's in-flight upload (`files.is_uploading`) so the
 * next save is not refused with "upload is already in progress". Server-side
 * this reverts to the previous completed version (task 1571); it never touches
 * a completed version. Best-effort: a server without the route (404) or a
 * network failure resolves quietly.
 */
export async function abandonTextFileUpload(fileId: string): Promise<void> {
  try {
    await abandonFileUpload(fileId)
  } catch {
    // Best-effort by design.
  }
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
  // `uploadEncryptedChunked` emits its first progress event only after `init`
  // succeeded (the server has set `is_uploading`), so the first event marks
  // "an interrupted attempt now needs an abandon".
  let uploadStarted = false
  try {
    return await uploadText(params, bytes, (p) => {
      uploadStarted = true
      params.onProgress?.(p)
    })
  } catch (err) {
    if (uploadStarted && err && typeof err === 'object') {
      try {
        Object.defineProperty(err, UPLOAD_STARTED, { value: true, enumerable: false })
      } catch {
        // Frozen error object — the caller just will not abandon.
      }
    }
    throw err
  }
}

function uploadText(
  params: SaveTextFileVersionParams,
  bytes: Uint8Array,
  onProgress: (p: UploadProgress) => void,
): Promise<FileEntry> {
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
    onProgress,
    // Task 1578: an interactive save the user is waiting on. The default
    // chunk transport is a BACKGROUND URLSession (expo-file-system legacy
    // default), which iOS may defer at its own discretion — on device that
    // left the Save spinner running with the file stuck mid-upload.
    foregroundTransfer: true,
    readEncryptedChunk: async (index, chunkSizeBytes, effectiveFileId) => {
      const start = index * chunkSizeBytes
      const end = Math.min(bytes.byteLength, start + chunkSizeBytes)
      const slice = start >= bytes.byteLength ? new Uint8Array(0) : bytes.slice(start, end)
      const enc = await params.encryptChunkFn(effectiveFileId, slice)
      return combineNonceCiphertext(enc)
    },
  })
}
