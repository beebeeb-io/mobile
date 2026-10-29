import Foundation

/// Task 1589 — recognizing a swept v2 upload session from the native (Swift)
/// upload paths (`NativeBackupEngine.swift`, `NativeManualUploader.swift`).
///
/// Server PR #120 gives every v2 upload session a lease (default 3600 s,
/// renewed by every chunk request, the complete call and an explicit
/// heartbeat). Once the lease expires and the sweeper reclaims the session,
/// every later chunk PUT, complete or heartbeat against it answers 404 — "one
/// code for a swept session" (`beebeeb-api/src/routes/uploads.rs`,
/// `load_upload_session`). An older server (pre-#120, or mid-rolling-deploy)
/// can still answer 400 `"upload session is not writable: expired"` for the
/// exact same condition, so that is matched too, as a fallback.
///
/// Mirrors the mobile JS `isUploadSessionGone` (`src/lib/upload-session-
/// reinit.ts`, PR-1589) and the CLI's identically-purposed check (PR #50) —
/// same two signals, so every client that keys a request on a persisted v2
/// `upload_session_id` tells the same story about a swept upload.
///
/// Deliberately free of every other type in this module (no `BackupError`,
/// no `NativeUploadFailure`) so it stays trivially unit-testable — see
/// `.claude/tasks/_qa-evidence/1589/mobile-swift-test/` for the standalone
/// `swiftc` harness that compiles this exact file.
func isUploadSessionGoneStatus(_ status: Int, body: String) -> Bool {
  if status == 404 { return true }
  if status == 400 {
    let lowered = body.lowercased()
    return lowered.contains("not writable") && lowered.contains("expired")
  }
  return false
}
