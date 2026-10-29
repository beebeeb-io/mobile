/**
 * Task 1589 (mobile) — recognizing a swept v2 upload session, and the typed
 * error for a second sweep in a row.
 *
 * Server PR #120 gives every v2 upload session a lease (default 3600 s,
 * renewed by every chunk request, the complete call and an explicit
 * heartbeat). Once the lease expires and the sweeper reclaims the session,
 * every later chunk PUT, complete or heartbeat against it answers 404 — "one
 * code for a swept session" (`beebeeb-api/src/routes/uploads.rs`,
 * `load_upload_session`). An older server (pre-#120, or mid-rolling-deploy)
 * can still answer 400 `"upload session is not writable: expired"` for the
 * exact same condition, so that is matched too, as a fallback.
 *
 * Mirrors web's `src/lib/upload-session-reinit.ts` (PR #122,
 * `isUploadSessionGone` / `UploadRestartFailedError`) and the CLI's
 * `is_upload_session_gone()` (PR #50) — same two signals, same bounded
 * "re-init once, then give up" contract, so all four clients (web, CLI, and
 * mobile's two upload paths below) tell the same story about a swept upload.
 *
 * Deliberately dependency-free (no react-native / expo / api.ts imports), so
 * this stays unit-testable in isolation and shared by every mobile upload
 * path that keys a request on a persisted v2 upload_session_id:
 * `uploadEncryptedChunked` (JS chunk loop — Android, the iOS JS fallback,
 * `text-file-save.ts`) and `uploadEncryptedFileNative` (iOS native manual
 * upload streaming).
 */

const EXPIRED_MESSAGE_PATTERN = /not writable:\s*expired/i

/**
 * True when `status`/`body` mean "this upload session no longer exists —
 * drop it and re-init", never for any other 4xx/5xx (409 conflict, 401, a
 * quota error, a validation 400 unrelated to session expiry, …).
 */
export function isUploadSessionGone(
  status: number,
  body?: { error?: string; message?: string } | null,
): boolean {
  if (status === 404) return true
  if (status === 400) {
    const text = `${body?.error ?? ''} ${body?.message ?? ''}`
    return EXPIRED_MESSAGE_PATTERN.test(text)
  }
  return false
}

/**
 * Thrown when a freshly re-inited upload session is ALSO gone by the time its
 * own chunk PUT or complete runs — i.e. two sweeps in a row for the same
 * upload attempt. Every caller re-inits at most ONCE per attempt; a second
 * sweep is surfaced as this typed error instead of looping. The caller's UI
 * (backup item, upload row, progress toast) should show this as a distinct,
 * retryable failure — not the generic "upload failed" — and not leave the
 * item stuck showing "uploading".
 */
export class UploadRestartFailedError extends Error {
  constructor(message = 'The upload session expired twice in a row — try again.') {
    super(message)
    this.name = 'UploadRestartFailedError'
  }
}
