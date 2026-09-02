/**
 * Pure helpers for the native (Swift) manual-upload path — task 1310.
 *
 * Kept free of native imports so the mapping logic between the native
 * progress snapshot / error envelope and the JS `UploadProgress` / `ApiError`
 * contracts can be unit-tested.
 */
import type { NativeUploadProgressEvent } from '../../modules/beebeeb-crypto'
import type { UploadProgress } from './api'

/** Error envelope the Swift uploader encodes into its error description. */
export interface NativeUploadErrorEnvelope {
  status: number
  code?: string
  message: string
}

const ENVELOPE_PATTERN = /\{[^{}]*"bb_upload_error"[^{}]*\}/

/**
 * Extract the structured `{status, code, message}` envelope from a native
 * error message. Expo prefixes/wraps thrown native errors, so the envelope is
 * located inside the text rather than expected to be the whole message.
 * Returns null for errors that did not originate in the native uploader.
 */
export function parseNativeUploadError(message: string | undefined | null): NativeUploadErrorEnvelope | null {
  if (!message) return null
  const match = ENVELOPE_PATTERN.exec(message)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as { status?: unknown; code?: unknown; message?: unknown }
    const status = typeof parsed.status === 'number' && Number.isFinite(parsed.status) ? parsed.status : 0
    const code = typeof parsed.code === 'string' && parsed.code.length > 0 ? parsed.code : undefined
    const text = typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : 'Upload failed'
    return { status, code, message: text }
  } catch {
    return null
  }
}

/** Map a native progress snapshot onto the JS `UploadProgress` contract. */
export function nativeProgressToUploadProgress(
  ev: NativeUploadProgressEvent,
  ctx: { chunkSizeBytes: number; uploadSessionId: string },
): UploadProgress {
  const phase: UploadProgress['phase'] = ev.stage === 'encrypting' ? 'preparing' : 'uploading'
  return {
    phase,
    chunksTotal: ev.chunksTotal,
    chunksUploaded: ev.chunksUploaded,
    bytesTotal: ev.bytesTotal,
    bytesUploaded: Math.min(ev.bytesUploaded, ev.bytesTotal > 0 ? ev.bytesTotal : ev.bytesUploaded),
    chunkSizeBytes: ctx.chunkSizeBytes,
    cryptoBytesPerSec: ev.cryptoBytesPerSec && ev.cryptoBytesPerSec > 0 ? ev.cryptoBytesPerSec : undefined,
    uploadSessionId: ctx.uploadSessionId,
    protocol: 'v2',
  }
}

/** Minimal view of the persisted resume state the native path cares about. */
export interface NativeResumeCandidate {
  protocol: 'v1' | 'v2'
  uploadSessionId: string | null
  chunkSizeBytes: number
  chunkCount: number
  plaintextSizeBytes: number
  parentId: string | null
  mimeType: string | null
  lastUploadedChunkIndex: number
}

/**
 * A persisted v2 session can only be resumed natively when it was planned with
 * the exact chunk layout `beebeeb-core` produces for this file — the encryptor
 * is rebuilt from scratch and must land on the same frame boundaries.
 */
/**
 * Thrown by `assertNativeUploadEncryptedUnderSessionId` when the id the
 * native bridge encrypted chunks under has drifted from the upload
 * session's file id. Distinct from `ApiError` so this stays a pure,
 * dependency-free check — `uploadEncryptedFileNative` (api.ts) wraps it.
 */
export class NativeUploadIdMismatchError extends Error {
  constructor(public readonly encryptedUnderFileId: string, public readonly sessionFileId: string) {
    super(
      `Native upload encrypted under file id "${encryptedUnderFileId}" but its ` +
      `upload session is "${sessionFileId}" — refusing to mark it complete.`,
    )
    this.name = 'NativeUploadIdMismatchError'
  }
}

/**
 * Belt-and-braces guard (task 1351). The native bridge never reports back
 * which id it actually encrypted chunks under — `uploadChunksNative`'s
 * result carries transfer stats only, not the key material's derivation
 * input — so this re-asserts JS's own bookkeeping: the id handed to the
 * bridge must be the same one the upload session (and `finalizeUpload`) is
 * keyed on. This is exactly the invariant task 1351's bug violated (chunks
 * encrypted under the client id while the file lived under the server id).
 * Call this AFTER the chunk upload and BEFORE `complete` — never mark an
 * upload complete whose encryption id and session id have drifted apart.
 */
export function assertNativeUploadEncryptedUnderSessionId(encryptedUnderFileId: string, sessionFileId: string): void {
  if (encryptedUnderFileId !== sessionFileId) {
    throw new NativeUploadIdMismatchError(encryptedUnderFileId, sessionFileId)
  }
}

export function resumeStateMatchesNativePlan(
  state: NativeResumeCandidate | null | undefined,
  expected: { plaintextSizeBytes: number; parentId?: string; chunkSizeBytes: number; chunkCount: number },
): boolean {
  if (!state || state.protocol !== 'v2' || !state.uploadSessionId) return false
  return (
    state.plaintextSizeBytes === expected.plaintextSizeBytes &&
    state.parentId === (expected.parentId ?? null) &&
    state.mimeType === null &&
    state.chunkSizeBytes === expected.chunkSizeBytes &&
    state.chunkCount === expected.chunkCount
  )
}
