/**
 * Pure helpers for the native (Swift) manual-upload path — task 1310.
 *
 * Kept free of native imports so the mapping logic between the native
 * progress snapshot / error envelope and the JS `UploadProgress` / `ApiError`
 * contracts can be unit-tested.
 */
import type { NativeUploadChunksParams, NativeUploadChunksResult, NativeUploadProgressEvent } from '../../modules/beebeeb-crypto'
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
 *
 * `encryptedUnderFileId` must come from `uploadChunksNativeTracked`'s result
 * below (the id actually handed to the bridge for THIS call), never a
 * caller-local variable that merely "should" mirror it — that gap (a
 * variable assigned from `serverFileId` and never reassigned, compared
 * against `serverFileId` itself) is what made an earlier version of this
 * guard a tautology that could never fire.
 */
export function assertNativeUploadEncryptedUnderSessionId(encryptedUnderFileId: string, sessionFileId: string): void {
  if (encryptedUnderFileId !== sessionFileId) {
    throw new NativeUploadIdMismatchError(encryptedUnderFileId, sessionFileId)
  }
}

/** Native-bridge transfer stats plus the id that call was actually invoked under. */
export interface NativeUploadChunksOutcome extends NativeUploadChunksResult {
  /** The `fileId` read off the SAME `params` object handed to `call` below. */
  encryptedUnderFileId: string
}

/** The subset of `uploadChunksNative`'s options this wrapper needs to forward. */
export interface NativeUploadCallOptions {
  onProgress?: (event: NativeUploadProgressEvent) => void
  signal?: AbortSignal
  pollIntervalMs?: number
}

/**
 * Wraps a native-bridge upload call so the id it was actually invoked with
 * survives past the call, for `assertNativeUploadEncryptedUnderSessionId`
 * above to check. `encryptedUnderFileId` is read off the exact `params`
 * object forwarded to `call` — the same object the native module receives —
 * never a second, caller-local binding that could silently drift from the
 * real call (exactly task 1351's bug: a JS variable that "should" mirror
 * the bridge argument but the completion guard never actually read from
 * it, so a call-site edit that changed the bridge's `fileId` argument left
 * the guard blind).
 *
 * `call` is injected rather than imported so this file stays free of native
 * imports (see the file header) and so a test can substitute a bridge stub
 * that reports a mismatched id, to prove the guard downstream genuinely
 * depends on this value rather than always agreeing with itself.
 */
export async function uploadChunksNativeTracked(
  call: (params: NativeUploadChunksParams, options?: NativeUploadCallOptions) => Promise<NativeUploadChunksResult>,
  params: NativeUploadChunksParams,
  options?: NativeUploadCallOptions,
): Promise<NativeUploadChunksOutcome> {
  const result = await call(params, options)
  return { ...result, encryptedUnderFileId: params.fileId }
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
