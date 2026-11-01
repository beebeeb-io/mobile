import AVFoundation
import ActivityKit
import CryptoKit
import Foundation
import Photos
import SDWebImage
import SDWebImageWebPCoder
import ManifestSQLite
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import WidgetKit
#if os(iOS)
import BackgroundTasks
import Network
#endif

private let backupAppGroupIdentifier = "group.io.beebeeb.shared"
private let backupStatusFileName = "backup-status.json"
private let backupReminderIdentifier = "io.beebeeb.backup.open-app-reminder"
private let backupReminderLastSentKey = "io.beebeeb.backupNotifications.openAppReminderLastSentAt"
private let backupReminderCooldownSeconds: TimeInterval = 24 * 60 * 60
private let backupReminderDelaySeconds: TimeInterval = 15 * 60
private let backupClientSessionIdKey = "io.beebeeb.backupClientSessionId"
private let backupCurrentAccountIdKey = "io.beebeeb.backupCurrentAccountId"
private let backupHeartbeatCadenceSeconds: TimeInterval = 30
private let backupSelectedAlbumIdsKey = "io.beebeeb.photoBackupSelectedAlbumIds"
private let backupIncludeVideosKey = "io.beebeeb.photoBackupIncludeVideos"
private let stagedBackupDirectoryName = "NativeBackupStaging"
private let minimumFreeBytesAfterStaging: Int64 = 2 * 1024 * 1024 * 1024
private let maxStagedBackupBytes: Int64 = 3 * 1024 * 1024 * 1024

/// Task 1600 [P1]: thread-safe wrapper around a `[Key: Value]` dictionary.
///
/// `NativeBackupEngine.chunkUploadContinuations` and `.uploadTaskMap` used to
/// be plain `Dictionary` stored properties written from FOUR different
/// execution contexts with no synchronization between them: a Swift
/// concurrency `Task` (`uploadStagedChunk`, insert), the URLSession delegate
/// queue (`backgroundSession` is created with `delegate: self,
/// delegateQueue: nil` — Foundation hands it a private serial
/// `OperationQueue` that is NOT `self.queue`/`dbQueue`/the cooperative
/// Task pool; `urlSession(_:task:didCompleteWithError:)` and the
/// `getAllTasks` completion both run there), `dbQueue`
/// (`recoverStuckUploads`, read), and whatever thread calls `stop()`
/// (`uploadTaskMap.removeAll()` — `stop()` is invoked from Expo's shared
/// serial `AsyncFunctionDefinition` queue, itself independent of all the
/// above). Swift's `Dictionary` is a value type with copy-on-write,
/// hash-table storage underneath — concurrent mutation from two threads
/// (an insert racing a remove, not even the same key) can corrupt that
/// storage outright, not just lose an update. That is the P1 hypothesis for
/// task 1600's build-224 `EXC_BAD_ACCESS … objc_retain` crash (a corrupted
/// `Dictionary<Int, CheckedContinuation<Void, Error>>` on the ObjC bridging
/// path, ~10s into a run — right as the first chunk uploads start completing
/// on the delegate queue while more are still being inserted from Tasks).
///
/// Every access here takes `lock` for the shortest possible span and NEVER
/// calls back out — resumes a continuation, invokes a closure, touches
/// `self` — while holding it. Callers that need to act on a removed value
/// (e.g. resuming a `CheckedContinuation`) must pull it out via
/// `removeValue(forKey:)` first and act on the RETURNED value after the
/// call returns, never inside a closure passed into this type (there is no
/// such closure-taking API on purpose).
private final class LockedDictionary<Key: Hashable, Value> {
  private let lock = NSLock()
  private var storage: [Key: Value] = [:]

  subscript(key: Key) -> Value? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return storage[key]
    }
    set {
      lock.lock()
      storage[key] = newValue
      lock.unlock()
    }
  }

  @discardableResult
  func removeValue(forKey key: Key) -> Value? {
    lock.lock()
    defer { lock.unlock() }
    return storage.removeValue(forKey: key)
  }

  func removeAll() {
    lock.lock()
    storage.removeAll()
    lock.unlock()
  }

  /// A snapshot of the current keys, copied out under the lock. Safe to
  /// iterate/map/check `.isEmpty` on afterwards — it is a plain `Array`,
  /// not a live view into `storage`.
  var keys: [Key] {
    lock.lock()
    defer { lock.unlock() }
    return Array(storage.keys)
  }

  /// Atomic get-transform-set under ONE lock acquisition. Task 1605 review
  /// round 3 (P2): a caller that reads the subscript, computes a new value,
  /// and writes the subscript back (two separate lock acquisitions) leaves a
  /// window between the two where another thread's `removeAll()` can land —
  /// the caller's write then resurrects the very entry `removeAll()` just
  /// cleared. `NativeBackupEngine`'s `didReceive` (accumulating a chunk-PUT
  /// response body) had exactly that shape, racing `stop()`'s
  /// `chunkResponseBodyBuffers.removeAll()`. `transform` receives the
  /// current value (nil if absent) and returns the value to store (nil
  /// removes the key) — both under the SAME lock hold, so no other
  /// operation on this dictionary can interleave.
  @discardableResult
  func mutate(key: Key, _ transform: (Value?) -> Value?) -> Value? {
    lock.lock()
    defer { lock.unlock() }
    let next = transform(storage[key])
    storage[key] = next
    return next
  }
}

@available(iOS 16.1, *)
struct BeebeebBackupActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var total: Int
    var completed: Int
    var pending: Int
    var waitingToEncrypt: Int
    var encryptedPendingUpload: Int
    var uploading: Int
    var failed: Int
    var state: String
    var reason: String
    var updatedAt: Date
  }

  var startedAt: Date
}

private struct BackupStatusPayload: Codable, Sendable {
  var total: Int
  var completed: Int
  var pending: Int
  var waitingToEncrypt: Int
  var encryptedPendingUpload: Int
  var uploading: Int
  var inProgress: Int
  var failed: Int
  var bytesUploaded: Int64
  var bytesTotal: Int64
  var state: String
  var reason: String
  var lastBackupAt: String?
  var lastChangeAt: String
  var updatedAt: String
}

private struct BackupWorkBreakdown {
  var waitingToEncrypt: Int
  var encryptedPendingUpload: Int
  var uploading: Int
}

/// Task LD-0002: what the status surfaces read from the manifest; the last
/// good copy stands in while the execution gate is closed.
private struct BackupStatusCounts {
  var pending = 0
  var breakdown = BackupWorkBreakdown(waitingToEncrypt: 0, encryptedPendingUpload: 0, uploading: 0)
  var lastBackupAt: String?
}

private struct BackupHeartbeatPayload: Sendable {
  let status: String
  let filesSynced: Int
  let filesTotal: Int
  let bytesSynced: Int64
  let bytesTotal: Int64
  let currentFile: String?
  let speedBps: Int64
  let detail: String
}

// MARK: - Types

enum BackupError: LocalizedError {
  case assetNotFound
  case assetLoadFailed
  case databaseUnavailable
  case noMasterKey
  case notConfigured
  /// Task 1531 [P0] round 3: `currentAccountId` is nil/empty — refused
  /// because there is nothing to tag a newly-staged asset with or compare
  /// an already-staged asset's `staged_account_id` against. Distinct from
  /// `.notConfigured` (missing token/API URL) so the log/diagnostic trail
  /// tells the two conditions apart.
  case accountUnknown
  case invalidServerURL
  case invalidResponse
  case httpStatus(Int, String)
  case jsonEncoding
  case encryptionFailed(String)
  /// A resumable upload session could not be reconciled: after re-PUTting every
  /// non-complete chunk, these chunk indices were still reported pending by the
  /// local bookkeeping, so `upload/complete` was not attempted. Surfaced (rather
  /// than silently returning false) so the wedge produces a diagnosable failure.
  case unreconciledChunks([Int])
  /// The server fail-fast 408 `storage.upload_stalled`: the chunk PUT body went
  /// idle (the 0-byte-stall symptom). Distinct from a generic httpStatus so the
  /// upload path can re-stage + requeue immediately instead of climbing toward
  /// the retry-10 dead-letter.
  case uploadStalled(Int)
  /// Task 1589: a chunk PUT or complete answered "session gone" (404, or the
  /// legacy 400 "not writable: expired") a SECOND time in the same upload
  /// attempt — once immediately after this asset's own re-init. Distinct from
  /// a generic httpStatus so this shows up in logs/perf events as its own
  /// reason rather than an ordinary HTTP failure; it still routes to the
  /// generic `markFailed` (retry_count+1, status back to pending) — bounded,
  /// never a second re-init.
  case uploadSessionGoneTwice
  /// Task 1599 [P1]: the server's typed 409 `account_mismatch`
  /// (`beebeeb-api::auth::check_expected_user`, task 1554) — the session's
  /// real account no longer matches the `X-Beebeeb-Expected-User` this
  /// request sent. Distinct from a generic `.httpStatus` so
  /// `isBackupUploadSessionGone` (404/expired-400 → re-init) can never
  /// mistake this for a swept session, and so logs/perf events show this as
  /// its own reason. Routes to the generic `markFailed` path (failed,
  /// retryable) like any other asset failure — the side effects (stop the
  /// run, drop the cached master-key handle) happen at detection time, in
  /// `handleConfirmedAccountMismatch()`, not here.
  case accountMismatchConfirmed
  /// Task 1599 followups (item 1): a swept-session re-init (task 1589)
  /// handed back a DIFFERENT `file_id` than the one this asset's staged
  /// chunks and name were encrypted under. The takeover contract (server PR
  /// #120 / `beebeeb-api.md`) is the SAME id — accepting a different one
  /// would upload already-encrypted ciphertext under the wrong file's
  /// identity. Routes to the generic `markFailed` path (failed, retryable)
  /// like any other asset failure; never a second re-init attempt with the
  /// server's id (that would compound the mistake, not fix it).
  case reinitFileIdMismatch
  /// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): the server's
  /// typed 409 for an account that cannot store data right now for a
  /// BILLING reason — `trial_cancelled_read_only` / `account_lapsed` /
  /// `plan_required` (`AccountRefusalDetection.knownRefusalCodes`).
  /// Distinct from `.accountMismatchConfirmed` (the SESSION doesn't match
  /// the account) — this IS the right account. Routes to a DIFFERENT
  /// recovery than the generic `markFailed` path: the call site that
  /// detected this already paused the whole engine
  /// (`handleConfirmedAccountRefusal`) and this asset's catch clause keeps
  /// its queue position (no `retry_count` bump) rather than climbing
  /// toward the retry-10 dead-letter for a reason that has nothing to do
  /// with this specific asset.
  case accountRefused(code: String)
  /// Task 1605 — the sibling 413 `quota_exceeded` with `is_trial_cap:
  /// true`: the never-paid-trial cap. Same pause-and-keep-queue
  /// recovery as `.accountRefused` above (`handleConfirmedTrialCapExceeded`)
  /// — NOT the ordinary `quota_exceeded` retry (a real out-of-plan-quota
  /// hit is still a generic retryable failure, unchanged by this case).
  case trialCapExceeded(message: String)

  var errorDescription: String? {
    switch self {
    case .assetNotFound: return "Photo asset not found in library"
    case .assetLoadFailed: return "Failed to load photo data from library"
    case .databaseUnavailable: return "Backup database unavailable"
    case .noMasterKey: return "Master key not available — sign in required"
    case .notConfigured: return "Backup engine not configured (missing token or API URL)"
    case .accountUnknown: return "Backup engine has no current account id — refusing to stage or upload"
    case .invalidServerURL: return "Invalid server URL for backup"
    case .invalidResponse: return "Invalid server response"
    case .httpStatus(let code, let body):
      return body.isEmpty ? "HTTP \(code)" : "HTTP \(code): \(body)"
    case .jsonEncoding: return "JSON encoding failed"
    case .encryptionFailed(let msg): return "Encryption failed: \(msg)"
    case .unreconciledChunks(let indices):
      let list = indices.map(String.init).joined(separator: ",")
      return "Resumable upload could not be reconciled; chunks still pending: [\(list)]"
    case .uploadStalled(let chunkIndex):
      return "Upload stalled on chunk \(chunkIndex) (server reported storage.upload_stalled)"
    case .uploadSessionGoneTwice:
      return "Upload session expired twice in a row for this asset"
    case .accountMismatchConfirmed:
      return "Backup upload refused: server reported the signed-in account changed"
    case .reinitFileIdMismatch:
      return "Upload session re-init returned a different file id than expected"
    case .accountRefused(let code):
      return "Backup upload refused: account cannot store data right now (\(code))"
    case .trialCapExceeded:
      return "Backup upload refused: trial storage cap reached"
    }
  }
}

/// Task 1599: mirrors `NativeEncryptedBackupUploader.applyExpectedUserHeader`
/// and `ApiClient.authedRequest`'s `expectedUser` param — the SAME
/// `X-Beebeeb-Expected-User` signal (task 1594) every other native upload
/// surface already attaches to its authenticated mutations, so the server can
/// refuse (409 `account_mismatch`) a request whose session doesn't match the
/// account this engine's unlocked master key is bound to. `accountId` must be
/// the caller's CONFIRMED account (`batchAccountId`/`currentAccountId`,
/// already re-checked live immediately before the network call) — never a
/// fresh, unchecked read taken here. Matches `NativeEncryptedBackupUploader`'s
/// contract: an empty `accountId` omits the header entirely rather than
/// sending an empty value.
private func applyExpectedUserHeader(to request: inout URLRequest, accountId: String) {
  guard !accountId.isEmpty else { return }
  request.setValue(accountId, forHTTPHeaderField: "X-Beebeeb-Expected-User")
}

// `AccountMismatchDetection.isAccountMismatch` (the 409 body check used
// below) lives in the sibling file `AccountMismatchDetection.swift` in this
// same directory — see that file's doc comment for why it is not simply
// `import`ed from `targets/file-provider/AccountMismatchDetection.swift`.

/// Task 1589 — true when `error` means "this v2 upload session no longer
/// exists — drop it and re-init the same file id", never for any other
/// failure (409 conflict, 429, a validation 400, …). The actual status/body
/// check is `isUploadSessionGoneStatus` (`UploadSessionGone.swift`), kept
/// dependency-free and unit-tested on its own; this just unwraps the
/// `BackupError` case it can appear in. The chunk-PUT path here only ever
/// surfaces a status code (`urlSession(_:task:didCompleteWithError:)` does
/// not capture the response body for a background upload task), so in
/// practice only 404 is ever seen there; `completeUpload` DOES capture the
/// body, so the legacy pre-#120 400 "not writable: expired" is matched there
/// too, as a fallback.
private func isBackupUploadSessionGone(_ error: Error) -> Bool {
  guard case BackupError.httpStatus(let status, let body) = error else { return false }
  return isUploadSessionGoneStatus(status, body: body)
}

/// Row from the backup_assets SQLite table.
struct BackupAssetRow {
  let localAssetId: String
  let remoteFileId: String?
  let assetType: String
  let contentHash: String
  let fileSize: Int64
  let createdAt: String
  let retryCount: Int
  let errorMessage: String?
  let filename: String? // Not stored in DB — resolved from PHAsset at upload time
  let stagedFileId: String?
  let stagedNameEncrypted: String?
  let stagedMimeType: String?
  let stagedIsMedia: Bool
  let stagedOriginalSize: Int64
  let stagedChunkCount: Int
  let stagedDir: String?
  /// v2 upload-session id (`/api/v1/uploads/{id}/...`). Persisted alongside
  /// `remoteFileId` (= the v2 `file_id`) so a resumed/relaunched upload re-PUTs
  /// chunks and completes against the SAME session. `remoteFileId` is still used
  /// for the GET /files/{id} completion check and thumbnails.
  let stagedUploadSessionId: String?
  /// The signed-in account (user id) whose master key encrypted the staged
  /// chunks + name envelope, captured at STAGE time (task 1531 [P0]). `nil`
  /// for rows staged before this column existed (pre-migration) or when no
  /// account id was available at stage time. Lead review on this task
  /// (2026-09-25) corrected an earlier version of this fix that trusted a
  /// `nil` tag: a device that staged under account A pre-migration, then
  /// switched to account B, has exactly this NULL-tagged state — nil does
  /// NOT mean "same account", it means "unknown", and unknown staged
  /// ciphertext must never be uploaded under a session that didn't encrypt
  /// it. `purgeMismatchedStagedAssets` therefore treats `nil` the same as a
  /// non-nil mismatch: both get dropped and re-staged. Only a value EQUAL to
  /// the current session's account id is trusted.
  let stagedAccountId: String?
}

private struct BackgroundChunkTaskDescription: Codable {
  let localAssetId: String
  /// v2 upload-session id the chunk PUT targets. Named `serverFileId` no longer
  /// (the route is `/uploads/{session}/chunks/{i}`), but kept as a stable JSON
  /// key so descriptions persisted by nsurlsessiond across launches still decode.
  let uploadSessionId: String
  let chunkIndex: Int
}

private struct StagedChunkRow {
  let index: Int
  let path: String
}

/// Task 1600: per-asset heartbeat pacing state for `uploadStagedAsset`, as an
/// explicit reference type instead of a captured `var` local. Build 224
/// crashed ~10s after enabling camera backup — EXC_BAD_ACCESS in
/// `objc_retain`, symbolicated to `uploadStagedAsset` -> a nested local
/// `func runChunksAndComplete` calling a `[weak self]` async closure
/// (`heartbeatIfDue`) that captured and mutated the enclosing `var
/// lastHeartbeatAt` across `await` points. That capture chain (local func +
/// closure sharing a mutable local var box across awaits, in a Release/
/// whole-module-optimized build) is the prime suspect; it reproduced only in
/// Release, never Debug. `HeartbeatPacer` removes the capture entirely: it is
/// passed as an ordinary reference-type argument to plain private instance
/// methods (see `runChunksAndComplete`/`heartbeatIfDue` below), which capture
/// nothing but `self`.
private final class HeartbeatPacer {
  var lastSentAt = Date()
  var intervalSecs: Double

  init(intervalSecs: Double) {
    self.intervalSecs = intervalSecs
  }
}

/// Result of POST /api/v1/uploads/init. We persist BOTH: `uploadSessionId` is
/// the route anchor for chunk PUTs + complete; `fileId` is the durable file row
/// used for thumbnails and the GET /files/{id} completion/resume check.
private struct UploadSessionInit {
  let uploadSessionId: String
  let fileId: String
  let chunkCount: Int
  /// Task 1589 — the server's recommended heartbeat cadence for this session
  /// (server PR #120, `lease_seconds / 3`). Falls back to
  /// `NativeBackupEngine.defaultHeartbeatIntervalSecs` for a server response
  /// that omits it (pre-#120).
  let heartbeatIntervalSecs: Double
}

private enum BackupPacingMode: String {
  case foregroundActive
  case foregroundIdle
  case background
  case lowPower
  case thermalPressure
  case serverBackoff

  var batchLimit: Int {
    switch self {
    case .foregroundActive, .lowPower, .thermalPressure, .serverBackoff:
      return 1
    case .foregroundIdle:
      return 2
    case .background:
      return 3
    }
  }

  var delayNanoseconds: UInt64 {
    switch self {
    case .foregroundActive:
      return 2_000_000_000
    case .foregroundIdle:
      return 750_000_000
    case .background:
      return 150_000_000
    case .lowPower, .thermalPressure, .serverBackoff:
      return 5_000_000_000
    }
  }
}

// MARK: - NativeBackupEngine

/// Native Swift backup engine for camera-roll backup.
///
/// Architecture:
/// - PHPhotoLibraryChangeObserver for real-time asset detection
/// - Foreground-friendly single-upload pipeline
/// - Rust encrypt via MasterKeyHandle -> FileKeyHandle -> encryptChunk (chunks written to temp files)
/// - Rust `uploadEncryptedFile()` from beebeeb-upload crate handles init/chunk-upload/complete
/// - Shared SQLite database (backup_assets) with JS UI layer via WAL mode
/// - Expo EventEmitter bridge for progress -> React
///
/// Encryption uses the MasterKeyHandle -> FileKeyHandle -> encryptChunk path,
/// writing encrypted chunks to temp files. The Rust `uploadEncryptedFile()`
/// function from the beebeeb-upload crate then handles the full upload
/// protocol (init session, upload chunks, complete) in a single blocking call.
final class NativeBackupEngine: NSObject {
  static let shared = NativeBackupEngine()

  private let liveActivityRequestQueue = DispatchQueue(label: "io.beebeeb.backup.live-activity")
  private var liveActivityRequestInFlight = false

  private let heartbeatQueue = DispatchQueue(label: "io.beebeeb.backup.heartbeat", qos: .utility)
  private var lastHeartbeatSentAt: Date?
  private var lastHeartbeatStatus: String?
  private var lastHeartbeatBytesSynced: Int64 = 0
  private var lastHeartbeatMetricAt: Date?
  private var lastKnownSpeedBps: Int64 = 0

  private func perfLog(_ event: String, _ fields: [String: CustomStringConvertible] = [:]) {
    let suffix = fields
      .map { "\($0.key)=\($0.value)" }
      .sorted()
      .joined(separator: " ")
    if suffix.isEmpty {
      NSLog("[BeebeebPerf] backup.native.\(event)")
    } else {
      NSLog("[BeebeebPerf] backup.native.\(event) \(suffix)")
    }
  }

  private func isoString(from date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
  }

  private func jsonValue<T>(_ value: T?) -> Any {
    guard let value else { return NSNull() }
    return value
  }

  private func nowMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }

  private func normalizedCreatedAt(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let value = Double(trimmed), value.isFinite {
      let seconds = value > 10_000_000_000 ? value / 1000 : value
      return isoString(from: Date(timeIntervalSince1970: seconds))
    }
    if let date = ISO8601DateFormatter().date(from: trimmed) {
      return isoString(from: date)
    }
    return isoString(from: Date())
  }

  // MARK: - Private state

  private let queue = DispatchQueue(label: "io.beebeeb.backup.engine", qos: .utility)
  private let dbQueue = DispatchQueue(label: "io.beebeeb.backup.engine.db", qos: .utility)
  /// Task LD-0002 (TestFlight 252, `0xdead10cc`): the one gate every SQLite
  /// path asks (`db` below is nil while it is closed), shared with
  /// `ThumbnailQueueDB`, so one expiry quiesces both stores.
  private var executionGate: BackupExecutionGate { BackupExecutionGate.shared }
  /// LD-0002: how an expiry aborts the manifest statement in flight, from any
  /// thread. `manifestHandle` publishes the connection and withdraws it before
  /// every close (B4).
  private static let manifestInterrupt = SQLiteInterruptTarget { exsqlite3_interrupt($0) }
  /// LD-0002 (#262 review 3): the manifest connection's progress handler asks
  /// it, so no statement runs while the gate refuses, even one a block started
  /// from a `db` it read before the gate closed. It also carries the
  /// completion write the current `dbQueue` block runs under its own
  /// assertion (B2).
  private static let manifestStatements = SQLiteStatementGate(gate: BackupExecutionGate.shared)
  /// Task 1531 [P2-C] (round 5 delta review): guards the read-compare-write
  /// of `currentAccountId` + the `accountGeneration` bump together. Without
  /// it, two near-simultaneous writers (e.g. a JS-driven `bindAccount` call
  /// racing a `BGProcessingTask`'s own account guard reading the property)
  /// could interleave a Keychain read from one with a Keychain write from
  /// the other, corrupting the "only bump on a REAL change" comparison
  /// below, and `accountGeneration` itself (a plain `Int`, not atomic) has
  /// no other synchronization — every read of it also goes through
  /// `accountGenerationSnapshot()` below rather than the bare property.
  private let accountIdLock = NSLock()
  private var backgroundSession: URLSession!
  private var metadataSession: URLSession!
  /// Task 1667 round 6: the engine's one native connection to the manifest
  /// and every open / reset / recover / reopen of it
  /// (`BackupManifestHandle.swift`). dbQueue-only, like `db` below
  /// (`swift-db-queue-audit.ts` checks both names).
  private let manifestHandle = BackupManifestHandle(
    path: NativeBackupEngine.backupDatabaseURL().standardizedFileURL.path,
    pendingReset: .userDefaults(NativeBackupEngine.manifestResetPendingKey),
    // Round 9: "that pending reset is an account deletion's" (no account id).
    discardPending: .userDefaults(NativeBackupEngine.manifestResetDiscardPendingKey),
    // Round 8: every write the fence drops is traced (and logged).
    onFencedWrite: { writer, ticketGeneration, generation in
      RuntimeTrace.event("backup.native.manifest.write_fenced", [
        "writer": writer,
        "ticketGeneration": ticketGeneration.map { Int($0) } ?? -1,
        "generation": Int(generation),
      ])
      NSLog("[NativeBackupEngine] Manifest write dropped by the sign-out fence: \(writer)")
    },
    interruptTarget: NativeBackupEngine.manifestInterrupt,
    statementGate: NativeBackupEngine.manifestStatements,
    prepareSchema: NativeBackupEngine.ensureTables
  )
  /// The open manifest handle, or nil while it is closed. Read-only here:
  /// only `manifestHandle` opens or closes it. LD-0002: nil too while the
  /// execution gate is closed, so no statement can start after a quiesce:
  /// every engine statement starts from here.
  private var db: OpaquePointer? { manifestHandle.connection(admittedBy: executionGate, completionWrite: NativeBackupEngine.manifestStatements.completionWrite) }
  /// Round 8: scans spawned by `registerPhotoObserver` / `photoLibraryDidChange`
  /// (guarded by `engineStateLock`). `stop()` cancels them; the write fence,
  /// not the cancel, is what keeps a late scan out of a reset manifest.
  private var _scanTasks: [UUID: Task<Void, Never>] = [:]
  /// Round 8: the write ticket of each in-flight chunk PUT, by task id, for
  /// its completion callback (`urlSession(_:task:didCompleteWithError:)`).
  private let chunkTaskTickets = LockedDictionary<Int, ManifestWriteFence.Ticket>()
  /// Task 1667 round 6: why `start()` could not open the manifest, and the
  /// retry it scheduled (both guarded by `engineStateLock`). Surfaced as
  /// `manifestUnavailableReason` in the progress dict and as the status
  /// reason; cleared by the next successful open, `stop()` and sign-out.
  private var _manifestAvailability = ManifestAvailability()
  private var _manifestOpenRetry: DispatchWorkItem?

  /// Task 1600 [P2]: dedicated lock for every plain scalar/reference `var`
  /// below that is written from more than one of the engine's concurrent
  /// execution contexts (the URLSession delegate queue, a detached/`Task {}`
  /// body on the cooperative pool — the drain loop and the `BGProcessingTask`
  /// handler each spawn their own — Expo's shared serial
  /// `AsyncFunctionDefinition` queue that `start()`/`stop()`/`pause()`/
  /// `resume()` run on, and the `NWPathMonitor` callback queue). A separate
  /// lock from `accountIdLock` on purpose: several of these accessors are
  /// read from inside functions that themselves may already be called while
  /// `accountIdLock` is held elsewhere (e.g. `bindAccount`), and `NSLock` is
  /// not reentrant — reusing `accountIdLock` here risks a self-deadlock the
  /// moment two of its critical sections nest. Every getter/setter below is
  /// a single lock → touch storage → unlock with no call-outs in between, so
  /// there is no nesting risk against THIS lock either.
  private let engineStateLock = NSLock()

  private var _masterKeyHandle: MasterKeyHandle?
  private var masterKeyHandle: MasterKeyHandle? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _masterKeyHandle }
    set { engineStateLock.lock(); _masterKeyHandle = newValue; engineStateLock.unlock() }
  }

  /// Task 1599 followup 2 (round 2, moved behind `engineStateLock` on the
  /// #150 merge — same rationale as every other var above/below it): the
  /// honest, user-facing reason the LAST confirmed `account_mismatch`
  /// stopped this engine — `nil` when nothing stopped it for that reason.
  /// Written from `handleConfirmedAccountMismatch()` (reachable from the
  /// URLSession delegate queue, via `uploadStagedChunk`/`completeUpload`'s
  /// error handling) and cleared from `bindAccount(userId:)` (Expo's shared
  /// serial `AsyncFunctionDefinition` queue); read from `currentProgress()`
  /// (`backupState(pending:)`), which `backup-context.tsx` polls from
  /// whatever queue JS's poll timer runs on — three independent contexts,
  /// same shape as every other property this lock already covers.
  private var _accountMismatchStopReason: String?
  private var accountMismatchStopReason: String? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _accountMismatchStopReason }
    set { engineStateLock.lock(); _accountMismatchStopReason = newValue; engineStateLock.unlock() }
  }

  /// Task 1599 followups round 3 (P1 — sign-in lockout loop): a monotonic
  /// counter, incremented every time `handleConfirmedAccountMismatch()` sets
  /// a NEW `accountMismatchStopReason`. Exposed via `currentProgress()`
  /// alongside the reason string so JS can distinguish "this reason was
  /// raised during MY session" from "this reason is a leftover from BEFORE
  /// my session started" — the distinction the lockout loop got wrong: a
  /// confirmed 409 sets the reason, JS ends that session, and the VERY NEXT
  /// sign-in's `BackupProvider` can remount and poll BEFORE
  /// `confirmMasterKeyHandle` (the unlock choke point) has a chance to clear
  /// it, misreading the stale reason as fresh and ending the brand-new
  /// session before the user finishes signing in. `mirrorSessionToAppGroup`
  /// (BeebeebCryptoModule.swift) now also clears the reason itself on both a
  /// token change and a sign-out, closing the common case; this generation
  /// counter is JS's own backstop (`backup-context.tsx`'s
  /// `reduceAccountMismatchPoll`) for whatever race remains. Never reset —
  /// only ever incremented, so "greater than the baseline observed at mount"
  /// is a stable comparison regardless of how many mismatches happened
  /// before this process even started polling.
  private var _accountMismatchGeneration = 0
  private var accountMismatchGeneration: Int {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _accountMismatchGeneration }
    set { engineStateLock.lock(); _accountMismatchGeneration = newValue; engineStateLock.unlock() }
  }

  /// Task 1599 followups round 3 (P2): distinct from `accountMismatchStopReason`
  /// above — that one is set only after the SERVER confirms a 409
  /// `account_mismatch` on a request this engine actually sent. This one is
  /// set entirely LOCALLY, in `start()`, when the ownership-verification
  /// guard refuses to even attempt loading the master key (a cached handle
  /// with no confirmed/matching owner, or a keychain-sourced handle the
  /// shared "proven vault key owner" mirror doesn't confirm for this
  /// account) — no network round-trip happens in that case, so
  /// `accountMismatchStopReason` would never fire, and backup silently sat
  /// idle with no explanation. Cleared whenever `start()` succeeds past the
  /// master-key section, and by `clearOwnerUnconfirmedStopReasonOnNewAuthentication()`
  /// at the same genuine-new-authentication choke points as the sibling
  /// account-mismatch clear.
  private var _ownerUnconfirmedStopReason: String?
  private var ownerUnconfirmedStopReason: String? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _ownerUnconfirmedStopReason }
    set { engineStateLock.lock(); _ownerUnconfirmedStopReason = newValue; engineStateLock.unlock() }
  }

  /// A file-count refusal remains visible until the next explicit retry.
  private var _fileLimitStopReason: String?
  private var fileLimitStopReason: String? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _fileLimitStopReason }
    set { engineStateLock.lock(); _fileLimitStopReason = newValue; engineStateLock.unlock() }
  }

  /// A confirmed billing/trial-cap refusal pauses this account without consuming
  /// asset retries or dropping its key. Camera backup and contacts/calendar share
  /// this reason. A successful start or explicit auxiliary resume clears it.
  /// JS polls subscription state serially after 15/30/60 seconds (60-second cap)
  /// while foregrounded and rechecks on foreground; an unblocked account resumes
  /// only its enabled categories. Session/account mismatches instead stop the
  /// engine and discard its key.
  private var _accountRefusalStopReason: String?
  private var accountRefusalStopReason: String? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _accountRefusalStopReason }
    set { engineStateLock.lock(); _accountRefusalStopReason = newValue; engineStateLock.unlock() }
  }

  private var _isRunning = false
  private var isRunning: Bool {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _isRunning }
    set { engineStateLock.lock(); _isRunning = newValue; engineStateLock.unlock() }
  }

  private var _isPaused = false
  private var isPaused: Bool {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _isPaused }
    set { engineStateLock.lock(); _isPaused = newValue; engineStateLock.unlock() }
  }

  // Task 1600 [P1]: was a plain `[Int: String]` — see `LockedDictionary`'s
  // doc comment above for why a bare Dictionary here is unsafe. Read/removed
  // on the URLSession delegate queue, cleared by `stop()` from whatever
  // thread calls it.
  private let uploadTaskMap = LockedDictionary<Int, String>() // URLSessionTask.taskIdentifier -> localAssetId

  private var _drainTask: Task<Void, Never>?
  private var drainTask: Task<Void, Never>? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _drainTask }
    set { engineStateLock.lock(); _drainTask = newValue; engineStateLock.unlock() }
  }

  private var _drainLoopGeneration = 0
  private var drainLoopGeneration: Int {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _drainLoopGeneration }
    set { engineStateLock.lock(); _drainLoopGeneration = newValue; engineStateLock.unlock() }
  }

  /// Task 1531 [P1-3]: bumped every time `currentAccountId` is written (set
  /// to a new account OR cleared to nil) — see that property's setter. A
  /// `BGProcessingTask` can capture this at entry and, after the account/
  /// purge guard passes, compare again before flipping `isRunning` off at
  /// its own exit: if a NEWER `start()`/account-switch has begun in the
  /// meantime the captured generation is stale, and the exit must NOT stop
  /// what is now a different (or differently-scoped) engine run. Mirrors the
  /// existing `drainLoopGeneration` pattern above, one level up (account
  /// epoch rather than drain-loop instance).
  private var accountGeneration = 0

  private var _pendingDrainWakeReason: String?
  private var pendingDrainWakeReason: String? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _pendingDrainWakeReason }
    set { engineStateLock.lock(); _pendingDrainWakeReason = newValue; engineStateLock.unlock() }
  }

  private let batchProcessingQueue = DispatchQueue(label: "io.beebeeb.backup.engine.batch", qos: .utility)
  // PHKit picks its own callback queue (often main when the app is foregrounded).
  // Hop here as the first line of every PhotoKit completion so the body — which
  // can do heavy work like `Data(contentsOf:)` for videos or
  // `continuation.resume` into an async context — never blocks main. Mirrors
  // the retired camera-roll callback queue (task 0440); the live queue here
  // rather than cross-class reference to avoid type coupling (task 0443).
  private static let phkitCallbackQueue = DispatchQueue(
    label: "io.beebeeb.backup.engine.phkit-callback",
    qos: .utility
  )
  private var batchProcessingActive = false // already serialized via batchProcessingQueue.sync — not touched by task 1600

  /// Task 1667 round 11 (review findings 3 and 5): start / stop / the
  /// manifest-open retry, the photo observer, the network monitor and the
  /// PhotoKit fetch result, behind one transition lock
  /// (`BackupEngineLifecycle`).
  private let lifecycle = BackupEngineLifecycle()

  /// The fetch result the PhotoKit change observer diffs against. Written
  /// only through `lifecycle` (`acceptFetchResult` / `replaceFetchResult`,
  /// cleared by every stop and after the sign-out reset).
  private var currentFetchResult: PHFetchResult<PHAsset>? {
    lifecycle.fetchResult as? PHFetchResult<PHAsset>
  }

  private var photoObserverRegistered: Bool { lifecycle.observerRegistered }

  private var _isBackgroundTaskActive = false
  private var isBackgroundTaskActive: Bool {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _isBackgroundTaskActive }
    set { engineStateLock.lock(); _isBackgroundTaskActive = newValue; engineStateLock.unlock() }
  }

  private var _isBackgroundGraceActive = false
  private var isBackgroundGraceActive: Bool {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _isBackgroundGraceActive }
    set { engineStateLock.lock(); _isBackgroundGraceActive = newValue; engineStateLock.unlock() }
  }

  private var _backgroundGraceTask: UIBackgroundTaskIdentifier = .invalid
  private var backgroundGraceTask: UIBackgroundTaskIdentifier {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _backgroundGraceTask }
    set { engineStateLock.lock(); _backgroundGraceTask = newValue; engineStateLock.unlock() }
  }

  /// LD-0002: the grace task's gate assertion (main thread only).
  private var graceAssertion: BackupExecutionGate.Assertion?
  /// LD-0002 (B1, P2a): the counts the status surfaces last read with the gate
  /// open and uninterrupted. While the gate is closed they are what the widget,
  /// the Live Activity and the reminder show: no SQLite, and never a false
  /// "0 pending".
  private var _lastStatusCounts: BackupStatusCounts?
  private var lastStatusCounts: BackupStatusCounts? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _lastStatusCounts }
    set { engineStateLock.lock(); _lastStatusCounts = newValue; engineStateLock.unlock() }
  }

  // Task 1600 [P1]: was a plain `[Int: CheckedContinuation<Void, Error>]` —
  // see `LockedDictionary`'s doc comment above. This is the dictionary
  // task 1600's evidence points at directly (write site `uploadStagedChunk`,
  // ~3638; read/remove `urlSession(_:task:didCompleteWithError:)`, ~5373,
  // and the `getAllTasks` orphan-reconciliation callback, ~1523; read
  // `recoverStuckUploads`, ~4727 — line numbers as of this fix; the
  // original crash evidence's line numbers, cited in the task file, are
  // against the pre-fix commit 0be3b3e).
  private let chunkUploadContinuations = LockedDictionary<Int, CheckedContinuation<Void, Error>>()
  /// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): a background
  /// `URLSession` upload task's `didCompleteWithError` delegate callback
  /// never receives the response BODY — only `task.response`'s status code
  /// — so distinguishing typed 409s on `PUT /uploads/{session}/chunks/{i}`
  /// (`account_mismatch` vs. `ensure_can_upload`'s task-1605 refusal codes,
  /// server PR #129 review — this route re-checks the gate on EVERY chunk,
  /// not just at init) needs the body accumulated separately, via
  /// `URLSessionDataDelegate.urlSession(_:dataTask:didReceive:)` below.
  /// Keyed by `taskIdentifier`, same lifecycle as `chunkUploadContinuations`
  /// (written as data arrives, read + removed on completion). Capped per
  /// task at `chunkResponseBodyCapBytes` — every real body on this route is
  /// a tiny JSON object (`{}` on success, a short typed-error object on
  /// failure; never a legitimate large payload) — so a misbehaving proxy
  /// echoing something huge back can't grow this unboundedly.
  private let chunkResponseBodyBuffers = LockedDictionary<Int, Data>()
  private static let chunkResponseBodyCapBytes = 4096
  #if os(iOS)
  private var networkMonitor: NWPathMonitor? { lifecycle.monitor as? NWPathMonitor }

  private var _isNetworkAvailable = true
  private var isNetworkAvailable: Bool {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _isNetworkAvailable }
    set { engineStateLock.lock(); _isNetworkAvailable = newValue; engineStateLock.unlock() }
  }
  #endif

  // Storage pre-flight estimate ONLY (see estimatedEncryptedBytes). The WIRE
  // chunk size is owned by beebeeb-core's ChunkEncryptorHandle (the "mobile"
  // profile), not this constant — task 0672 moved the camera-roll pipeline onto
  // the shared core ladder. Keeping a fixed value here just over-estimates the
  // per-chunk overhead for the free-disk check, which is conservative/safe.
  private let chunkSize = 4 * 1024 * 1024
  /// beebeeb-core chunk-plan profile. The chunk size + count are derived in Rust
  /// from this profile + the plaintext size — never hardcoded. Must be one of
  /// "desktop" | "web" | "mobile" | "backup".
  private static let chunkProfile = "mobile"
  private let maxConcurrentUploads = 1
  private let batchLimit = 12

  // Backoff state
  private var _consecutiveFailures = 0
  private var consecutiveFailures: Int {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _consecutiveFailures }
    set { engineStateLock.lock(); _consecutiveFailures = newValue; engineStateLock.unlock() }
  }

  private var _backoffUntil: Date?
  private var backoffUntil: Date? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _backoffUntil }
    set { engineStateLock.lock(); _backoffUntil = newValue; engineStateLock.unlock() }
  }

  /// Task 1667: the account whose manifest has been checked against (or
  /// rebuilt from) the server's per-device map in this process — see
  /// `ensureManifestReadyForUploads`. In memory on purpose: a relaunch checks
  /// once more (one GET), and `prepareForStoragePurge()` clears it.
  private var _manifestReadyForAccount: String?
  /// Task 1667 round 2: the account `currentAccountId` held before it was
  /// last cleared (guarded by `accountIdLock`, written in its setter).
  /// Round 13 (review item 3): `UnboundAccountMemory`, which also forgets it
  /// when another account binds or JS reports another signed-in user.
  private var _unboundAccount = UnboundAccountMemory()
  /// The sign-out reset's outgoing account: the bound one, else the one last
  /// unbound (`inferred`).
  private func outgoingAccountForReset() -> UnboundAccountMemory.Outgoing {
    let current = currentAccountId
    accountIdLock.lock(); defer { accountIdLock.unlock() }
    return _unboundAccount.outgoing(currentAccountId: current)
  }
  /// Task 1667 round 9: an account deletion forgets which account was last
  /// bound (nothing of it is kept for a sign-in that cannot happen).
  private func forgetUnboundAccount() {
    accountIdLock.lock(); defer { accountIdLock.unlock() }
    _unboundAccount.forget()
  }
  /// Round 13 (review item 3): JS confirmed `accountId` signed in
  /// (`confirmMasterKeyHandle`). A different account than the one last
  /// unbound ends that memory, so a later deletion by this user can never
  /// count the earlier account as the outgoing one.
  func noteSignedInAccount(_ accountId: String) {
    accountIdLock.lock(); defer { accountIdLock.unlock() }
    _unboundAccount.signedIn(accountId)
  }
  /// Task 1667 round 2: set when a sign-out could not empty the manifest in
  /// place; cleared once it was emptied (or replaced). While set, every
  /// open of the database empties it first, and an open that cannot empty
  /// it leaves no handle open (`BackupManifestHandle.openIfClosed`, round
  /// 6), so the outgoing account's rows are never read again even if the JS
  /// follow-up never ran.
  static let manifestResetPendingKey = "io.beebeeb.backupManifestResetPending"
  /// Task 1667 round 9: set with `manifestResetPendingKey` when the reset
  /// that failed was an account deletion's (`ManifestPurgeMode`). A boolean
  /// on purpose: the deleted account's id is not persisted, so a later
  /// process applies that reset keeping no pending mark of any account.
  static let manifestResetDiscardPendingKey = "io.beebeeb.backupManifestResetDiscardPending"
  private var manifestReadyForAccount: String? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _manifestReadyForAccount }
    set { engineStateLock.lock(); _manifestReadyForAccount = newValue; engineStateLock.unlock() }
  }

  // Task 1667 round 7 sweep: the last camera-roll insert into the manifest
  // failed (`BackupManifestStore.insertScannedAssets` returned false). While
  // set, the rebuild gate does not apply the server map: the map is applied
  // once per account, to the rows the manifest holds at that moment, and a
  // photo whose row was missing then would be uploaded again when a later
  // scan inserts it. Read and written only on `dbQueue`.
  //
  // Round 10 (review finding 4): sticky. Any failed insert sets it, and
  // only a successful FULL scan insert clears it (`ScanInsertHealth`); a
  // one-photo insert from `photoLibraryDidChange` used to clear the full
  // scan's failure.
  //
  // Round 11 (review finding 7): it lives on the manifest handle
  // (`manifestHandle.scanInsertHealth`, dbQueue-only), and the sign-out
  // reset (`prepareForStoragePurge` -> `resetForSignOut`) clears it with the
  // rows it describes, like every other account-scoped cache. Before, the
  // engine kept it across sign-out and account A's failed insert deferred
  // account B's first rebuild.

  /// Task 1667 round 11 (review finding 9): the fresh pending rows a bulk
  /// `/photo-backup/check` answered "needs backup" for; the per-batch guard
  /// skips them. Guarded by `engineStateLock`; cleared at every stop and
  /// sign-out, keyed by account and write-fence generation, 15-minute window.
  private var _serverCheckCoverage = ServerCheckCoverage()
  /// Round 11: a bulk pass is owed (set at every drain start, background task
  /// and scan insert; consumed by the next batch). Guarded by `engineStateLock`.
  private var _bulkServerCheckRequested = true
  /// Round 11 (review finding 2): the server answered `/check` without
  /// `backed_up` (no task 2036). While set, the rebuild fast path does not
  /// apply the identifiers map either (on such a server that map includes
  /// files in the Trash). Cleared by a `/check` that carries the field.
  /// Round 12 (review item 2): reset at sign-out (`prepareForStoragePurge`),
  /// and the rebuild probes the server once per backoff period while it is
  /// set (`PendingUploadServerCheck.rebuildFetch`), because every other
  /// `/check` runs after the rebuild gate. Before, nothing cleared it in
  /// that process: deploying 2036 changed nothing until the app was killed.
  /// Guarded by `engineStateLock`.
  private var _backedUpSupport = BackedUpSupport()
  /// Round 12 (review item 6): why uploads are paused on the server check
  /// (`serverCheckPausedReason` in the progress dict). Guarded by
  /// `engineStateLock`.
  private var _serverCheckPause = ServerCheckPause()
  /// Round 10: rows the last batch's server check promoted (they count as
  /// progress for the drain loop, which otherwise waits 5 s after a batch
  /// that uploaded nothing). Guarded by `engineStateLock`.
  private var _lastBatchServerPromoted = 0
  private var _serverCheckFailures = 0

  /// Task 1667 round 4: consecutive deferred rebuilds caused by a database
  /// step (see `ManifestRebuildGate.backoff`); 0 after a ready check.
  private var _manifestRebuildFailures = 0
  private var manifestRebuildFailures: Int {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _manifestRebuildFailures }
    set { engineStateLock.lock(); _manifestRebuildFailures = newValue; engineStateLock.unlock() }
  }

  // Cached UIApplication state — read by `currentApplicationState()` from
  // background queues without blocking on main. The cache is seeded at init
  // and maintained via four lifecycle notification observers; the previous
  // implementation fell back to `DispatchQueue.main.sync` when called off
  // main, which deadlocked the watchdog whenever main was busy in an
  // Expo-module JS bridge call (task 0434).
  private let applicationStateLock = NSLock()
  private var _cachedApplicationState: UIApplication.State = .active

  // Background task plumbing — stores the outer Task handle so the
  // BGProcessingTask expiration handler can `cancel()` it (task 0435).
  // The previous implementation only called `pause()` from the
  // expiration handler, which flipped `isPaused = true` but did NOT
  // propagate cancellation into the running Task — the inner upload
  // loop kept running until the current photo finished, frequently
  // overshooting the system's expiration grace window. Now we store
  // the Task handle and `.cancel()` it on expiration; `Task.isCancelled`
  // is already checked aggressively throughout `processBatch` and the
  // per-asset upload paths, so cancellation unwinds within hundreds of
  // milliseconds.
  private var _backgroundTaskHandle: Task<Void, Never>?
  private var backgroundTaskHandle: Task<Void, Never>? {
    get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _backgroundTaskHandle }
    set { engineStateLock.lock(); _backgroundTaskHandle = newValue; engineStateLock.unlock() }
  }
  // Guard against double `setTaskCompleted(success:)` — Apple's contract
  // forbids it. Both the body's terminal call and the expiration
  // handler funnel through `completeBackgroundTaskOnce` to ensure
  // exactly one call regardless of which path wins the race.
  private let backgroundTaskCompletionLock = NSLock()
  private var backgroundTaskCompletionFired = false

  static let bgTaskIdentifier = "io.beebeeb.app.native-backup"
  static let bgSessionIdentifier = "io.beebeeb.backup"
  /// Task 1599 followup 2 — the honest, user-facing copy for
  /// `accountMismatchStopReason`. Matches the brand voice rule (say what
  /// is, not what you wish were true) and the existing `backupBlockedReason`
  /// precedent's tone (task 1594, "a stopped backup says why").
  static let accountMismatchStopReasonMessage =
    "Backup stopped: this device is signed in to a different account. Sign in again to resume."
  /// Task 1599 followups round 3 (P2) — the honest, user-facing copy for
  /// `ownerUnconfirmedStopReason`. Distinct wording from
  /// `accountMismatchStopReasonMessage` above on purpose: this is a LOCAL
  /// refusal to even attempt starting (no server round-trip happened), not a
  /// server-confirmed mismatch — "unlock the app" is the correct, honest
  /// next step here, not "sign in again" (the user may already be signed
  /// in; the vault is just locked).
  static let ownerUnconfirmedStopReasonMessage =
    "Backup paused: unlock the app to confirm this account."
  /// Task 1605 — the honest, user-facing copy for `accountRefusalStopReason`,
  /// one per refusal code. Deliberately WORD-FOR-WORD the same copy
  /// `account-state.ts`'s `readOnlyUploadMessage()` already shows for a
  /// manual upload refused the same way (JS's own upload path, task 1605's
  /// web/mobile half) — one voice for "why can't I upload" everywhere in
  /// this app, not two copies that could drift. No purchase/pay-now call to
  /// action, unlike web (task 1400, App Review 3.1.1(a) — this app has no
  /// In-App Purchase product; see `account-state.ts`'s file header and
  /// `DEVIATIONS.md` → "Task 1605").
  static func accountRefusalStopReasonMessage(for code: String) -> String {
    switch code {
    case "trial_cancelled_read_only":
      return "This trial was cancelled, so uploads and backup are off. You can still browse and download your files."
    case "account_lapsed":
      return "Your trial has ended, so your vault is read-only: uploads and backup are off. You can still browse and download your files."
    case "plan_required":
      return "Uploads are paused on this account."
    default:
      // Unreachable in practice — `AccountRefusalDetection.knownRefusalCodes`
      // is the only source of `code` — but a switch over a `String` (not an
      // enum) needs an exhaustive default, and an honest generic beats a
      // crash if a future server code is added here without a matching case.
      return "Backup paused: this account cannot upload right now."
    }
  }
  // MARK: - Configuration (set by JS before calling start)

  var parentFolderId: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.photoBackupParentFolderId") }
    set {
      if let newValue, !newValue.isEmpty {
        UserDefaults.standard.set(newValue, forKey: "io.beebeeb.photoBackupParentFolderId")
      } else {
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.photoBackupParentFolderId")
      }
    }
  }

  /// Task 1667: the canonical device id (`getDeviceId()`, src/lib/device-identity.ts)
  /// sent as `X-Beebeeb-Device-Id` on the photo-backup map calls. The server
  /// keys `photo_backup_state` by (user, device, local identifier), so the mark
  /// and the rebuild must send the same value. A device property, not an
  /// account one: it survives sign-out like the JS-side id does. Persisted so
  /// a background relaunch (no JS yet) still has it.
  ///
  /// Round 12 (review item 7): before the first launch of this build JS has
  /// not handed it over yet (a background task can run first). The getter
  /// then reads the same id from expo-secure-store's keychain item
  /// (`BackupDeviceId.resolve`, never minting one) and keeps it in
  /// `UserDefaults`. JS's handoff (at every launch and at enable,
  /// `acceptBackupDeviceId` since round 13) ends a `noDeviceId` pause at once.
  var backupDeviceId: String? {
    let resolution = BackupDeviceId.resolve(
      defaults: { UserDefaults.standard.string(forKey: BackupDeviceId.defaultsKey) },
      secureStore: { BackupDeviceId.readSecureStore($0) },
      persist: { UserDefaults.standard.set($0, forKey: BackupDeviceId.defaultsKey) }
    )
    if let source = resolution.source, source != .defaults {
      RuntimeTrace.event("backup.native.device_id.adopted_from_secure_store", ["source": source.rawValue])
    }
    return resolution.id
  }

  /// Serializes `acceptBackupDeviceId`'s read-decide-write.
  private let backupDeviceIdLock = NSLock()

  /// Round 13 (review of mobile#182 at a19037f9, item 1, duplicate upload):
  /// the JS handoff (`setBackupDeviceId`). An existing, different id is
  /// replaced only when JS says the new one is durable (`persisted`); a
  /// refusal is logged and keeps the id native has. Before, the setter stored
  /// whatever JS sent, including a UUID JS minted because the keychain read
  /// failed (device locked). Returns whether native has `deviceId` now.
  @discardableResult
  func acceptBackupDeviceId(_ deviceId: String, persisted: Bool) -> Bool {
    backupDeviceIdLock.lock()
    let existing = backupDeviceId
    let decision = BackupDeviceId.decideSet(existing: existing, incoming: deviceId, persisted: persisted)
    if case .store = decision {
      UserDefaults.standard.set(deviceId, forKey: BackupDeviceId.defaultsKey)
    }
    backupDeviceIdLock.unlock()
    switch decision {
    case .refused(let reason):
      RuntimeTrace.event("backup.native.device_id.set_refused", [
        "reason": reason, "persisted": persisted, "hasExisting": existing?.isEmpty == false,
      ])
      NSLog("[NativeBackupEngine] setBackupDeviceId refused (\(reason)); keeping the existing device id")
      return false
    case .store(let replacing):
      if replacing != nil {
        RuntimeTrace.event("backup.native.device_id.replaced", ["persisted": persisted])
      }
    case .unchanged:
      break
    }
    if serverCheckPauseCause == .noDeviceId {
      clearServerCheckPause()
      backoffUntil = nil
      wakeDrainLoop(reason: "device-id")
    }
    return true
  }

  // Backup auth token and server URL are persisted in the Keychain (not
  // UserDefaults) so they do not propagate via unencrypted iTunes / iCloud
  // backups. See `KeychainManager.storeString` for the storage class and
  // task 0430 for context. `loadString` performs a one-time on-demand
  // migration from UserDefaults the first time it's called after upgrade.
  var token: String? {
    get { KeychainManager.loadString(key: "io.beebeeb.backupToken") }
    set {
      if let value = newValue, !value.isEmpty {
        try? KeychainManager.storeString(value, key: "io.beebeeb.backupToken")
      } else {
        KeychainManager.deleteString(key: "io.beebeeb.backupToken")
      }
    }
  }

  var apiBaseUrl: String? {
    get { KeychainManager.loadString(key: "io.beebeeb.serverURL") }
    set {
      if let value = newValue, !value.isEmpty {
        try? KeychainManager.storeString(value, key: "io.beebeeb.serverURL")
      } else {
        KeychainManager.deleteString(key: "io.beebeeb.serverURL")
      }
    }
  }


  var backupClientSessionId: String? {
    get { KeychainManager.loadString(key: backupClientSessionIdKey) }
    set {
      if let value = newValue, !value.isEmpty {
        try? KeychainManager.storeString(value, key: backupClientSessionIdKey)
      } else {
        KeychainManager.deleteString(key: backupClientSessionIdKey)
      }
    }
  }

  /// The user id of the account the engine is currently authorized to upload
  /// for (task 1531 [P0]). Set by `enablePhotoBackup(authToken:userId:)`
  /// alongside `token`, and — like `token`/`apiBaseUrl` — persisted in the
  /// Keychain rather than an in-memory var: a `BGProcessingTask` can relaunch
  /// this singleton in the background after the app process was killed, and
  /// an in-memory-only value would read back `nil` there, defeating the
  /// mismatch check in `purgeMismatchedStagedAssets` / `uploadSingleAsset`
  /// below on exactly the resumed-background-upload path task 1443 already
  /// had to fix once for the analogous "keep running against a different
  /// account's token" bug.
  var currentAccountId: String? {
    get { KeychainManager.loadString(key: backupCurrentAccountIdKey) }
    set {
      accountIdLock.lock()
      defer { accountIdLock.unlock() }
      // Task 1531 [P2-C] (round 5 delta review): normalize empty-string the
      // same way the get side effectively does (an empty string can never
      // be read back — `KeychainManager.loadString` never returns "", and
      // the delete-branch below is taken for "" too), so the "did this
      // actually change" comparison just below can't be fooled by a
      // nil-vs-"" mismatch that isn't a real change.
      let normalizedNew: String? = (newValue?.isEmpty == false) ? newValue : nil
      let previous = KeychainManager.loadString(key: backupCurrentAccountIdKey)
      guard previous != normalizedNew else { return }
      if let normalizedNew {
        try? KeychainManager.storeString(normalizedNew, key: backupCurrentAccountIdKey)
      } else {
        KeychainManager.deleteString(key: backupCurrentAccountIdKey)
      }
      // Task 1667 round 2: the sign-out reset keeps this account's
      // not-yet-marked uploads under its id; `clearToken()` unbinds the
      // engine before the purge runs, so remember who it was. Round 13
      // (review item 3): a bind (any account) ends that memory.
      _unboundAccount.accountChanged(from: previous, to: normalizedNew)
      // Task 1531 [P1-3]: a REAL change is a new account epoch — see
      // `accountGeneration`'s doc comment above. Round 5 (P2-C) narrowed
      // this from "every write" to "every write that actually changes the
      // value": a redundant re-assignment of the SAME account id (e.g. a
      // second `bindAccount` call for an already-bound user prior to that
      // method's own no-op guard, or any other direct-assignment call site)
      // used to bump the epoch anyway, which could invalidate a
      // `BGProcessingTask`'s just-captured `taskGeneration` for no real
      // account change and spuriously stop it from flipping `isRunning`
      // back off at its own exit (see `handleBackgroundTask`).
      accountGeneration += 1
    }
  }

  /// Thread-safe read of `accountGeneration` — see `accountIdLock`'s doc
  /// comment. Every comparison against a previously-captured generation
  /// value (the `BGProcessingTask` staleness check in `handleBackgroundTask`)
  /// goes through this rather than the bare property.
  private func accountGenerationSnapshot() -> Int {
    accountIdLock.lock()
    defer { accountIdLock.unlock() }
    return accountGeneration
  }

  var selectedPhotoAlbumIds: [String] {
    get { UserDefaults.standard.stringArray(forKey: backupSelectedAlbumIdsKey) ?? [] }
    set {
      let sanitized = Array(NSOrderedSet(array: newValue.filter { !$0.isEmpty })) as? [String] ?? []
      if sanitized.isEmpty {
        UserDefaults.standard.removeObject(forKey: backupSelectedAlbumIdsKey)
      } else {
        UserDefaults.standard.set(sanitized, forKey: backupSelectedAlbumIdsKey)
      }
    }
  }

  var includeVideos: Bool {
    get {
      guard UserDefaults.standard.object(forKey: backupIncludeVideosKey) != nil else { return true }
      return UserDefaults.standard.bool(forKey: backupIncludeVideosKey)
    }
    set {
      UserDefaults.standard.set(newValue, forKey: backupIncludeVideosKey)
      lifecycle.clearFetchResult()
    }
  }

  // MARK: - Progress (thread-safe via atomic reads from main queue)

  private(set) var totalAssets = 0
  private(set) var completedAssets = 0
  private(set) var failedAssets = 0
  private(set) var inProgressAssets = 0
  private(set) var bytesUploaded: Int64 = 0
  private(set) var bytesTotal: Int64 = 0
  private(set) var bytesTransferProgress: Int64 = 0

  // MARK: - Callbacks

  /// Progress callback invoked on each asset completion. Called on arbitrary queue.
  var onProgress: ((_ total: Int, _ completed: Int, _ failed: Int) -> Void)?

  /// Per-file status callback.
  var onFileStatus: ((_ assetId: String, _ status: String, _ filename: String?, _ error: String?) -> Void)?

  /// Completion callback when a batch finishes.
  var onBatchComplete: ((_ uploaded: Int, _ failed: Int, _ duration: TimeInterval) -> Void)?

  // MARK: - Init

  private override init() {
    super.init()
    // `setupBackgroundSession()` stays synchronous: iOS must be able to
    // deliver background-session delegate events (task completion,
    // `urlSessionDidFinishEvents(forBackgroundURLSession:)`) to `self` as
    // soon as the session with the same identifier is reattached — see
    // "Background URLSession relaunch events" above. `setupMetadataSession()`
    // is a plain `.default`-config session (no background-daemon XPC dance)
    // and has never been evidenced as slow, so it stays synchronous too.
    setupBackgroundSession()
    // Does not touch `db`; `getAllTasks` is itself asynchronous, so this call
    // returns immediately. Unchanged from before task 1669.
    reconcileOrphanedBackgroundTasks()
    setupMetadataSession()
    // Task 1669 Issue 2: opening the on-disk SQLite database must not block
    // whatever thread first constructs `.shared` (the launch path this task
    // protects), so it is ENQUEUED here — not run — on `dbQueue`.
    //
    // ORDERING INVARIANT (guarded by `native-backup-engine-db-queue.test.ts`):
    // this `dbQueue.async` is issued directly from `init()`, i.e. BEFORE
    // `init()` returns and therefore before any caller can hold `.shared`.
    // `dbQueue` is a private SERIAL queue (FIFO), so every later
    // `dbQueue.sync`/`.async` block — from any thread, any time — runs strictly
    // after `openDatabase()` has finished, and `db` is only ever read or
    // written on `dbQueue`. Do NOT move this into another queue's closure: a
    // hop through a second queue makes the enqueue itself racy, and a caller
    // whose `dbQueue.sync { guard let db ... }` wins the race silently no-ops
    // on `db == nil`.
    dbQueue.async { [weak self] in self?.openDatabase() }
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
    // The two extra observers below feed `_cachedApplicationState` so
    // `currentApplicationState()` never has to dispatch to main.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidBecomeActiveForStateCache),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppWillResignActiveForStateCache),
      name: UIApplication.willResignActiveNotification,
      object: nil
    )
    // Seed the cache from main without blocking init. Initial value is
    // `.active` which is the safe default for an app that's just been
    // brought up to handle a JS-side call into this Expo module.
    DispatchQueue.main.async { [weak self] in
      let state = UIApplication.shared.applicationState
      self?.updateCachedApplicationState(state)
      // LD-0002: a background launch (BGProcessingTask, background URLSession
      // events) starts with the gate closed until an assertion opens it.
      self?.executionGate.setForeground(state != .background)
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Backup Status Surfaces

  @objc private func handleAppDidEnterBackground() {
    updateCachedApplicationState(.background)
    beginBackgroundGraceIfNeeded()
    #if os(iOS)
    scheduleNextBackup()
    #endif
    updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")
    scheduleOpenAppReminderIfNeeded()
    logDiagnosticSnapshot(reason: "app_background")
    // LD-0002: the foreground gate closes only now, after the reads above. A
    // grace task that started keeps it open (its expiry quiesces). With none,
    // the app suspends right after this returns: quiesce before returning.
    executionGate.setForeground(false)
    if !executionGate.canStartSQLiteWork {
      quiesceSQLiteBeforeBackgroundTimeEnds(reason: "did-enter-background-no-grace")
    }
  }

  @objc private func handleAppWillEnterForeground() {
    // UIKit fires `didBecomeActive` shortly after; `.inactive` is the
    // accurate transitional value the cache should hold in the meantime.
    updateCachedApplicationState(.inactive)
    // LD-0002: foreground reopens the gate before anything below asks it. A
    // user's Pause is kept (B6): only `!isPaused` wakes the drain.
    executionGate.setForeground(true)
    endBackgroundGrace()
    UNUserNotificationCenter.current().removePendingNotificationRequests(
      withIdentifiers: [backupReminderIdentifier]
    )
    UNUserNotificationCenter.current().removeDeliveredNotifications(
      withIdentifiers: [backupReminderIdentifier]
    )
    if isRunning, !isPaused, pendingUploadCount() > 0 {
      wakeDrainLoop(reason: "foreground")
    }
    updateBackupStatusSurfaces(reason: "App opened")
    logDiagnosticSnapshot(reason: "app_foreground")
  }

  private func pendingUploadCount() -> Int {
    dbQueue.sync {
      guard let db = db else { return 0 }
      return countWhere(
        db: db,
        condition: "COALESCE(selected_for_backup, 1) = 1 AND status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading') AND COALESCE(retry_count, 0) < 10"
      )
    }
  }

  private func beginBatchProcessing() -> Bool {
    batchProcessingQueue.sync {
      if batchProcessingActive { return false }
      batchProcessingActive = true
      return true
    }
  }

  private func finishBatchProcessing() {
    batchProcessingQueue.sync {
      batchProcessingActive = false
    }
  }

  private func backupWorkBreakdown() -> BackupWorkBreakdown {
    dbQueue.sync {
      guard let db = db else {
        return BackupWorkBreakdown(waitingToEncrypt: 0, encryptedPendingUpload: 0, uploading: 0)
      }
      return BackupWorkBreakdown(
        waitingToEncrypt: countWhere(
          db: db,
          condition: "COALESCE(selected_for_backup, 1) = 1 AND status IN ('pending_upload', 'pending_reupload', 'staging') AND staged_file_id IS NULL AND COALESCE(retry_count, 0) < 10"
        ),
        encryptedPendingUpload: countWhere(
          db: db,
          condition: "COALESCE(selected_for_backup, 1) = 1 AND status = 'staged_upload' AND staged_file_id IS NOT NULL AND COALESCE(retry_count, 0) < 10"
        ),
        uploading: countWhere(
          db: db,
          condition: "COALESCE(selected_for_backup, 1) = 1 AND status = 'uploading' AND COALESCE(retry_count, 0) < 10"
        )
      )
    }
  }

  private func backupStatusCounts() -> [String: Int] {
    var counts: [String: Int] = [
      "pending_upload": 0,
      "staging": 0,
      "staged_upload": 0,
      "uploading": 0,
      "uploaded": 0,
      "pending_delete": 0,
      "pending_reupload": 0,
      "orphaned": 0,
      "remote_deleted": 0,
      "failed": 0,
      "local_missing": 0,
      "waiting_storage": 0,
      "waiting_unlock": 0,
      "waiting_wifi": 0,
      "failed_retryable": 0,
      "failed_terminal": 0,
    ]

    dbQueue.sync {
      guard let db = db else { return }
      var stmt: OpaquePointer?
      let sql = "SELECT status, COUNT(*) FROM backup_assets WHERE COALESCE(selected_for_backup, 1) = 1 GROUP BY status"
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      defer { exsqlite3_finalize(stmt) }
      while exsqlite3_step(stmt) == SQLITE_ROW {
        guard let statusPointer = exsqlite3_column_text(stmt, 0) else { continue }
        let status = String(cString: statusPointer)
        counts[status] = Int(exsqlite3_column_int(stmt, 1))
      }
      counts["failed_retryable"] = countWhere(db: db, condition: "COALESCE(selected_for_backup, 1) = 1 AND status = 'failed' AND COALESCE(retry_count, 0) < 10")
      counts["failed_terminal"] = countWhere(db: db, condition: "COALESCE(selected_for_backup, 1) = 1 AND COALESCE(retry_count, 0) >= 10")
    }

    return counts
  }

  private func backupUploadChunkStatusCounts() -> [String: Int] {
    var counts: [String: Int] = [
      "pending": 0,
      "uploading": 0,
      "uploaded": 0,
      "failed": 0,
    ]

    dbQueue.sync {
      guard let db = db else { return }
      var stmt: OpaquePointer?
      let sql = "SELECT status, COUNT(*) FROM backup_upload_chunks GROUP BY status"
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      defer { exsqlite3_finalize(stmt) }
      while exsqlite3_step(stmt) == SQLITE_ROW {
        guard let statusPointer = exsqlite3_column_text(stmt, 0) else { continue }
        let status = String(cString: statusPointer)
        counts[status] = Int(exsqlite3_column_int(stmt, 1))
      }
    }

    return counts
  }

  private func photoKitMissingCount() -> Int {
    dbQueue.sync {
      guard let db = db else { return 0 }
      return countWhere(
        db: db,
        condition: "status = 'local_missing' OR error_message LIKE '%Photo asset not found%' OR error_message LIKE '%not found in library%'"
      )
    }
  }

  private func applicationStateString() -> String {
    switch currentApplicationState() {
    case .active:
      return "active"
    case .inactive:
      return "inactive"
    case .background:
      return "background"
    @unknown default:
      return "unknown"
    }
  }

  private func photoAuthorizationStatusString() -> String {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .notDetermined:
      return "notDetermined"
    case .restricted:
      return "restricted"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    case .limited:
      return "limited"
    @unknown default:
      return "unknown"
    }
  }

  private func diagnosticAvailableBytes() -> Int64 {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
          let available = values.volumeAvailableCapacityForImportantUsage else {
      return 0
    }
    return Int64(available)
  }

  private func diagnosticStagedBytesOnDisk() -> Int64 {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let root = base.appendingPathComponent(stagedBackupDirectoryName, isDirectory: true)
    guard FileManager.default.fileExists(atPath: root.path),
          let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
          ) else { return 0 }

    var total: Int64 = 0
    for case let fileURL as URL in enumerator {
      let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      total += Int64(size)
    }
    return total
  }

  func diagnosticSnapshot() -> [String: Any] {
    let progress = currentProgress()
    let pending = progress["pending"] as? Int ?? pendingUploadCount()
    let state = backupState(pending: pending)
    let freeBytes = diagnosticAvailableBytes()

    #if os(iOS)
    let networkAvailable = isNetworkAvailable
    #else
    let networkAvailable = true
    #endif

    return [
      "timestamp": isoString(from: Date()),
      "appState": applicationStateString(),
      "backup": [
        "publicState": state.state,
        "reason": state.reason,
        "isRunning": isRunning,
        "isPaused": isPaused,
        "drainTaskActive": drainTask != nil,
        "backgroundTaskActive": isBackgroundTaskActive,
        "backgroundGraceActive": isBackgroundGraceActive,
        "photoObserverRegistered": photoObserverRegistered,
        "pendingDrainWakeReason": jsonValue(pendingDrainWakeReason),
        "networkAvailable": networkAvailable,
        "backoffUntil": jsonValue(backoffUntil.map { isoString(from: $0) }),
        "consecutiveFailures": consecutiveFailures,
        "pacingMode": currentPacingMode().rawValue,
        "canRunNow": canExecuteBackupWorkNow(),
        "masterKeyHandleCached": masterKeyHandle != nil,
        "masterKeyBridgeCached": BeebeebCryptoBridge.hasCachedMasterKey(),
        "tokenConfigured": token?.isEmpty == false,
        "apiBaseUrlConfigured": apiBaseUrl?.isEmpty == false,
        "freeBytesAvailable": freeBytes,
        "minimumFreeBytesAfterStaging": minimumFreeBytesAfterStaging,
        "maxStagedBackupBytes": maxStagedBackupBytes,
        "stagedBytesOnDisk": diagnosticStagedBytesOnDisk(),
      ],
      "progress": progress,
      "queue": backupStatusCounts(),
      "uploadChunks": backupUploadChunkStatusCounts(),
      "photoKit": [
        "authorizationStatus": photoAuthorizationStatusString(),
        "currentFetchCount": jsonValue(currentFetchResult?.count),
        "missingCount": photoKitMissingCount(),
      ],
    ]
  }

  func logDiagnosticSnapshot(reason: String) {
    var snapshot = diagnosticSnapshot()
    snapshot["reason"] = reason
    if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
      NSLog("[BeebeebDiagnostics] backup.snapshot \(json)")
    } else {
      NSLog("[BeebeebDiagnostics] backup.snapshot_failed reason=\(reason)")
    }
  }

  private func latestUploadedAt() -> String? {
    dbQueue.sync {
      guard let db = db else { return nil }
      var stmt: OpaquePointer?
      let sql = "SELECT uploaded_at FROM backup_assets WHERE uploaded_at IS NOT NULL ORDER BY uploaded_at DESC LIMIT 1"
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
      defer { exsqlite3_finalize(stmt) }
      guard exsqlite3_step(stmt) == SQLITE_ROW, exsqlite3_column_type(stmt, 0) != SQLITE_NULL else {
        return nil
      }
      return String(cString: exsqlite3_column_text(stmt, 0))
    }
  }

  /// Round 13 (review of mobile#182 at a19037f9, item 6): decided by
  /// `BackupSurfaceState` (the rules moved there unchanged), which also
  /// keeps the server-check pause on every surface and every update.
  /// `uploading`: a count the caller already has (LD-0002: the status
  /// payload's, which may be the cached one); nil reads it when needed.
  private func backupState(pending: Int, uploading knownUploading: Int? = nil) -> (state: String, reason: String) {
    if isPaused, let reason = fileLimitStopReason {
      return ("pausedByUser", reason)
    }
    var networkAvailable = true
    #if os(iOS)
    networkAvailable = isNetworkAvailable
    #endif
    let decided = BackupSurfaceState.decide(BackupSurfaceState.Inputs(
      manifestUnavailableReason: manifestUnavailableStopReason,
      serverCheckPause: serverCheckPauseSurface,
      isPaused: isPaused,
      pending: pending,
      canExecuteNow: canExecuteBackupWorkNow(),
      isRunning: isRunning,
      failed: failedAssets,
      inProgress: inProgressAssets,
      networkAvailable: networkAvailable,
      total: totalAssets,
      uploading: { knownUploading ?? self.backupWorkBreakdown().uploading }
    ))
    return (decided.state, decided.reason)
  }

  private func makeBackupStatusPayload(reason explicitReason: String? = nil) -> BackupStatusPayload? {
    guard let counts = statusCounts() else { return nil }
    let pending = counts.pending
    let breakdown = counts.breakdown
    let state = backupState(pending: pending, uploading: breakdown.uploading)
    let now = isoString(from: Date())
    return BackupStatusPayload(
      total: totalAssets,
      completed: completedAssets,
      pending: pending,
      waitingToEncrypt: breakdown.waitingToEncrypt,
      encryptedPendingUpload: breakdown.encryptedPendingUpload,
      uploading: breakdown.uploading,
      inProgress: inProgressAssets,
      failed: failedAssets,
      bytesUploaded: bytesUploaded,
      bytesTotal: bytesTotal,
      state: state.state,
      reason: (isPaused ? fileLimitStopReason : nil) ?? explicitReason ?? state.reason,
      lastBackupAt: counts.lastBackupAt,
      lastChangeAt: now,
      updatedAt: now
    )
  }

  /// LD-0002 (B1, P2a): the counts for the status surfaces. Read fresh only
  /// while the gate is open, and kept only when no expiry closed it during the
  /// reads (an interrupted step reads as 0). Otherwise the last good counts:
  /// an expiry handler builds its payload without touching SQLite. nil = no
  /// good read yet in this process (a background launch): nothing is known,
  /// so nothing may be published as "0 pending" (#262 review 6).
  private func statusCounts() -> BackupStatusCounts? {
    let fresh = executionGate.readIfUninterrupted { () -> BackupStatusCounts in
      refreshProgress()
      return BackupStatusCounts(
        pending: pendingUploadCount(),
        breakdown: backupWorkBreakdown(),
        lastBackupAt: latestUploadedAt()
      )
    }
    if let fresh {
      lastStatusCounts = fresh
      return fresh
    }
    return lastStatusCounts
  }

  private func updateBackupStatusSurfaces(reason: String? = nil) {
    // LD-0002 (#262 review 6): no good read yet and the gate closed: keep
    // whatever the surfaces show rather than overwrite them with zeros.
    guard let payload = makeBackupStatusPayload(reason: reason) else { return }
    writeBackupStatus(payload)
    updateLiveActivity(payload)
    emitBackupHeartbeat(payload: payload)
    // LD-0002 (#262 review 10): only while background time is still ours.
    // Inside an expiry handler (gate closed) the handler ends the grace task
    // itself, as its last step; ending it here ran a second quiesce first.
    if payload.pending == 0, executionGate.canStartSQLiteWork {
      endBackgroundGrace()
    }
  }

  private func heartbeatStatus(for payload: BackupStatusPayload) -> String {
    // Round 13 (item 6): `BackupSurfaceState` (the server-check pause is "paused").
    BackupSurfaceState.heartbeatStatus(
      state: payload.state, isRunning: isRunning, failed: payload.failed, pending: payload.pending
    )
  }

  private func makeSafeCurrentFile(payload: BackupStatusPayload, status: String) -> String? {
    guard status == "syncing", payload.total > 0 else { return nil }
    let current = min(payload.total, max(1, payload.completed + max(1, payload.uploading)))
    return "Uploading photo \(current)/\(payload.total)"
  }

  private func emitBackupHeartbeat(payload: BackupStatusPayload) {
    guard let authToken = token, !authToken.isEmpty,
          let baseURL = apiBaseUrl, !baseURL.isEmpty,
          let sessionId = backupClientSessionId, !sessionId.isEmpty else { return }

    let status = heartbeatStatus(for: payload)
    heartbeatQueue.async { [weak self] in
      guard let self else { return }
      let now = Date()
      let statusChanged = self.lastHeartbeatStatus != status
      let elapsed = self.lastHeartbeatSentAt.map { now.timeIntervalSince($0) } ?? .infinity
      guard statusChanged || elapsed >= backupHeartbeatCadenceSeconds else { return }

      let transferBytes = max(payload.bytesUploaded, self.bytesTransferProgress)
      let metricElapsed = self.lastHeartbeatMetricAt.map { now.timeIntervalSince($0) } ?? 0
      let byteDelta = transferBytes - self.lastHeartbeatBytesSynced
      if metricElapsed > 0, byteDelta > 0 {
        self.lastKnownSpeedBps = max(0, Int64(Double(byteDelta) / metricElapsed))
      } else if status != "syncing" {
        self.lastKnownSpeedBps = 0
      }

      self.lastHeartbeatSentAt = now
      self.lastHeartbeatStatus = status
      self.lastHeartbeatMetricAt = now
      self.lastHeartbeatBytesSynced = transferBytes

      let heartbeat = BackupHeartbeatPayload(
        status: status,
        filesSynced: payload.completed,
        filesTotal: payload.total,
        bytesSynced: payload.bytesUploaded,
        bytesTotal: payload.bytesTotal,
        currentFile: self.makeSafeCurrentFile(payload: payload, status: status),
        speedBps: self.lastKnownSpeedBps,
        detail: payload.reason
      )

      // Task 1599: a live read, not a batch snapshot — this heartbeat fires
      // from general status updates, not only from inside an active upload
      // batch, so there is no `batchAccountId` in scope here. `nil`/empty
      // (no confirmed owner yet, e.g. between sign-in and the first
      // `enablePhotoBackup`) simply omits the header, same as every other
      // reader of `currentAccountId` treats an empty value pre-1599.
      let accountId = self.currentAccountId ?? ""
      Task.detached(priority: .utility) { [weak self] in
        await self?.postBackupHeartbeat(
          heartbeat,
          authToken: authToken,
          baseURL: baseURL,
          sessionId: sessionId,
          accountId: accountId
        )
      }
    }
  }

  private func postBackupHeartbeat(
    _ payload: BackupHeartbeatPayload,
    authToken: String,
    baseURL: String,
    sessionId: String,
    accountId: String
  ) async {
    guard let url = URL(string: "\(baseURL)/api/v1/clients/sessions/\(sessionId)/heartbeat") else {
      NSLog("[NativeBackupEngine] Backup heartbeat skipped: invalid server URL")
      return
    }

    let currentFileValue: Any = payload.currentFile ?? NSNull()
    let body: [String: Any] = [
      "status": payload.status,
      "files_synced": payload.filesSynced,
      "files_total": payload.filesTotal,
      "bytes_synced": payload.bytesSynced,
      "bytes_total": payload.bytesTotal,
      "current_file": currentFileValue,
      "speed_bps": payload.speedBps,
      "detail": payload.detail,
    ]

    guard JSONSerialization.isValidJSONObject(body),
          let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
      NSLog("[NativeBackupEngine] Backup heartbeat skipped: JSON encoding failed")
      return
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = bodyData

    do {
      let (data, response) = try await metadataSession.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(statusCode) else {
        if statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
          handleConfirmedAccountMismatch()
          NSLog("[NativeBackupEngine] Backup heartbeat refused: account mismatch")
          return
        }
        let body = String(data: data, encoding: .utf8) ?? ""
        NSLog("[NativeBackupEngine] Backup heartbeat failed status=\(statusCode) body=\(body)")
        return
      }
    } catch {
      NSLog("[NativeBackupEngine] Backup heartbeat failed: \(error.localizedDescription)")
    }
  }

  private func writeBackupStatus(_ payload: BackupStatusPayload) {
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: backupAppGroupIdentifier
    ) else { return }

    let url = container.appendingPathComponent(backupStatusFileName)
    do {
      let data = try JSONEncoder().encode(payload)
      try data.write(to: url, options: .atomic)
      WidgetCenter.shared.reloadTimelines(ofKind: "io.beebeeb.widget.storage")
    } catch {
      NSLog("[NativeBackupEngine] Failed to write backup status: \(error.localizedDescription)")
    }
  }

  private func scheduleOpenAppReminderIfNeeded() {
    guard let payload = makeBackupStatusPayload() else { return }
    guard payload.pending > 0, payload.state == "waitingForAppOpen" else { return }
    guard UserDefaults.standard.object(forKey: "io.beebeeb.backupNotifications.actionNeeded") as? Bool ?? true else {
      return
    }
    if #available(iOS 16.1, *), !Activity<BeebeebBackupActivityAttributes>.activities.isEmpty {
      UNUserNotificationCenter.current().removePendingNotificationRequests(
        withIdentifiers: [backupReminderIdentifier]
      )
      return
    }

    let now = Date()
    let lastSent = UserDefaults.standard.object(forKey: backupReminderLastSentKey) as? Date
    if let lastSent, now.timeIntervalSince(lastSent) < backupReminderCooldownSeconds {
      return
    }

    let content = UNMutableNotificationContent()
    content.title = "Open Beebeeb to continue backup"
    let label = payload.pending == 1 ? "1 photo is" : "\(payload.pending) photos are"
    content.body = "\(label) waiting to be encrypted and uploaded."
    content.sound = nil
    content.userInfo = [
      "url": "beebeeb://settings",
      "category": "backup_action_needed"
    ]

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: backupReminderDelaySeconds, repeats: false)
    let request = UNNotificationRequest(identifier: backupReminderIdentifier, content: content, trigger: trigger)
    UNUserNotificationCenter.current().add(request) { error in
      if let error {
        NSLog("[NativeBackupEngine] Failed to schedule open-app reminder: \(error.localizedDescription)")
      } else {
        UserDefaults.standard.set(now, forKey: backupReminderLastSentKey)
      }
    }
  }

  private func beginLiveActivityRequestIfIdle() -> Bool {
    liveActivityRequestQueue.sync {
      if liveActivityRequestInFlight {
        return false
      }
      liveActivityRequestInFlight = true
      return true
    }
  }

  private func finishLiveActivityRequest() {
    liveActivityRequestQueue.sync {
      liveActivityRequestInFlight = false
    }
  }

  private func updateLiveActivity(_ payload: BackupStatusPayload) {
    guard #available(iOS 16.1, *) else { return }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

    let contentState = BeebeebBackupActivityAttributes.ContentState(
      total: payload.total,
      completed: payload.completed,
      pending: payload.pending,
      waitingToEncrypt: payload.waitingToEncrypt,
      encryptedPendingUpload: payload.encryptedPendingUpload,
      uploading: payload.uploading,
      failed: payload.failed,
      state: payload.state,
      reason: payload.reason,
      updatedAt: Date()
    )

    Task {
      let activities = Activity<BeebeebBackupActivityAttributes>.activities
      let shouldKeepVisible = payload.pending > 0 || payload.inProgress > 0
      if shouldKeepVisible && payload.total > 0 {
        if let activity = activities.first {
          await activity.update(using: contentState)
          for extra in activities.dropFirst() {
            await extra.end(using: contentState, dismissalPolicy: .immediate)
          }
        } else {
          if !beginLiveActivityRequestIfIdle() {
            return
          }
          defer {
            finishLiveActivityRequest()
          }

          let recheckedActivities = Activity<BeebeebBackupActivityAttributes>.activities
          if let activity = recheckedActivities.first {
            await activity.update(using: contentState)
            for extra in recheckedActivities.dropFirst() {
              await extra.end(using: contentState, dismissalPolicy: .immediate)
            }
            return
          }

          do {
            _ = try Activity.request(
              attributes: BeebeebBackupActivityAttributes(startedAt: Date()),
              contentState: contentState,
              pushType: nil
            )
          } catch {
            NSLog("[NativeBackupEngine] Failed to start backup Live Activity: \(error.localizedDescription)")
          }
        }
      } else {
        for activity in activities {
          await activity.end(using: contentState, dismissalPolicy: .immediate)
        }
      }
    }
  }

  // MARK: - URLSession Setup

  private func setupBackgroundSession() {
    let config = URLSessionConfiguration.background(withIdentifier: Self.bgSessionIdentifier)
    // Task 1962 round 4 (Bug 6d): the background session keeps no response
    // cache (default is URLCache.shared, which holds another account's rows).
    config.urlCache = nil
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = true // Respect user's wifiOnly setting separately
    config.timeoutIntervalForResource = 60 * 60 // 1 hour for large files
    config.httpMaximumConnectionsPerHost = 3
    backgroundSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  /// Cancel background-session upload tasks left over from a prior app launch.
  ///
  /// Background sessions persist their tasks across launches; nsurlsessiond
  /// resurrects them out-of-process. But `chunkUploadContinuations` /
  /// `uploadTaskMap` are in-memory only, so after relaunch NOTHING is awaiting
  /// these tasks and the engine has no record of them. The drain loop then
  /// re-stages the same asset (resolveStagedChunks → re-PUT) and, on a re-stage,
  /// deletes the staged `.enc` the orphaned task is still trying to read. The
  /// daemon opens the chunk PUT, finds a deleted/replaced source file, and sends
  /// 0 body bytes — the 0-byte stall. (The v2 408 fail-fast now bounds the blast
  /// radius to ~90s, but cancelling the orphan removes the cause outright.)
  ///
  /// Reattaching to the persistent session (in `setupBackgroundSession`) revives
  /// these tasks; here we proactively cancel every one of them exactly once at
  /// launch, BEFORE the first drain can re-stage/delete anything. Their chunk
  /// rows remain in `uploading` and are reset to `pending` by the existing
  /// `recoverStuckUploads()` (which runs at the top of every drain), so each
  /// affected chunk is cleanly re-driven in-process with a fresh task whose
  /// continuation we actually hold. No data is lost — the staged `.enc` files
  /// in Application Support are untouched.
  private func reconcileOrphanedBackgroundTasks() {
    backgroundSession.getAllTasks { [weak self] tasks in
      guard let self else { return }
      guard !tasks.isEmpty else { return }
      var cancelled = 0
      for task in tasks {
        // At launch the continuation map is always empty, so every task here is
        // a prior-launch orphan. Guard on the map anyway to stay correct if this
        // is ever called later in a session.
        if self.chunkUploadContinuations[task.taskIdentifier] == nil {
          task.cancel()
          cancelled += 1
        }
      }
      if cancelled > 0 {
        NSLog("[NativeBackupEngine] Cancelled \(cancelled) orphaned background upload task(s) from a prior launch")
      }
    }
  }

  private func setupMetadataSession() {
    let config = URLSessionConfiguration.default
    // Task 1962 round 4 (Bug 6d): the metadata session keeps no response cache.
    config.urlCache = nil
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 60
    metadataSession = URLSession(configuration: config)
  }

  // MARK: - Account binding

  /// Task 1531 [P0] round 5 (delta security review, finding P1-A): the
  /// single engine-owned entry point every "backup is now authorized for
  /// THIS account" call must funnel through. Before this method existed,
  /// `enablePhotoBackup` wrote `currentAccountId = userId` directly (and
  /// relied on `start()`'s own purge), while `enableContactsBackup` /
  /// `enableCalendarBackup` never touched `currentAccountId` at all — only
  /// `ContactsBackupManager`/`CalendarBackupManager`'s own PRIVATE
  /// `accountId` var. `NativeEncryptedBackupUploader.requireAccountBinding`
  /// reads ONLY this engine's `currentAccountId` (see that file), so a
  /// Contacts-only user (Camera Roll backup never enabled) had
  /// `currentAccountId == nil` forever and every Contacts/Calendar upload
  /// refused with `.accountMismatch` — "Contacts/Calendar never back up
  /// unless Camera Roll backup is on".
  ///
  /// Idempotent when `userId` already matches the stored account (the
  /// common case: re-enabling the same surface, or a second manual trigger
  /// mid-session) — it does nothing, so the in-memory `masterKeyHandle`
  /// stays warm and no redundant purge sweep runs. On an actual account
  /// change (including the very first bind, where the stored value is
  /// nil):
  ///   1. purge every staged-but-unuploaded asset whose `staged_account_id`
  ///      doesn't (yet) match `userId` — reuses `purgeMismatchedStagedAssets`,
  ///      the SAME sweep `start()` runs on its own account guard, so a
  ///      `bindAccount` immediately followed by `start()` (as
  ///      `enablePhotoBackup` now does) makes the second sweep a cheap
  ///      single-query no-op;
  ///   2. persists the new account id (bumps `accountGeneration` — see its
  ///      setter — only because this IS a real change);
  ///   3. drops the cached `masterKeyHandle` (closes P2-D): a handle warmed
  ///      for the PREVIOUS account must never be reused to encrypt/stage a
  ///      byte under the new one.
  ///
  /// Must NOT be called from `dbQueue` — it calls `dbQueue.sync` itself.
  ///
  /// Task 1531 [P2] round 6 (delta review 3, finding N4): the
  /// `currentAccountId != userId` check and the `currentAccountId = userId`
  /// write below are NOT wrapped in a single critical section — the getter
  /// takes no lock at all (only the setter takes `accountIdLock`, and only
  /// around its own compare-and-write), so this method's check-then-set is
  /// not atomic against a concurrent caller on its own. That is safe today
  /// ONLY because every call site is reached from an Expo `AsyncFunction`
  /// closure (`enablePhotoBackup`/`enableContactsBackup`/
  /// `enableCalendarBackup`/`resumeContactsBackup`/`resumeCalendarBackup` in
  /// BeebeebCryptoModule.swift, or `ContactsBackupManager.enable`/
  /// `CalendarBackupManager.enable` called synchronously from inside one of
  /// those) — Expo Modules dispatches `AsyncFunction` bodies one at a time,
  /// in call order, on a single serial queue (see the round-6 finding this
  /// note documents, N1: `stopBackupEngines`'s `disablePhotoBackup` vs.
  /// `disableContactsBackup`/`disableCalendarBackup` race analysis relies
  /// on the SAME guarantee). If a future call site ever invokes
  /// `bindAccount` from anywhere OTHER than that serial queue (a
  /// `BGProcessingTask` handler, a raw `DispatchQueue.global` hop, etc.),
  /// this check-then-set becomes a real TOCTOU race and must be wrapped
  /// under `accountIdLock` (using a re-entrant lock, since the
  /// `currentAccountId` setter already acquires the same lock internally —
  /// a plain `NSLock` here would deadlock).
  func bindAccount(userId: String) {
    guard !userId.isEmpty else { return }
    // Task 1667 round 8: the JS-confirmed sign-in is the ONE place the
    // manifest write fence is bound (and, after a sign-out reset, unsealed).
    // A different account is a new generation, so a producer that started
    // for the previous account can no longer write. Same Expo serial-queue
    // ordering as the rest of this method (see the doc comment above): a
    // bind queued before a sign-out runs before its reset, never after.
    dbQueue.sync { manifestHandle.writeFence.bind(accountId: userId) }
    // Task 1667: before anything reads "already uploaded" for this account —
    // adopt pre-column rows, re-queue another account's. Runs for a re-bind
    // of the SAME account too (a relaunch keeps `currentAccountId` in the
    // Keychain), so an upgraded install adopts its rows on the first bind.
    claimManifest(forAccount: userId)
    // Round 5: kept marks of ANY account older than 30 days go at every bind
    // (Codex P2), whatever this account holds.
    expireKeptPendingMarks(trigger: "bind")
    guard currentAccountId != userId else { return }
    dbQueue.sync { purgeMismatchedStagedAssets(currentAccountId: userId) }
    currentAccountId = userId
    masterKeyHandle = nil
    // Task 1599 followups round 2 review (P2): `accountMismatchStopReason`
    // used to be cleared HERE — but `bindAccount` runs on every
    // `enablePhotoBackup`/`triggerImmediateBackup` ("Back up now") call, not
    // only on a genuine new sign-in. After a confirmed mismatch sets
    // `currentAccountId = nil` (`handleConfirmedAccountMismatch`), the VERY
    // NEXT `bindAccount(userId:)` call — even one made with the SAME
    // still-unlocked JS session tapping "Back up now", no new authentication
    // at all — is a `nil -> userId` transition and would have cleared the
    // sticky reason right here, silently defeating the "sign in again to
    // resume" promise the UI makes (`SettingsScreen.tsx`'s
    // `cameraRollSummary`). The clear now lives ONLY in
    // `BeebeebCryptoModule.swift`'s `confirmMasterKeyHandle`, which is
    // reached exclusively from `crypto-context.tsx`'s `unlock()` — an actual
    // phrase/keychain authentication event, never a bare enable/trigger call.
    // Task 1531 [P2] round 6 (finding N6): `RuntimeTrace.sanitize` redacts
    // token/password/secret/key/cipher-/plaintext-named fields but NOT
    // "userId" — the raw account id was landing unredacted in the on-device
    // log (NSLog + os.log, always-on in DEBUG). Hash it, same SHA-256 hex
    // pattern as `ContactsBackupManager.hashKey`/
    // `CalendarBackupManager.stateKeyComponent`: still useful to correlate
    // repeated binds for the SAME account across trace events, without
    // logging the id itself.
    let hashedUserId = SHA256.hash(data: Data(userId.utf8)).map { String(format: "%02x", $0) }.joined()
    RuntimeTrace.event("backup.native.bind_account", ["userIdHash": hashedUserId])
  }

  /// Drop the engine's OWN cached `MasterKeyHandle` without touching
  /// `BeebeebCryptoBridge`'s separate app-wide cache (that one has its own
  /// lifecycle — sign-out / `releaseHandle` — and callers that need to
  /// invalidate it use `BeebeebCryptoBridge.clearCachedMasterKey()`
  /// directly). Exposed for call sites that must invalidate the engine's
  /// copy WITHOUT going through `bindAccount` or
  /// `clearAccountAndPurgeStaged` — task 1531 [P1] round 5:
  /// `mirrorSessionToAppGroup`'s token-changed branch in
  /// BeebeebCryptoModule.swift, where a brand-new login token arrives with
  /// no `userId` to bind to yet.
  func dropCachedMasterKeyHandle() {
    masterKeyHandle = nil
  }

  /// Task 1599 [P1]: the server's 409 `account_mismatch` fired for a request
  /// THIS engine built — the session's real account no longer matches the
  /// `X-Beebeeb-Expected-User` it sent (the account `currentAccountId`
  /// believed it was authorized for at request-build time). This is the
  /// server confirming exactly the race `X-Beebeeb-Expected-User` exists to
  /// catch (task 1594): the engine's belief about its signed-in account and
  /// the session's actual JWT diverged AFTER whatever ownership verdict last
  /// unlocked it — every other native upload surface
  /// (`NativeEncryptedBackupUploader`, `ApiClient`/File Provider, the Share
  /// Extension) already reacts to this exact signal.
  ///
  /// `stop()` cancels the drain loop and unregisters observers so no OTHER
  /// queued asset uploads under the same now-proven-wrong belief; dropping
  /// the cached handle means a fresh `confirmMasterKeyHandle` from JS (a
  /// fresh ownership verdict) is required before this engine uploads again.
  /// Traced with NO account id and NO key material — only that the event
  /// happened. Safe to call more than once (`stop()`,
  /// `dropCachedMasterKeyHandle()`, and `BeebeebCryptoBridge
  /// .clearCachedMasterKey()` are all idempotent).
  ///
  /// Task 1599 followup 2: this engine believed it was authorized for
  /// `currentAccountId` — the server just proved that belief wrong. Beyond
  /// dropping this engine's OWN handle copy (`dropCachedMasterKeyHandle`,
  /// pre-existing), the fix also:
  ///   - clears `currentAccountId` itself: leaving the disproven account id
  ///     in place would let a background relaunch's `start()` (which reads
  ///     it to decide what to do — see that function) re-adopt the exact
  ///     belief that was just disproven, straight from the Keychain, with no
  ///     new ownership check in between.
  ///   - clears `BeebeebCryptoBridge`'s APP-WIDE cache too, not just this
  ///     engine's own copy — `NativeEncryptedBackupUploader` and
  ///     `ThumbnailServiceModule` read that cache directly, bypassing this
  ///     engine entirely, and would otherwise keep using a handle this
  ///     engine's own server round-trip just proved doesn't match the live
  ///     session.
  ///   - records an honest, user-facing reason (`accountMismatchStopReason`)
  ///     so `currentProgress()` — which `backup-context.tsx` already polls —
  ///     can tell Settings WHY backup stopped, not just that it did. Cleared
  ///     only via `clearAccountMismatchStopReasonOnNewAuthentication()` — see
  ///     that method's doc comment for why `bindAccount` is NOT the right
  ///     place (task 1599 followups round 2 review, P2).
  private func handleConfirmedAccountMismatch() {
    RuntimeTrace.event("backup.native.account_mismatch_confirmed")
    dropCachedMasterKeyHandle()
    stop()
    currentAccountId = nil
    BeebeebCryptoBridge.clearCachedMasterKey()
    accountMismatchStopReason = Self.accountMismatchStopReasonMessage
    // Task 1599 followups round 3 (P1): bump BEFORE/alongside the reason
    // write — JS's baseline comparison only needs "strictly greater than
    // whatever generation was already active when it started polling", so
    // ordering relative to the reason write above doesn't matter, only that
    // both land before the next `currentProgress()` read observes either.
    accountMismatchGeneration += 1
  }

  /// Clears a sticky `accountMismatchStopReason` left by a previous confirmed
  /// mismatch. Call ONLY from a genuine new-authentication choke point.
  ///
  /// Task 1599 followups round 2 review (P2): this used to be cleared
  /// unconditionally inside `bindAccount(userId:)` — but `bindAccount` runs
  /// on every `enablePhotoBackup` AND every `triggerImmediateBackup`
  /// ("Back up now") call, not only on a fresh sign-in. After
  /// `handleConfirmedAccountMismatch` sets `currentAccountId = nil`, the very
  /// NEXT `bindAccount` call — even one from the user tapping "Back up now"
  /// on the SAME still-unlocked JS session, no new authentication at all —
  /// is a `nil -> userId` transition, and clearing the reason right there
  /// silently dismissed the "sign in again to resume" message the UI had
  /// just shown, without the user actually signing in again. The ONLY
  /// correct call site is `BeebeebCryptoModule.swift`'s
  /// `confirmMasterKeyHandle`, reached exclusively from
  /// `crypto-context.tsx`'s `unlock()` — an actual phrase/keychain
  /// authentication event.
  func clearAccountMismatchStopReasonOnNewAuthentication() {
    accountMismatchStopReason = nil
  }

  /// Sibling clear for `ownerUnconfirmedStopReason` (task 1599 followups
  /// round 3, P2) — same "genuine new-authentication choke point only" rule
  /// as `clearAccountMismatchStopReasonOnNewAuthentication()` above, called
  /// from the same call sites. `start()` also clears this reason itself,
  /// on its OWN successful run, independent of any new authentication —
  /// see that call site.
  func clearOwnerUnconfirmedStopReasonOnNewAuthentication() {
    ownerUnconfirmedStopReason = nil
  }

  /// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): the server
  /// confirmed — on a request THIS engine sent — that this account cannot
  /// store data right now for a BILLING reason (never-paid trial cancelled
  /// before its first charge, lapsed trial/plan, or no plan at all;
  /// `code` is one of `AccountRefusalDetection.knownRefusalCodes`).
  ///
  /// Deliberately NARROWER than `handleConfirmedAccountMismatch()`: this IS
  /// the right account — the session and the master key are both still
  /// correct — so there is nothing to drop and no reason to force a fresh
  /// sign-in. `pause()` (not `stop()`) leaves `isRunning`, the upload
  /// queue, and every asset's `retry_count` untouched; only the drain loop
  /// stops picking up new work until the next `start()` call clears
  /// `accountRefusalStopReason` (see that property's doc comment for the
  /// resume path and why clearing unconditionally is safe).
  ///
  /// Call sites keep the ASSET's own queue position too — see the
  /// `catch BackupError.accountRefused` clause in `uploadSingleAsset`, which
  /// calls `markPending` (never `markFailed`) so this one asset's
  /// `retry_count` is not spent on a reason that has nothing to do with it.
  private func handleConfirmedAccountRefusal(code: String) {
    RuntimeTrace.event("backup.native.account_refused", ["code": code])
    accountRefusalStopReason = Self.accountRefusalStopReasonMessage(for: code)
    pause()
  }

  /// Sibling for the 413 `quota_exceeded` + `is_trial_cap: true` case — same
  /// pause-and-keep-queue recovery as `handleConfirmedAccountRefusal` above,
  /// distinct reason text (no account-state transition is coming; the
  /// account just needs to free up space, unlike the three codes above which
  /// resolve when the account state changes).
  private func handleConfirmedTrialCapExceeded(message: String) {
    RuntimeTrace.event("backup.native.trial_cap_exceeded")
    accountRefusalStopReason = message
    pause()
  }

  /// Contacts/calendar share the account-level pause and UI reason with photos.
  var accountUploadRefused: Bool { accountRefusalStopReason != nil }

  func recordAuxiliaryAccountRefusal(statusCode: Int, body: Data, accountId: String) {
    guard !accountId.isEmpty, currentAccountId == accountId else { return }
    if statusCode == 409, let code = AccountRefusalDetection.accountRefusalCode(body) {
      handleConfirmedAccountRefusal(code: code)
    } else if statusCode == 413, AccountRefusalDetection.isTrialCapQuotaExceeded(body) {
      handleConfirmedTrialCapExceeded(message: AccountRefusalDetection.trialCapMessage(
        limitBytes: AccountRefusalDetection.trialCapLimitBytes(body)
      ))
    }
  }

  func clearAuxiliaryAccountRefusal(accountId: String) {
    guard !accountId.isEmpty, currentAccountId == accountId else { return }
    let wasRefused = accountRefusalStopReason != nil
    accountRefusalStopReason = nil
    // An auxiliary retry clears the shared signal, so release its camera pause
    // too. Never start camera backup when only contacts/calendar are enabled.
    if wasRefused && isRunning { resume() }
  }

  // MARK: - Lifecycle

  /// Start the backup engine. Loads the master key from keychain, registers
  /// the photo library observer, and begins draining the upload queue.
  ///
  /// Task 1531 [P0] round 3 (lead review): refuses outright — no master-key
  /// load, no purge, no drain — when `currentAccountId` is nil/empty. Without
  /// a known account there is nothing to tag a newly-staged asset with or
  /// compare an already-staged one against, so `purgeMismatchedStagedAssets`
  /// itself already no-ops on a nil accountId (see its guard) — starting
  /// anyway would have skipped the purge sweep and let `processBatch` reach
  /// `uploadSingleAsset` with no account to check against. The queue is left
  /// untouched (not failed, not cleared) so a subsequent `enablePhotoBackup`
  /// call — which sets `currentAccountId` immediately before calling this —
  /// picks the same pending rows back up.
  ///
  /// Task 1667 round 11 (review finding 3): the user's start. It records that
  /// the user wants backup running and runs the whole start as ONE
  /// transition of `lifecycle`: a `stop()` / `disablePhotoBackup` / sign-out
  /// on another queue either finished before it or waits until it is done,
  /// and the manifest-open retry runs the same body only while that intent
  /// is still set (`scheduleManifestOpenRetry`).
  ///
  /// Round 12 (review item 8): the master key is loaded OUTSIDE that
  /// transition (`prepareStartMasterKey`; the keychain read can show a Face ID
  /// prompt), and `startLocked` re-validates it inside. Before, the lock was
  /// held across the prompt, and every scan's `acceptFetchResult` and a
  /// sign-out's `stop()` waited for the user to answer it.
  func start() {
    lifecycle.userStart(prepare: { prepareStartMasterKey() }) { startLocked(prepared: $0) }
  }

  /// Round 12 (review item 8): what `prepareStartMasterKey` found, OUTSIDE
  /// the lifecycle lock, for `startLocked` to re-validate inside it.
  struct PreparedStartKey {
    enum Outcome {
      /// The bridge cache's handle, whose recorded owner `mayAdopt` accepted.
      case cached(MasterKeyHandle)
      /// A handle `loadMasterKey()` read from the keychain (cache miss).
      case loaded(MasterKeyHandle)
      case refusedCachedOwner
      case missing
      case failed(String)
      /// The engine was running when prepared: no key needed (the running
      /// branch). If it stopped before the lock, `startLocked` asks again.
      case notNeeded
      /// Round 13 (review item 4): the manifest could not open, so no key
      /// was read (no prompt). `startLocked` refuses on the manifest, or
      /// prepares again if it opened since.
      case manifestUnavailable
    }
    let accountId: String
    let outcome: Outcome
  }

  /// Round 12 (review item 8): the slow half of the start, with no lock held.
  /// Reads the bridge cache and, on a miss, the keychain
  /// (`loadMasterKeyUncached()`, which can prompt, and unlike
  /// `loadMasterKey()` caches nothing: `startLocked` caches the handle with
  /// its owner only once it decided to use it). Writes no engine state.
  private func prepareStartMasterKey() -> PreparedStartKey? {
    guard let accountId = currentAccountId, !accountId.isEmpty else { return nil }
    if isRunning { return PreparedStartKey(accountId: accountId, outcome: .notNeeded) }
    // Round 13 (review of mobile#182 at a19037f9, item 4): the manifest
    // FIRST. A start the manifest refuses reads no key (no prompt); the
    // body refuses and schedules the retry, which asks the manifest first
    // again. A key read for a start the body then refused is kept for the
    // retry (`lifecycle.stashStartKey`), so a retry never prompts again.
    return lifecycle.prepareStartKey(
      accountId: accountId,
      manifestReady: { self.dbQueue.sync { self.openManifestIfClosed(trigger: "start_prepare") } == nil },
      manifestUnavailable: {
        RuntimeTrace.event("backup.native.start.master_key_skipped_manifest_unavailable")
        return PreparedStartKey(accountId: accountId, outcome: .manifestUnavailable)
      },
      cached: { () -> PreparedStartKey? in
        // Task 1599 followups (round 2, item 3): a cached handle existing is
        // NOT, by itself, proof it belongs to `accountId`. Read the "is there
        // a cached handle" flag and its owner from ONE locked snapshot
        // (`cachedMasterKeySnapshot()`); a cache whose recorded owner is set
        // and differs from `accountId` refuses, never reaching
        // `masterKeyHandle`.
        let cacheSnapshot = BeebeebCryptoBridge.cachedMasterKeySnapshot()
        RuntimeTrace.event("backup.native.start.master_key_request", [
          "promptMayAppear": self.masterKeyHandle == nil && cacheSnapshot.handle == nil,
          "bridgeCacheAvailable": cacheSnapshot.handle != nil
        ])
        guard let snapshotHandle = cacheSnapshot.handle else { return nil }
        guard CachedKeyOwnership.mayAdopt(cachedOwnerId: cacheSnapshot.ownerId, currentAccountId: accountId) else {
          return PreparedStartKey(accountId: accountId, outcome: .refusedCachedOwner)
        }
        // Task 1599 followups round 3 (P2): the SAME handle object the
        // ownership guard just verified, never a second `loadMasterKey()` read.
        return PreparedStartKey(accountId: accountId, outcome: .cached(snapshotHandle))
      },
      stashed: { key in
        (key as? MasterKeyHandle).map { PreparedStartKey(accountId: accountId, outcome: .loaded($0)) }
      },
      load: {
        do {
          guard let loaded = try BeebeebCryptoBridge.loadMasterKeyUncached() else {
            return PreparedStartKey(accountId: accountId, outcome: .missing)
          }
          return PreparedStartKey(accountId: accountId, outcome: .loaded(loaded))
        } catch {
          return PreparedStartKey(accountId: accountId, outcome: .failed(error.localizedDescription))
        }
      }
    )
  }

  /// `start()`'s body. MUST run inside a `lifecycle` transition (`start()`,
  /// or the retry's `runRetry`). Round 12 (review item 8): `prepared` was
  /// read outside the lock; anything it relied on that changed since (the
  /// account, the cache's handle or owner, the running state) asks the
  /// caller to prepare again (`.prepareAgain`) instead of loading here.
  private func startLocked(prepared: PreparedStartKey?) -> BackupEngineLifecycle.StartStep {
    guard let accountId = currentAccountId, !accountId.isEmpty else {
      RuntimeTrace.event("backup.native.start.refused_no_account", [
        "isRunning": isRunning
      ])
      NSLog("[NativeBackupEngine] No current account id — refusing to start (queue kept for later)")
      return .done
    }

    // Task 1667 round 6 (Codex P2 "Reopen the native manifest after
    // successful recovery"): never run without the manifest. `init()`'s
    // open is not proof a handle is open now: a failed sign-out reset closes
    // it, and a launch open can fail. Reopen here, or refuse visibly
    // (`manifestUnavailableReason`) and retry; before, every scan, manifest
    // check and upload silently no-oped on `db == nil` until a relaunch.
    guard ensureManifestOpenForStart(accountId: accountId) else {
      // Round 13 (review item 4): a key read from the keychain for this start
      // is kept for the retry the refusal just scheduled (no second prompt).
      if let prepared, prepared.accountId == accountId, case .loaded(let handle) = prepared.outcome {
        lifecycle.stashStartKey(handle, accountId: accountId)
      }
      return .done
    }

    if isRunning {
      // Task 1531 [P2-C] (round 5 delta review): `handleBackgroundTask`
      // (the `BGProcessingTask` handler) can flip `isRunning = true`
      // directly, on a code path that never calls this method — it does
      // NOT register the photo-library change observer or start the
      // network-path monitor. A subsequent JS-driven `start()` call (e.g.
      // `enablePhotoBackup` after the app is foregrounded) used to see
      // `isRunning == true` here and return after only waking the drain
      // loop, leaving BOTH unregistered for the rest of the app session —
      // camera-roll changes made while foregrounded would go undetected
      // until the next full relaunch. Finish that setup now; both helpers
      // are idempotent/guarded so calling them on an already-running
      // engine that DID go through the full path below is a cheap no-op.
      registerPhotoObserver()
      // Round 11: a no-op while a monitor runs (never a second one).
      startNetworkMonitor()
      // Task 1605: this IS the "next start after the account state
      // refreshes" resume point `accountRefusalStopReason`'s doc comment
      // promises. Clear unconditionally, same trade-off
      // `ownerUnconfirmedStopReason` already makes below: if the account is
      // STILL blocked, the very next upload attempt just re-pauses
      // immediately (one harmless refused request), never a silent stuck
      // pause with no way back to "running" short of a full app relaunch.
      if fileLimitStopReason != nil {
        fileLimitStopReason = nil
        isPaused = false
      }
      if accountRefusalStopReason != nil {
        accountRefusalStopReason = nil
        isPaused = false
      }
      // Round 12 (review item 3): this run is the user's now; a background
      // task that set `isRunning` no longer idles it when it ends.
      // Round 13 (review item 5): and a pause its expiration set ends here.
      if lifecycle.claimUserRun() {
        isPaused = false
      }
      wakeDrainLoop(reason: "start")
      return .done
    }

    // Round 12 (review item 8): the key was read outside the lock, for this
    // account, with the engine not running. Anything else: read it again.
    guard let prepared, prepared.accountId == accountId else { return .prepareAgain }
    let mk: MasterKeyHandle
    let bridgeCacheAvailable: Bool
    switch prepared.outcome {
    case .notNeeded, .manifestUnavailable:
      // Round 13 (item 4): `.manifestUnavailable` here means the manifest
      // opened since `prepare` refused to read a key: read it now.
      return .prepareAgain
    case .refusedCachedOwner:
      // Re-checked under the lock: the cache may have changed since.
      let now = BeebeebCryptoBridge.cachedMasterKeySnapshot()
      if now.handle == nil || CachedKeyOwnership.mayAdopt(cachedOwnerId: now.ownerId, currentAccountId: accountId) {
        return .prepareAgain
      }
      RuntimeTrace.event("backup.native.start.refused_cached_key_owner_mismatch")
      NSLog("[NativeBackupEngine] Cached master key owner unconfirmed or mismatched — refusing to start")
      // Task 1599 followups round 3 (P2): this refusal never reaches a
      // server (no request is ever built), so `accountMismatchStopReason`
      // — which only fires on a server-confirmed 409 — would never surface
      // it. Cleared on this function's own next successful run.
      ownerUnconfirmedStopReason = Self.ownerUnconfirmedStopReasonMessage
      return .done
    case .missing:
      RuntimeTrace.event("backup.native.start.master_key_missing")
      NSLog("[NativeBackupEngine] No master key in keychain — cannot start")
      return .done
    case .failed(let message):
      RuntimeTrace.event("backup.native.start.master_key_failed", [
        "error": message
      ])
      NSLog("[NativeBackupEngine] Failed to load master key: \(message)")
      return .done
    case .cached(let handle):
      // Re-validated under the lock: the SAME handle is still cached and its
      // recorded owner still matches (a sign-out or a confirmed mismatch in
      // between clears or changes it).
      let now = BeebeebCryptoBridge.cachedMasterKeySnapshot()
      guard let current = now.handle, current === handle,
            CachedKeyOwnership.mayAdopt(cachedOwnerId: now.ownerId, currentAccountId: accountId) else {
        return .prepareAgain
      }
      mk = handle
      bridgeCacheAvailable = true
    case .loaded(let handle):
      // Read from the keychain outside the lock; owner-checked below (the
      // shared mirror) before it is used or cached.
      mk = handle
      bridgeCacheAvailable = false
    }

    if bridgeCacheAvailable {
      // The cached handle and its recorded owner were confirmed for
      // `accountId` above, under the lock (task 1599 followups round 3: the
      // exact handle the guard verified is the one used, no second read).
      masterKeyHandle = mk
    } else {
      // Task 1599 followups (round 2, item 3): the cache was empty, so
      // this handle came straight off the per-app Keychain
      // (`KeychainManager.load`, inside `loadMasterKey()`'s cache-miss
      // branch) — there is no JS-confirmed `confirmMasterKeyHandle`
      // ownership verdict for THIS load. Only trust it for `accountId`,
      // and only then record that trust in the bridge cache, when the
      // SHARED "proven vault key owner" mirror
      // (`BeebeebKeychainCore.masterKeyOwnerKey` — written by
      // `key-ownership.ts`'s `writeKeyOwner`, the exact signal task
      // 1594's File Provider / Share Extension already gate their own
      // key access on) independently agrees. Reusing
      // `CachedKeyOwnership.mayAdopt` here too keeps "nil/mismatched
      // owner refuses" a single decision, not two copies that can drift.
      // Read here, under the lock, against the account it binds to.
      let mirroredOwner = BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.masterKeyOwnerKey)
      guard CachedKeyOwnership.mayAdopt(cachedOwnerId: mirroredOwner, currentAccountId: accountId) else {
        RuntimeTrace.event("backup.native.start.refused_unmirrored_key_owner")
        NSLog("[NativeBackupEngine] Master key owner not confirmed by the shared keychain mirror — refusing to start")
        // Task 1599 followups round 3 (P2): same local-refusal-needs-a-
        // reason fix as the cached-owner-mismatch branch above.
        ownerUnconfirmedStopReason = Self.ownerUnconfirmedStopReasonMessage
        return .done
      }
      masterKeyHandle = mk
    }
    // Task 1599 followups round 3 (P2): this run got past both ownership
    // guards above — whatever previously refused a start (if anything) no
    // longer applies. Clear unconditionally rather than only inside the
    // two refusal branches, so a stale reason from an EARLIER failed
    // `start()` attempt never survives a later successful one.
    ownerUnconfirmedStopReason = nil
    // Task 1605: same unconditional clear, same rationale — see
    // `accountRefusalStopReason`'s doc comment for why clearing here (a
    // FRESH start, `isRunning` was false) is the "next start" resume
    // point. `isPaused` is already reset to `false` a few lines below
    // (this function's own tail), so there is nothing further to flip.
    fileLimitStopReason = nil
    accountRefusalStopReason = nil
    // Task 1599 followup 3: `currentAccountId` here is `start()`'s OWN
    // persisted account id (Keychain-backed — see its property doc), which
    // is only ever WRITTEN by `bindAccount(userId:)`, called by JS only
    // after ITS OWN ownership verdict succeeds. Both branches above already
    // proved this SPECIFIC load's owner (cache-owner match, or the shared
    // mirror) before this line is ever reached.
    BeebeebCryptoBridge.setCachedMasterKey(mk, ownerId: currentAccountId)
    RuntimeTrace.event("backup.native.start.master_key_ready")

    guard token != nil, apiBaseUrl != nil else {
      NSLog("[NativeBackupEngine] Missing token or apiBaseUrl — cannot start")
      return .done
    }

    // Task 1531 [P0]: before draining anything, drop any staged asset whose
    // ciphertext was encrypted for a DIFFERENT account than the one about to
    // upload (`currentAccountId`, set by `enablePhotoBackup(authToken:userId:)`
    // just before this call). Closes the window where the very first batch
    // for a newly-signed-in account resumes another account's stale staged
    // upload. See purgeMismatchedStagedAssets for the full root-cause note.
    // Uses the SAME `accountId` the guard above just validated (rather than
    // re-reading the Keychain) so the purge can never run against a value
    // that changed between the guard and here.
    dbQueue.sync { purgeMismatchedStagedAssets(currentAccountId: accountId) }

    isRunning = true
    // Round 12 (review item 3): the user's run (a background task that ends
    // later never idles it).
    lifecycle.claimUserRun()
    perfLog("start", [
      "total": totalAssets,
      "completed": completedAssets
    ])
    isPaused = false
    consecutiveFailures = 0
    backoffUntil = nil

    refreshProgress()
    registerPhotoObserver()
    startNetworkMonitor()
    wakeDrainLoop(reason: "start")
    updateBackupStatusSurfaces(reason: "Backup started")
    logDiagnosticSnapshot(reason: "start")

    NSLog("[NativeBackupEngine] Started — \(totalAssets) total, \(completedAssets) completed")
    return .done
  }

  /// Stop the backup engine. Cancels the drain loop and unregisters observers.
  /// The app-wide in-process master-key cache is retained while the user is
  /// still unlocked so backup stop/start does not trigger an extra keychain
  /// biometric prompt. In-flight NSURLSession background uploads continue
  /// independently.
  ///
  /// Task 1667 round 11 (review finding 3): the user's stop (and sign-out,
  /// teardown, a confirmed account mismatch). It clears the "wants backup
  /// running" intent, voids every scheduled manifest-open retry and every
  /// running scan's fetch result, and runs the stop as one `lifecycle`
  /// transition. A retry that is already executing waits for this and then
  /// does nothing.
  func stop() {
    lifecycle.userStop { stopLocked() }
  }

  /// `stop()`'s body. MUST run inside a `lifecycle` transition (`stop()`, or
  /// `internalStop` when `start()` cannot open the manifest).
  private func stopLocked() {
    // Task 1531 [P1-3]: release the engine-owned master-key handle and
    // cancel any in-flight BGProcessingTask work FIRST, unconditionally —
    // BEFORE the `isRunning` early-return below. The old code put both
    // inside the `guard isRunning else { return }` block, so a second
    // `stop()` call (or a `BGProcessingTask` that set `masterKeyHandle`
    // directly — see `handleBackgroundTask` — without ever setting
    // `isRunning` via `start()`) skipped this release entirely: the OLD
    // account's key handle could sit in `masterKeyHandle` past the point
    // its caller believed the engine was fully stopped. Keep the app-wide
    // `BeebeebCryptoBridge` cache — that one is intentionally retained while
    // the user stays unlocked (see the doc comment below).
    masterKeyHandle = nil
    backgroundTaskHandle?.cancel()
    backgroundTaskHandle = nil
    RuntimeTrace.event("backup.native.stop.master_key_handle_released", [
      "bridgeCacheRetained": BeebeebCryptoBridge.hasCachedMasterKey(),
      "wasRunning": isRunning
    ])
    // Task 1667 round 6: a stopped engine has no "could not open" reason
    // and no pending start() retry (a retry after `disablePhotoBackup`
    // would start backup again).
    clearManifestAvailability()
    // Round 8: cancel observer-spawned scans (best effort; a PhotoKit fetch
    // already running finishes, and its insert is then dropped by the write
    // fence the sign-out reset advances).
    cancelScanTasks()
    // Round 11 (review finding 9): the bulk coverage is per run; the next
    // start asks again.
    engineStateLock.lock()
    _serverCheckCoverage.clear()
    engineStateLock.unlock()
    // Round 10 (review finding 3): drop the PhotoKit fetch result the change
    // observer diffs against. Kept, a PHChange after the next sign-in was
    // diffed against the pre-sign-out result and inserted a few rows before
    // the new full scan. The next full scan sets a fresh one.
    // Round 11 (review finding 5): done by the transition this runs in
    // (`userStop` / `internalStop` clear it and advance the generation a scan
    // must still match to store its result, `acceptFetchResult`).

    // Round 12 (review item 3): the observer and the monitor go whatever
    // `isRunning` says. Before, they were removed only past the guard below,
    // so a stop after a background task had idled the engine under a user
    // start left both registered. Both calls are no-ops when nothing is
    // registered.
    lifecycle.unregisterObserver { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    stopNetworkMonitor()
    // Round 12 (review item 6): a stopped engine is not "paused on the server".
    clearServerCheckPause()

    guard isRunning else { return }
    isRunning = false
    isPaused = false

    drainTask?.cancel()
    drainTask = nil
    pendingDrainWakeReason = nil

    uploadTaskMap.removeAll()
    // Task 1605: sibling cleanup for `chunkResponseBodyBuffers` — cancelled
    // background tasks never reach `didCompleteWithError`'s own
    // `removeValue`, so without this a `stop()` mid-upload would leak one
    // small capped buffer per in-flight chunk task until the next `stop()`.
    chunkResponseBodyBuffers.removeAll()

    // Recover any rows stuck in 'uploading' state
    dbQueue.async { [weak self] in
      self?.recoverStuckUploads()
    }
    endBackgroundGrace()

    perfLog("stop", [
      "total": totalAssets,
      "completed": completedAssets,
      "inProgress": inProgressAssets
    ])
    updateBackupStatusSurfaces(reason: "Backup stopped")
    logDiagnosticSnapshot(reason: "stop")
    scheduleOpenAppReminderIfNeeded()
    NSLog("[NativeBackupEngine] Stopped")
  }

  /// Pause the drain loop without clearing state. Background uploads continue.
  func pause() {
    isPaused = true
    perfLog("pause")
    updateBackupStatusSurfaces(reason: "Paused")
    logDiagnosticSnapshot(reason: "pause")
    NSLog("[NativeBackupEngine] Paused")
  }

  /// Resume after pause.
  func resume() {
    fileLimitStopReason = nil
    if !isRunning {
      start()
      guard isRunning else {
        updateBackupStatusSurfaces(reason: "Backup could not start")
        logDiagnosticSnapshot(reason: "resume_start_failed")
        return
      }
    }
    isPaused = false
    perfLog("resume")
    wakeDrainLoop(reason: "resume")
    updateBackupStatusSurfaces(reason: "Backup resumed")
    logDiagnosticSnapshot(reason: "resume")
    NSLog("[NativeBackupEngine] Resumed")
  }

  // MARK: - 0437 single-owner bridge (Swift drives, TS reads)

  /// Snapshot the engine's runtime state into the JS-readable shape that
  /// `src/lib/backup-bridge.ts` consumes (`BackupStatusSnapshot`). Replaces
  /// the old per-screen calls into `BackupDatabase.ts` — JS reads only,
  /// Swift writes. See task 0437.
  func snapshotForBridge() -> [String: Any] {
    // LD-0002 (#262 review 7): the status surfaces' counts, so a poll while
    // the gate is closed reads the last good values, not zeros.
    let counts = statusCounts() ?? BackupStatusCounts()
    let pending = counts.pending
    let internalState = backupState(pending: pending, uploading: counts.breakdown.uploading).state
    let lastError = lastErrorMessageForBridge()
    let backoffMillis: Any = backoffUntil.map { Int($0.timeIntervalSince1970 * 1000) } ?? NSNull()
    return [
      "totalAssets": totalAssets,
      "completedAssets": completedAssets,
      "inProgressAssets": inProgressAssets,
      "failedAssets": failedAssets,
      "bytesUploaded": bytesUploaded,
      "bytesTotal": bytesTotal,
      "state": BackupSurfaceState.bridgeRunState(internalState),
      "lastErrorMessage": (lastError as Any?) ?? NSNull(),
      "backoffUntil": backoffMillis,
    ]
  }

  /// Look up the current bridge-shaped status for a single asset by its
  /// `PHAsset.localIdentifier`. Returns one of `"queued"`, `"uploading"`,
  /// `"completed"`, `"failed"`, or `nil` when the asset isn't tracked.
  func assetStatusForBridge(localId: String) -> String? {
    return dbQueue.sync {
      guard let db = self.db else { return nil }
      var stmt: OpaquePointer?
      defer { exsqlite3_finalize(stmt) }
      let sql = "SELECT status FROM backup_assets WHERE local_asset_id = ? LIMIT 1"
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
      BackupManifestStore.bindText(stmt, 1, localId)
      guard exsqlite3_step(stmt) == SQLITE_ROW,
            exsqlite3_column_type(stmt, 0) != SQLITE_NULL else { return nil }
      let raw = String(cString: exsqlite3_column_text(stmt, 0))
      return Self.mapBridgeAssetStatus(raw)
    }
  }

  /// Map SQLite `status` column values to the bridge enum. The engine
  /// uses a richer set of internal transitions (`staging`, `staged_upload`,
  /// `pending_reupload`, etc.) but the bridge only exposes the 4-state
  /// shape that ts-engineer's `BackupAssetRuntimeStatus` declares.
  private static func mapBridgeAssetStatus(_ raw: String) -> String {
    switch raw {
    case "uploading":
      return "uploading"
    case "uploaded":
      return "completed"
    case "failed", "local_missing":
      return "failed"
    default:
      // pending_upload, pending_reupload, staging, staged_upload — all
      // pre-upload states show as queued to the JS UI.
      return "queued"
    }
  }

  /// Most recent non-null `error_message` from a failed asset row.
  /// Surfaces the user-actionable error that the engine has been
  /// retrying. `nil` when the queue has no failed assets.
  private func lastErrorMessageForBridge() -> String? {
    return dbQueue.sync {
      guard let db = self.db else { return nil }
      var stmt: OpaquePointer?
      defer { exsqlite3_finalize(stmt) }
      let sql = """
      SELECT error_message FROM backup_assets
      WHERE (status IN ('failed', 'local_missing') OR COALESCE(retry_count, 0) >= 10)
        AND error_message IS NOT NULL AND error_message != ''
      ORDER BY COALESCE(last_attempt_at, 0) DESC
      LIMIT 1
      """
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
      guard exsqlite3_step(stmt) == SQLITE_ROW,
            exsqlite3_column_type(stmt, 0) != SQLITE_NULL else { return nil }
      return String(cString: exsqlite3_column_text(stmt, 0))
    }
  }

  /// Return current progress as a dictionary suitable for JS bridge.
  func currentProgress() -> [String: Any] {
    // LD-0002 (#262 review 7): see `snapshotForBridge`.
    let counts = statusCounts() ?? BackupStatusCounts()
    let pending = counts.pending
    let breakdown = counts.breakdown
    let state = backupState(pending: pending, uploading: breakdown.uploading)
    return [
      "total": totalAssets,
      "completed": completedAssets,
      "pending": pending,
      "waitingToEncrypt": breakdown.waitingToEncrypt,
      "encryptedPendingUpload": breakdown.encryptedPendingUpload,
      "uploading": breakdown.uploading,
      "inProgress": inProgressAssets,
      "failed": failedAssets,
      "bytesUploaded": bytesUploaded,
      "bytesTotal": bytesTotal,
      "isRunning": isRunning,
      "isPaused": isPaused,
      "state": state.state,
      "reason": state.reason,
      "lastBackupAt": counts.lastBackupAt ?? NSNull(),
      // Task 1599 followup 2: a SEPARATE, sticky signal from `state`/`reason`
      // above (which are recomputed fresh from live counters on every call
      // and would otherwise fall back to an unrelated generic reason like
      // "Backup ready" once `stop()` clears `isRunning`) — `nil` until a
      // confirmed account_mismatch sets it, cleared only by a fresh
      // JS-confirmed sign-in (`bindAccount`). `backup-context.tsx` already
      // polls this dict via `getBackupProgress()`.
      "accountMismatchReason": accountMismatchStopReason ?? NSNull(),
      // Task 1599 followups round 3 (P1): monotonic — see the property's own
      // doc comment. JS uses this to tell a reason raised during ITS OWN
      // session apart from one left over from before it started polling.
      "accountMismatchGeneration": accountMismatchGeneration,
      // Task 1599 followups round 3 (P2): a SEPARATE local-only refusal
      // reason — see `ownerUnconfirmedStopReason`'s doc comment for why this
      // is distinct from `accountMismatchReason` above.
      "ownerUnconfirmedReason": ownerUnconfirmedStopReason ?? NSNull(),
      // Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): a THIRD
      // local-only-in-the-sense-of-`ownerUnconfirmedReason`'s-non-session-
      // ending-ness reason — see `accountRefusalStopReason`'s doc comment.
      // Unlike `ownerUnconfirmedReason` this DOES come from a server
      // round-trip (a confirmed 409/413), but like it, it never ends the
      // JS session — this is the right account, just billing-blocked.
      "accountRefusalReason": accountRefusalStopReason ?? NSNull(),
      // Task 1667 round 6: `start()` could not open the backup manifest and
      // is retrying (`ensureManifestOpenForStart`). Null otherwise.
      "manifestUnavailableReason": manifestUnavailableStopReason ?? NSNull(),
      // Task 1667 round 12 (review item 6): uploads are paused on the server
      // check (server without backed_up, a failed check, no device id), with
      // the reason. Null otherwise.
      "serverCheckPausedReason": serverCheckPausedReason ?? NSNull(),
    ]
  }

  // MARK: - Background task registration

  #if os(iOS)
  /// Task 1669 Issue 2 — `BGTaskScheduler.register` must complete before
  /// `application(_:didFinishLaunchingWithOptions:)` returns (Apple's hard
  /// requirement), so `BeebeebAppDelegate` must call this synchronously on
  /// the main thread at launch. Before this fix it was an INSTANCE method,
  /// so calling it forced Swift's lazy `static let shared` to run
  /// `NativeBackupEngine`'s full `init()` — `setupBackgroundSession()`,
  /// `reconcileOrphanedBackgroundTasks()`, `setupMetadataSession()`, and a
  /// synchronous SQLite open — on that SAME main thread, at that SAME
  /// moment. `setupBackgroundSession()`'s `URLSession(configuration:...)`
  /// triggers ObjC's one-time `+[__NSCFURLSessionXPC initialize]`, an XPC
  /// handshake with nsurlsessiond; on a background, locked-device relaunch
  /// (build 227, `crashreports/guus-upload-Beebeeb-2026-09-30-010350.ips`)
  /// that handshake alone blocked the main thread for the full 10s
  /// scene-create watchdog budget (App CPU 0.069s in 31s of life — the
  /// thread was BLOCKED, not computing) and the app was SIGKILLed.
  /// Symbolicated stack (dSYM UUID 8023b2bb-eeb9-396f-bff2-542684584367,
  /// matches build 227 exactly): `AppDelegate.application` (AppDelegate.swift:28)
  /// -> `BeebeebAppDelegate.application` (this file's sibling, offset 425340)
  /// -> one-time init for `.shared` (NativeBackupEngine.swift:424/1046) ->
  /// `init()` (:1048) -> `setupBackgroundSession()` (:1712) -> ObjC
  /// `+initialize` -> XPC. This function is now `static` and touches
  /// nothing on the singleton — a plain background launch (the case that
  /// crashed) no longer constructs `NativeBackupEngine` AT ALL, so it can
  /// never run `setupBackgroundSession()` on the launch path. The
  /// singleton is still built lazily, off this path, the first time real
  /// backup work needs it (a JS bridge call, or the rarer
  /// `handleEventsForBackgroundURLSession` relaunch — see that method's
  /// own doc comment for why re-attaching the background session there IS
  /// still allowed to be synchronous).
  static func registerBackgroundTaskEarly() {
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: bgTaskIdentifier,
      using: nil
    ) { task in
      guard let processingTask = task as? BGProcessingTask else { return }
      NativeBackupEngine.shared.handleBackgroundTask(processingTask)
    }
  }

  func scheduleNextBackup() {
    let request = BGProcessingTaskRequest(identifier: Self.bgTaskIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    try? BGTaskScheduler.shared.submit(request)
  }

  private func handleBackgroundTask(_ task: BGProcessingTask) {
    scheduleNextBackup()
    isBackgroundTaskActive = true
    // LD-0002: a live BGProcessingTask opens the background gate (and reopens
    // it after an earlier expiry) before the body's first statement. The
    // assertion is this task's own: its completion ends exactly it (#262
    // review 12: a slot shared across tasks let a late completion of task A
    // end task B's assertion).
    let assertion = executionGate.beginAssertion(.backgroundProcessing)
    // Reset the completion guard for this invocation. The property lives
    // on the engine (singleton) so a previous task's completion state
    // would otherwise leak forward.
    backgroundTaskCompletionLock.lock()
    backgroundTaskCompletionFired = false
    backgroundTaskCompletionLock.unlock()

    let bgTask = Task { [weak self] in
      guard let self else { return }
      defer {
        self.isBackgroundTaskActive = false
        self.backgroundTaskHandle = nil
      }

      // Task 1531 [P0] round 3 (lead review): this handler is a SEPARATE
      // engine entry point from `start()` — the `BGTaskScheduler` can invoke
      // it directly after an app relaunch, before any JS call (including
      // `enablePhotoBackup`) has run this session, and it sets `isRunning`
      // itself below rather than going through `start()`'s guard. Without an
      // independent check here, a stale/no-account state would still be able
      // to reach `processBatch` → `uploadSingleAsset` from this path. Checked
      // and purged FIRST, before the master-key work, so a nil account
      // refuses outright — no master key touched, no staging, no upload —
      // and the OS-scheduled task simply completes as a no-op.
      guard let accountId = self.currentAccountId, !accountId.isEmpty else {
        RuntimeTrace.event("backup.native.background_task.refused_no_account")
        NSLog("[NativeBackupEngine] Background task: no current account id — refusing to run")
        self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
        return
      }
      // Task 1531 [P1-3]: captured AFTER the account guard above, so this is
      // "the account epoch this task is entitled to act under". Compared
      // again before this task's exit is allowed to flip `isRunning` off
      // (below) — see `accountGeneration`'s doc comment.
      let taskGeneration = self.accountGenerationSnapshot()
      // Task 1667 round 6: this entry point sets `isRunning` without
      // `start()`, so it opens the manifest itself and refuses without one
      // (the reason is published; the OS reschedules this task) instead of
      // scanning and uploading into a closed handle.
      let manifestFailure = self.dbQueue.sync { self.openManifestIfClosed(trigger: "background_task") }
      if case .refuse(let reason, _) = self.recordManifestOpen(manifestFailure) {
        RuntimeTrace.event("backup.native.background_task.refused_manifest_unavailable", [
          "failure": manifestFailure?.rawValue ?? NSNull()
        ])
        self.updateBackupStatusSurfaces(reason: reason)
        self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
        return
      }
      self.dbQueue.sync { self.purgeMismatchedStagedAssets(currentAccountId: accountId) }
      // Round 8: the background task's manifest write ticket, taken at its
      // start; its scan and its batch write behind it. None (signed out
      // since the account check, another account bound) = nothing to do.
      guard let writeTicket = self.manifestWriteTicket("background_task", accountId: accountId) else {
        self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
        return
      }
      // Round 11 (review finding 9): the task's batch starts with a bulk check.
      self.requestBulkServerCheck()

      // Ensure master key is available for background processing
      if self.masterKeyHandle == nil {
        // Task 1531 [P1-3]: re-check `currentAccountId` immediately before
        // adopting the bridge's cached handle — the account guard above ran
        // moments earlier and is not itself atomic with this read. A handle
        // adopted for the wrong account is exactly the bug `processBatch`'s
        // `batchAccountId` binding guards against downstream, but refusing
        // here means a switch in this narrow window never gets as far as
        // touching a key at all.
        guard self.currentAccountId == accountId else {
          RuntimeTrace.event("backup.native.background_task.refused_account_changed")
          self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
          return
        }
        // Task 1599 followup 3: a cached handle existing is not, by itself,
        // proof it belongs to `accountId` — `CachedKeyOwnership.mayAdopt`
        // requires the cache's OWN recorded owner (set only at
        // `confirmMasterKeyHandle`/`start()`, both of which attest a
        // JS-verified owner — see `BeebeebCryptoBridge.cachedOwnerId`'s doc
        // comment) to match. An unconfirmed (`nil`) or mismatched owner is
        // refused exactly like "no cache at all", never silently adopted.
        //
        // Task 1599 followups round 2 review (P1): the handle and its owner
        // MUST come from the same cache generation — read both under one
        // lock via `cachedMasterKeySnapshot()`, never as two separate locked
        // calls (which could observe a foreign handle paired with a newer,
        // unrelated owner id if a `start()`/`confirmMasterKeyHandle` on
        // another thread lands between the two reads).
        let cacheSnapshot = BeebeebCryptoBridge.cachedMasterKeySnapshot()
        if let cached = cacheSnapshot.handle,
           CachedKeyOwnership.mayAdopt(
             cachedOwnerId: cacheSnapshot.ownerId,
             currentAccountId: accountId
           ) {
          self.masterKeyHandle = cached
          RuntimeTrace.event("backup.native.background_task.master_key_ready", [
            "source": "bridgeCache"
          ])
        } else {
          RuntimeTrace.event("backup.native.background_task.master_key_skipped", [
            "reason": cacheSnapshot.handle != nil ? "cached_key_owner_unconfirmed" : "no_unlocked_cache",
            "promptMayAppear": false
          ])
          self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
          return
        }
      }

      guard self.masterKeyHandle != nil else {
        self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
        return
      }

      let mode = self.currentPacingMode()
      self.perfLog("mode", [
        "mode": mode.rawValue,
        "batchLimit": mode.batchLimit,
        "delayMs": mode.delayNanoseconds / 1_000_000
      ])

      // Round 11 (review finding 3): the check-and-set is one `lifecycle`
      // transition, like start() and stop(). Round 12 (review item 3): when it
      // sets `isRunning`, this task owns the run until a user start claims it.
      let batchStart: Bool = self.lifecycle.beginBackgroundRun(isRunning: { self.isRunning }) {
        self.isRunning = true
        self.isPaused = false
      }
      if !batchStart {
        self.updateBackupStatusSurfaces(reason: "Background backup running")
      }

      do {
        // Cooperative cancellation checkpoints between phases so an
        // expiration that fires while we're between long-running async
        // calls unwinds immediately instead of starting another batch.
        try Task.checkCancellation()
        _ = await self.scanPhotoLibraryForPendingUploads(reason: "Background backup scan", ticket: writeTicket)
        try Task.checkCancellation()
        let uploaded = try await self.processBatch(limit: mode.batchLimit, ticket: writeTicket)
        self.completeBackgroundTaskOnce(task, success: uploaded >= 0, assertion: assertion)
      } catch is CancellationError {
        self.perfLog("bg-task.expired", [:])
        self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
      } catch {
        self.completeBackgroundTaskOnce(task, success: false, assertion: assertion)
      }

      // Task 1531 [P1-3]: only THIS task's own idle→running transition gets
      // to idle it back. If `self.accountGeneration` has moved since
      // `taskGeneration` was captured, a newer `start()`/account-switch
      // began while this task's `processBatch` was awaiting — that newer
      // run owns `isRunning` now, and this stale task must not stop it.
      // Round 12 (review item 3): nor when the user started backup on the
      // SAME account meanwhile (no generation bump): `start()` claimed the
      // run (`claimUserRun`), and only a stop ends it. Before, the task's
      // exit set `isRunning = false` under the user's foreground backup, and
      // `stop()` then returned early, leaving the observer and the monitor
      // registered.
      let idled: Bool = !batchStart && self.lifecycle.endBackgroundRun(
        stillCurrent: { self.accountGenerationSnapshot() == taskGeneration }
      ) {
        self.isRunning = false
      }
      if idled {
        self.updateBackupStatusSurfaces()
        self.scheduleOpenAppReminderIfNeeded()
      }
    }
    backgroundTaskHandle = bgTask

    task.expirationHandler = { [weak self] in
      // Propagate cancellation into the running Task so the
      // `try Task.checkCancellation()` checkpoints and `Task.isCancelled`
      // checks inside `processBatch` / `uploadSingleAsset` unwind
      // promptly. Also flip `isPaused` so any non-cancellation-aware
      // bookkeeping (status surfaces, JS-side state) reflects the
      // suspension. As a backstop, mark the BGProcessingTask completed
      // — `completeBackgroundTaskOnce` is idempotent, so the body's
      // own terminal call is a no-op if we win the race.
      NSLog("[NativeBackupEngine] Background task expiring — cancelling work")
      guard let self else { return }
      // LD-0002 (B1): close the gate, interrupt and wait (<= 2 s) FIRST: the
      // cancel and the pause below only unwind between awaits. Completing the
      // task is the last step.
      self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "background-processing-expiry")
      self.backgroundTaskHandle?.cancel()
      // Round 13 (review of mobile#182 at a19037f9, item 5): pause only a
      // run this task owns. When the user's run was going (the task found
      // the engine running, or the user claimed the run meanwhile), the
      // expiration that comes as the user picks up the phone used to set
      // `isPaused`, and the foreground drain loop slept with nothing to
      // clear it until a network change, "Back up now" or a relaunch.
      if !self.lifecycle.expireBackgroundRun({ self.pause() }) {
        RuntimeTrace.event("backup.native.background_task.expired_user_run_kept")
      }
      self.completeBackgroundTaskOnce(task, success: false, assertion: assertion, quiesced: true)
    }
  }

  /// Idempotent wrapper around `BGProcessingTask.setTaskCompleted(success:)`.
  /// Apple's contract requires exactly one call; the expiration handler
  /// and the Task body's terminal branches all funnel through here so a
  /// late-firing expiration doesn't double-call after the body completed
  /// (or vice versa).
  ///
  /// LD-0002: the task's gate assertion ends here; in the background the gate
  /// closes with it, so SQLite is quiesced before `setTaskCompleted`
  /// (`quiesced`: the expiry handler already did).
  private func completeBackgroundTaskOnce(
    _ task: BGProcessingTask,
    success: Bool,
    assertion: BackupExecutionGate.Assertion,
    quiesced: Bool = false
  ) {
    // The task's own assertion ends with its first completion, whichever
    // path gets there (ending it twice is harmless).
    executionGate.endAssertion(assertion)
    backgroundTaskCompletionLock.lock()
    let alreadyFired = backgroundTaskCompletionFired
    if !alreadyFired {
      backgroundTaskCompletionFired = true
    }
    backgroundTaskCompletionLock.unlock()
    if !alreadyFired {
      if !quiesced, !executionGate.canStartSQLiteWork {
        quiesceSQLiteBeforeBackgroundTimeEnds(reason: "background-processing-end")
      }
      task.setTaskCompleted(success: success)
    }
  }
  #endif

  // MARK: - Background URLSession relaunch events (task 1669 round 2)
  //
  // `application(_:handleEventsForBackgroundURLSession:completionHandler:)` fires when iOS
  // relaunches the app specifically to deliver background-session events. It runs on the MAIN
  // thread, inside the same launch window the scene-create watchdog polices (build 227 was
  // SIGKILLed after 10 s there). Constructing `NativeBackupEngine.shared` runs `init()`, which
  // builds the background URLSession (`+[NSURLSession _sessionWithConfiguration:]` -> XPC
  // handshake with nsurlsessiond, the proven 10 s stall), so the app delegate must NOT do that
  // synchronously. The split is:
  //
  //   1. `stashBackgroundSessionCompletionHandler` — the app delegate calls it on the main thread,
  //      first, before anything else. It only stores the closure (lock + assignment), no engine.
  //   2. The app delegate then hops to a background queue and touches `.shared` there. `init()`
  //      recreates the session with the SAME identifier (`bgSessionIdentifier`); Apple holds the
  //      pending delegate events until that session exists, so nothing is lost by the delay.
  //   3. When the events are drained, `urlSessionDidFinishEvents(forBackgroundURLSession:)` takes
  //      the stashed handler and calls it on the MAIN queue, as Apple requires.
  //
  // The handler lives in a static (not an instance var) precisely because step 1 happens before
  // any instance exists. If a second relaunch callback arrives before the first was consumed, the
  // older handler is completed (main queue) rather than dropped: iOS would otherwise keep waiting
  // on it and eventually penalise the app's background budget.
  private static let backgroundSessionHandlerLock = NSLock()
  private static var pendingBackgroundSessionCompletionHandler: (() -> Void)?

  /// Cheap and main-thread-safe: stores the handler, constructs nothing.
  static func stashBackgroundSessionCompletionHandler(_ completionHandler: @escaping () -> Void) {
    backgroundSessionHandlerLock.lock()
    let previous = pendingBackgroundSessionCompletionHandler
    pendingBackgroundSessionCompletionHandler = completionHandler
    backgroundSessionHandlerLock.unlock()
    if let previous {
      DispatchQueue.main.async { previous() }
    }
  }

  /// Removes and returns the stashed handler (nil when none is pending).
  private static func takeBackgroundSessionCompletionHandler() -> (() -> Void)? {
    backgroundSessionHandlerLock.lock()
    defer { backgroundSessionHandlerLock.unlock() }
    let handler = pendingBackgroundSessionCompletionHandler
    pendingBackgroundSessionCompletionHandler = nil
    return handler
  }

  /// Runs on a background queue after the app delegate stashed the completion handler. Touching
  /// `.shared` is what runs `init()` -> `setupBackgroundSession()`, which reattaches the
  /// background session (same identifier) so iOS can deliver the pending events to this delegate.
  /// When the engine already exists (warm app) this is a no-op beyond the property read.
  static func reattachBackgroundSessionForPendingEvents() {
    _ = NativeBackupEngine.shared
  }

  // MARK: - Photo Library Observer

  /// Round 11 (review finding 3): registers the change observer at most
  /// once (`lifecycle.registerObserverOnce`), then scans.
  private func registerPhotoObserver() {
    lifecycle.registerObserverOnce { PHPhotoLibrary.shared().register(self) }
    spawnScan(reason: "Camera roll scanned", wakeReason: "photo-scan")
  }

  /// Round 8 (Codex P1 "Fence late photo scans before resetting the
  /// manifest"): the scan takes its write ticket FIRST, before the PhotoKit
  /// fetch (which can take seconds on a large library). Its insert runs on
  /// `dbQueue` behind that ticket, so a sign-out reset that lands while the
  /// fetch runs drops the insert instead of refilling the emptied manifest
  /// with the outgoing account's camera roll. `ticket` is the caller's when
  /// it took one at its own start (the background task); otherwise the scan
  /// takes one here. No ticket = no scan (signed out, or another account).
  @discardableResult
  func scanPhotoLibraryForPendingUploads(reason: String, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async -> Bool {
    guard let ticket = callerTicket ?? manifestWriteTicket("scan") else { return false }
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard status == .authorized || status == .limited else {
      NSLog("[NativeBackupEngine] Photo library not authorized (status: \(status.rawValue))")
      return false
    }

    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    if includeVideos {
      options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
                                      PHAssetMediaType.image.rawValue,
                                      PHAssetMediaType.video.rawValue)
    } else {
      options.predicate = NSPredicate(format: "mediaType == %d",
                                      PHAssetMediaType.image.rawValue)
    }
    let selectedAlbums = selectedPhotoAlbumIds
    // Round 11 (review finding 5): captured BEFORE the fetch; a stop or
    // sign-out after this line voids the fetch result (`acceptFetchResult`).
    let fetchGeneration = lifecycle.stopGeneration
    let assets = fetchAssetsForBackup(
      options: options, selectedAlbumIds: selectedAlbums, ticket: ticket, stopGeneration: fetchGeneration
    )
    // Best effort: `stop()` / sign-out cancel observer-spawned scans. The
    // ticket check below is what holds when the cancel comes too late.
    guard !Task.isCancelled else { return false }
    let scanned = scannedAssets(assets)
    // Under "Selected photos" access the fetch IS the user's
    // selection, so scope the manifest to it exactly like an album
    // selection. Photos no longer shared leave the queue and the counts
    // (instead of each one failing as "missing" and parking the drain), and
    // come back on the first scan after access widens.
    let selection = FencedManifestWrites.Selection(
      allowedAssetIds: Set(assets.map(\.localIdentifier)),
      hasAlbumSelection: !selectedAlbums.isEmpty || status == .limited
    )

    let scanAccountId = ticket.accountId
    var hasPending = await withCheckedContinuation { continuation in
      dbQueue.async { [weak self] in
        guard let self else {
          continuation.resume(returning: false)
          return
        }
        let written = FencedManifestWrites.scanInsert(
          self.db, fence: self.manifestHandle.writeFence, ticket: ticket, writer: "scan.insert",
          assets: scanned, selection: selection, nowMs: self.nowMs()
        )
        self.recordScanInsert(written, assets: scanned.count, source: .fullScan)
        guard written != .fenced else {
          continuation.resume(returning: false)
          return
        }
        continuation.resume(returning: self.hasPendingUploads())
      }
    }

    // Task 1667: rebuild an emptied manifest from the server BEFORE reporting
    // pending work (the batch gate in `processBatch` enforces the same), then
    // catch up on uploads the server's per-device map does not know yet —
    // including every row uploaded before the client marked anything.
    // Round 8: both run under the scan's ticket.
    if !scanAccountId.isEmpty, let authToken = token, let baseURL = apiBaseUrl {
      // Round 13 (review of mobile#182 at a19037f9, item 10): the rebuild
      // gate runs only inside the batch slot, like `processBatch`'s (round 12
      // item 9). Before, a scan and a batch both ran it: both fetched
      // /identifiers and applied the map, and a scan whose gate deferred
      // wrote `backoffUntil` and raised `manifestRebuildFailures` for the
      // drain loop although the batch's own gate had succeeded. While a batch
      // holds the slot, the scan leaves the gate to it. The mark catch-up
      // runs after the slot is released: it writes no backoff, and a mark
      // sent twice is idempotent on the server.
      var ready = false
      if beginBatchProcessing() {
        ready = await ensureManifestReadyForUploads(accountId: scanAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket)
        finishBatchProcessing()
      } else {
        perfLog("scan.rebuild_gate_skip", ["reason": "batch-running"])
      }
      if ready {
        await flushServerMarks(accountId: scanAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket)
      }
      hasPending = dbQueue.sync { self.hasPendingUploads() }
    }

    DispatchQueue.main.async { [weak self] in
      self?.updateBackupStatusSurfaces(reason: reason)
    }
    return hasPending
  }

  /// Round 11 (review finding 5): the fetch result is stored only through
  /// `storeFetchResult`, which refuses it after a stop / sign-out or a
  /// cancel, or when the scan's fence ticket no longer admits writes. Before,
  /// a fetch still running across `stop()` wrote the pre-sign-out result back
  /// after `stop()` had cleared it.
  private func fetchAssetsForBackup(
    options: PHFetchOptions, selectedAlbumIds: [String], ticket: ManifestWriteFence.Ticket, stopGeneration: UInt64
  ) -> [PHAsset] {
    guard !selectedAlbumIds.isEmpty else {
      let result = PHAsset.fetchAssets(with: options)
      storeFetchResult(result, ticket: ticket, stopGeneration: stopGeneration)
      var assets: [PHAsset] = []
      result.enumerateObjects { asset, _, _ in assets.append(asset) }
      return assets
    }

    // A selected-album scan is a union of multiple PHFetchResult instances, so
    // there is no single `currentFetchResult` safe for PHChange incremental
    // inserts. Force the change observer to perform a selected-album rescan
    // instead of trusting unvalidated insertedObjects from an all-library fetch.
    storeFetchResult(nil, ticket: ticket, stopGeneration: stopGeneration)
    let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: selectedAlbumIds, options: nil)
    var assetsById: [String: PHAsset] = [:]
    collections.enumerateObjects { collection, _, _ in
      let result = PHAsset.fetchAssets(in: collection, options: options)
      result.enumerateObjects { asset, _, _ in
        assetsById[asset.localIdentifier] = asset
      }
    }
    return assetsById.values.sorted {
      ($0.creationDate ?? .distantPast) > ($1.creationDate ?? .distantPast)
    }
  }

  /// Round 11 (review finding 5): checks `Task.isCancelled`, the stop
  /// generation and the fence ticket, then stores, in ONE `lifecycle`
  /// transition (the lock every stop takes; the fence check is a
  /// `dbQueue.sync` inside it, the same lock order as `start()`).
  private func storeFetchResult(
    _ result: PHFetchResult<PHAsset>?, ticket: ManifestWriteFence.Ticket, stopGeneration: UInt64
  ) {
    let stored = lifecycle.acceptFetchResult(
      result, stopGeneration: stopGeneration, cancelled: Task.isCancelled,
      stillAdmitted: { self.dbQueue.sync { self.manifestHandle.writeFence.isCurrent(ticket) } }
    )
    if !stored {
      RuntimeTrace.event("backup.native.scan.fetch_result_dropped")
    }
  }

  // MARK: - Network Monitor

  /// Round 11 (review finding 3): starts a monitor only when none runs
  /// (`lifecycle.startMonitorIfNeeded`); a running one is never replaced and
  /// left running unreferenced.
  private func startNetworkMonitor() {
    #if os(iOS)
    lifecycle.startMonitorIfNeeded {
      let monitor = NWPathMonitor()
      monitor.pathUpdateHandler = { [weak self] path in
        let wasAvailable = self?.isNetworkAvailable ?? false
        self?.isNetworkAvailable = path.status == .satisfied

        // Resume drain loop when network comes back
        if !wasAvailable && path.status == .satisfied {
          NSLog("[NativeBackupEngine] Network restored — resuming")
          self?.isPaused = false
          self?.wakeDrainLoop(reason: "network")
        }
      }
      monitor.start(queue: queue)
      return monitor
    }
    #endif
  }

  private func stopNetworkMonitor() {
    #if os(iOS)
    lifecycle.stopMonitor { ($0 as? NWPathMonitor)?.cancel() }
    #endif
  }

  // MARK: - Drain Loop

  /// Returns the current `UIApplication.State` without blocking.
  ///
  /// On main thread: reads `UIApplication.shared.applicationState` directly
  /// and opportunistically refreshes the cache. Off main thread: returns the
  /// cached value populated by the lifecycle-notification observers. The
  /// previous implementation fell back to `DispatchQueue.main.sync` off
  /// main, which deadlocked the iOS watchdog (~20 s kill) whenever main
  /// was blocked on a JS bridge call into this same Expo module — common
  /// during heavy UI work while a background drain tick was active.
  private func currentApplicationState() -> UIApplication.State {
    if Thread.isMainThread {
      let state = UIApplication.shared.applicationState
      updateCachedApplicationState(state)
      return state
    }
    applicationStateLock.lock()
    let cached = _cachedApplicationState
    applicationStateLock.unlock()
    return cached
  }

  private func updateCachedApplicationState(_ state: UIApplication.State) {
    applicationStateLock.lock()
    _cachedApplicationState = state
    applicationStateLock.unlock()
  }

  @objc private func handleAppDidBecomeActiveForStateCache() {
    updateCachedApplicationState(.active)
    executionGate.setForeground(true)
  }

  @objc private func handleAppWillResignActiveForStateCache() {
    updateCachedApplicationState(.inactive)
  }

  /// LD-0002 (#262 review 8): the gate, so a status built inside an expiry
  /// handler (grace still flagged active, gate already closed) is
  /// `waitingForAppOpen` and the reminder is scheduled.
  private func canExecuteBackupWorkNow() -> Bool {
    executionGate.canStartSQLiteWork
  }

  private func beginBackgroundGraceIfNeeded() {
    guard isRunning, !isPaused, pendingUploadCount() > 0 else { return }

    let begin: () -> Void = { [weak self] in
      guard let self, self.backgroundGraceTask == .invalid else { return }

      self.isBackgroundGraceActive = true
      // LD-0002: the assertion opens the background gate before the drain
      // the wake below starts asks it.
      let assertion = self.executionGate.beginAssertion(.backgroundGrace)
      self.graceAssertion = assertion
      self.backgroundGraceTask = UIApplication.shared.beginBackgroundTask(withName: "BeebeebBackupDrain") { [weak self] in
        guard let self else { return }
        // LD-0002 (B1): close the gate, interrupt and wait (<= 2 s) FIRST. The
        // surfaces and the reminder then use the last counts (the gate is
        // closed: no SQLite), and ending the task is the LAST step. Before,
        // the task ended while the drain was in `exsqlite3_step` (0xdead10cc),
        // and round 1 (#257) still read SQLite after ending it.
        self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-expiry")
        self.updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")
        self.scheduleOpenAppReminderIfNeeded()
        self.endBackgroundGrace(quiesced: true)
      }

      if self.backgroundGraceTask == .invalid {
        self.isBackgroundGraceActive = false
        self.graceAssertion = nil
        self.executionGate.endAssertion(assertion)
      } else {
        self.wakeDrainLoop(reason: "background-grace")
      }
    }

    if Thread.isMainThread {
      begin()
    } else {
      DispatchQueue.main.async(execute: begin)
    }
  }

  /// LD-0002: in the background the gate closes with the grace assertion, so
  /// SQLite is quiesced before the task ends (`quiesced`: the caller already
  /// did). On main it runs synchronously: an expiry handler must end the task
  /// before it returns.
  private func endBackgroundGrace(quiesced: Bool = false) {
    let finish: () -> Void = { [weak self] in
      guard let self else { return }
      if let assertion = self.graceAssertion {
        self.graceAssertion = nil
        self.executionGate.endAssertion(assertion)
      }
      guard self.backgroundGraceTask != .invalid else {
        self.isBackgroundGraceActive = false
        return
      }
      if !quiesced, !self.executionGate.canStartSQLiteWork {
        self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-end")
      }
      let task = self.backgroundGraceTask
      self.backgroundGraceTask = .invalid
      self.isBackgroundGraceActive = false
      UIApplication.shared.endBackgroundTask(task)
    }
    if Thread.isMainThread {
      finish()
    } else {
      DispatchQueue.main.async(execute: finish)
    }
  }

  /// LD-0002: (a) close the gate, (b) interrupt the manifest and thumbnail
  /// statements in flight, (c) wait at most 2 s (one deadline for both) for
  /// `dbQueue` and the thumbnail queue to exit their current block. Every
  /// caller ends its background task only after this returns. A no-op in the
  /// foreground (`.foreground`). Never call it on `dbQueue`.
  @discardableResult
  private func quiesceSQLiteBeforeBackgroundTimeEnds(reason: String) -> BackupSQLiteQuiesce.Outcome {
    let started = Date()
    let outcome = BackupSQLiteQuiesce.run(
      gate: executionGate,
      interrupt: {
        NativeBackupEngine.manifestInterrupt.interrupt()
        ThumbnailQueueDB.shared.interruptInFlightStatement()
      },
      waitForQuiet: { timeout in
        let deadline = Date().addingTimeInterval(timeout)
        let manifestQuiet = BackupSQLiteQuiesce.waitForSerialQueue(self.dbQueue, timeout: timeout)
        let thumbnailQuiet = ThumbnailQueueDB.shared.waitForQuiet(timeout: deadline.timeIntervalSinceNow)
        return manifestQuiet && thumbnailQuiet
      }
    )
    // LD-0002 (#262 review 1): the drain stops at its next checkpoint instead
    // of running its batch on against a closed gate; foreground or a new
    // assertion wakes it again.
    if outcome != .foreground { drainTask?.cancel() }
    perfLog("quiesce", [
      "reason": reason,
      "outcome": outcome.rawValue,
      "elapsedMs": Int(Date().timeIntervalSince(started) * 1000)
    ])
    return outcome
  }

  /// LD-0002 rule 5: a background-URLSession completion's manifest write.
  /// B3: no check-then-act. The write's statements start from `db`, which asks
  /// the gate again when the block runs, so a gate closed after the check
  /// below reads nil and writes nothing (the row keeps its state and is
  /// retried). B2: with the gate closed the write runs under a short assertion
  /// of its own, which admits this one block and never reopens the gate for
  /// the drain or the thumbnails; when its time ends it is withdrawn, the
  /// statement interrupted and the block awaited (<= 2 s) before the task
  /// ends. No assertion = the write is deferred: no SQLite.
  private func runBackgroundCompletionWrite(_ writer: String, _ body: @escaping () -> Void) {
    if executionGate.canStartSQLiteWork {
      dbQueue.async(execute: body)
      return
    }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let assertion = self.executionGate.beginAssertion(.completionWrite)
      var task: UIBackgroundTaskIdentifier = .invalid
      task = UIApplication.shared.beginBackgroundTask(withName: "BeebeebCompletionWrite") { [weak self] in
        self?.executionGate.endAssertion(assertion)
        NativeBackupEngine.manifestInterrupt.interrupt()
        if let self {
          _ = BackupSQLiteQuiesce.waitForSerialQueue(self.dbQueue, timeout: BackupSQLiteQuiesce.defaultTimeout)
        }
        if task != .invalid {
          UIApplication.shared.endBackgroundTask(task)
          task = .invalid
        }
      }
      guard task != .invalid else {
        self.executionGate.endAssertion(assertion)
        RuntimeTrace.event("backup.native.completion_write.deferred", ["writer": writer])
        return
      }
      self.dbQueue.async {
        NativeBackupEngine.manifestStatements.withCompletionWrite(assertion, body)
        self.executionGate.endAssertion(assertion)
        DispatchQueue.main.async {
          if task != .invalid {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
          }
        }
      }
    }
  }

  private func currentPacingMode() -> BackupPacingMode {
    if let backoff = backoffUntil, Date() < backoff {
      return .serverBackoff
    }

    let processInfo = ProcessInfo.processInfo
    if processInfo.isLowPowerModeEnabled {
      return .lowPower
    }

    switch processInfo.thermalState {
    case .serious, .critical:
      return .thermalPressure
    default:
      break
    }

    switch currentApplicationState() {
    case .active:
      return .foregroundActive
    case .background:
      return .background
    case .inactive:
      return .foregroundIdle
    @unknown default:
      return .foregroundActive
    }
  }

  private func sleepIfStillRunning(nanoseconds: UInt64) async -> Bool {
    guard isRunning, !Task.isCancelled else { return false }
    do {
      try await Task.sleep(nanoseconds: nanoseconds)
    } catch {
      return false
    }
    return isRunning && !Task.isCancelled
  }

  private func wakeDrainLoop(reason: String) {
    guard isRunning else { return }
    if drainTask != nil {
      pendingDrainWakeReason = reason
      return
    }
    startDrainLoop(reason: reason)
  }

  private func startDrainLoop(reason: String) {
    // Round 11 (review finding 9): every drain start owes a bulk check.
    requestBulkServerCheck()
    drainTask?.cancel()
    drainLoopGeneration += 1
    let generation = drainLoopGeneration
    perfLog("drain.wake", ["reason": reason])
    drainTask = Task { [weak self] in
      defer {
        if let self, self.drainLoopGeneration == generation {
          self.drainTask = nil
          if let reason = self.pendingDrainWakeReason, self.isRunning {
            self.pendingDrainWakeReason = nil
            self.wakeDrainLoop(reason: reason)
          }
        }
      }

      while let self, self.isRunning, !Task.isCancelled {
        // LD-0002 rule 3: background time ended. The drain stops (no SQLite);
        // foreground or a new background assertion wakes it again.
        guard self.executionGate.canStartSQLiteWork else {
          self.perfLog("drain.stop", ["reason": "background-time-ended"])
          break
        }
        if self.isPaused {
          _ = await self.sleepIfStillRunning(nanoseconds: 2_000_000_000) // 2s
          continue
        }

        let mode = self.currentPacingMode()
        self.perfLog("mode", [
          "mode": mode.rawValue,
          "batchLimit": mode.batchLimit,
          "delayMs": mode.delayNanoseconds / 1_000_000
        ])

        if let backoff = self.backoffUntil, Date() < backoff {
          let remaining = max(0, backoff.timeIntervalSinceNow)
          let delay = min(mode.delayNanoseconds, UInt64(remaining * 1_000_000_000))
          _ = await self.sleepIfStillRunning(nanoseconds: delay)
          continue
        }

        do {
          guard self.isRunning, !self.isPaused, !Task.isCancelled else { continue }
          // Round 8: this iteration's write ticket. None = signed out (or
          // another account bound) since the loop started: nothing to drain.
          guard let iterationTicket = self.manifestWriteTicket("drain") else { return }
          self.dbQueue.sync {
            guard self.admitsWrite(iterationTicket, "drain.recover_stuck") else { return }
            self.recoverStuckUploads()
          }
          guard self.dbQueue.sync(execute: { self.hasPendingUploads() }) else {
            return
          }

          let uploaded = try await self.processBatch(limit: mode.batchLimit)
          // Round 10: rows the server check promoted are progress too; a
          // batch of photos the server already has must not wait 5 s.
          let progressed = uploaded + self.takeLastBatchServerPromoted()
          if progressed == 0, !self.dbQueue.sync(execute: { self.hasPendingUploads() }) {
            return
          } else if progressed == 0 {
            _ = await self.sleepIfStillRunning(nanoseconds: max(5_000_000_000, mode.delayNanoseconds)) // 5s on retry failures
          } else {
            _ = await self.sleepIfStillRunning(nanoseconds: mode.delayNanoseconds)
          }
        } catch {
          NSLog("[NativeBackupEngine] Batch error: \(error.localizedDescription)")
          _ = await self.sleepIfStillRunning(nanoseconds: max(5_000_000_000, mode.delayNanoseconds)) // 5s on error
        }
      }
    }
  }

  // MARK: - Core Upload Pipeline

  /// Process a batch of pending uploads. Returns the number of successfully uploaded assets.
  ///
  /// Round 8: the batch takes its manifest write ticket here, at its start,
  /// for `batchAccountId` (or uses the background task's), and every
  /// manifest write the batch makes, down to each asset's completion
  /// record, runs behind it. A sign-out reset (or a new account's bind)
  /// while the batch encrypts or uploads drops those writes.
  func processBatch(limit: Int = 12, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async throws -> Int {
    guard isRunning, let masterKey = masterKeyHandle else { return 0 }
    // LD-0002 rule 3: no batch after background time ended (`db` refuses
    // every statement anyway; this skips the network work too).
    guard executionGate.canStartSQLiteWork else { return 0 }
    guard let authToken = token, let baseURL = apiBaseUrl else {
      throw BackupError.notConfigured
    }
    // Task 1531 [P1-2]: captured ONCE, in the same breath as `masterKey` and
    // `authToken` above, and threaded through as `batchAccountId` to every
    // asset this batch processes — instead of `uploadSingleAsset` /
    // `stageEncryptedAsset` re-reading `currentAccountId` fresh at their own,
    // later call time. Without this, an in-flight batch that started under
    // account A (its `masterKey`/`authToken` are A's, captured right here)
    // could have `currentAccountId` flip to B mid-batch — e.g. a fast
    // sign-out/sign-in-as-B while this batch's long encrypt/upload work is
    // still in progress — and a later, fresh re-read would tag the
    // A-encrypted staged row as belonging to B. `batchAccountId` is what
    // gets WRITTEN to `staged_account_id`; the LIVE `currentAccountId` is
    // still re-checked before staging and before each upload (see
    // `uploadSingleAsset`), so a genuine switch mid-batch is refused rather
    // than mis-tagged.
    guard let batchAccountId = currentAccountId, !batchAccountId.isEmpty else {
      RuntimeTrace.event("backup.native.batch.refused_no_account")
      NSLog("[NativeBackupEngine] processBatch: no current account id — refusing batch")
      return 0
    }
    guard let ticket = callerTicket ?? manifestWriteTicket("batch", accountId: batchAccountId),
          ticket.accountId == batchAccountId else {
      return 0
    }

    // Round 12 (review item 9): only the caller that runs the batch goes on.
    // Before, the claim write, the identifiers fetch, the map/kept-marks
    // transactions and any backoff ran for every concurrent caller (drain
    // loop, background task, manual trigger), and all but one then returned
    // at 'already-processing'; a deferral from a caller that never ran a
    // batch pushed `backoffUntil` onto the one that did.
    if !beginBatchProcessing() {
      perfLog("batch.skip", ["reason": "already-processing", "limit": limit])
      return 0
    }
    defer { finishBatchProcessing() }

    // Recovery for exports abandoned by process termination. Reservations in
    // BackupVideoFileSource protect exports still being written or encrypted.
    let videoExportDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("beebeeb-photokit-cache", isDirectory: true)
    BackupVideoFileSource.sweepAbandonedExports(in: videoExportDirectory)

    // Task 1667: never upload into a manifest that does not yet know what
    // this account already backed up from this device (after a sign-out the
    // manifest is empty; uploading would duplicate every photo).
    guard await ensureManifestReadyForUploads(accountId: batchAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket) else {
      return 0
    }

    // Recover stuck uploads on each batch start
    dbQueue.sync {
      guard admitsWrite(ticket, "batch.recover_stuck") else { return }
      recoverStuckUploads()
    }

    // Round 11 (review finding 9): the bulk dedupe, before the selection, at
    // most once per drain start / background task / scan insert.
    await bulkServerCheckIfRequested(accountId: batchAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket)

    // Get pending assets from database
    guard executionGate.canStartSQLiteWork else { return 0 }
    let selected = dbQueue.sync { getPendingUploads(limit: limit) }
    if selected.isEmpty { return 0 }

    // Task 1667 round 10 (review finding 1): the dedupe guarantee. No row
    // starts a new upload before the server confirmed this device has not
    // backed it up already (a live hit becomes `uploaded` instead). The
    // rebuild above is only a fast path: it runs once per account, on the
    // rows present then. Any failure: nothing uploads, backoff.
    guard let pending = await rowsCheckedAgainstServer(
      selected, accountId: batchAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket
    ) else {
      return 0
    }
    if pending.isEmpty {
      refreshProgress()
      updateBackupStatusSurfaces()
      return 0
    }
    updateBackupStatusSurfaces(reason: "Preparing backup")

    perfLog("batch.start", [
      "limit": limit,
      "pending": pending.count,
      "running": isRunning
    ])

    let batchStart = Date()
    var uploaded = 0

    // Process with a foreground-friendly concurrency limit. The Rust uploader
    // can saturate bandwidth with multiple concurrent assets, which makes the
    // React Native UI and Files/Photos browsing feel sluggish.
    await withTaskGroup(of: BatchAssetOutcome.self) { group in
      var activeCount = 0
      var index = 0

      // LD-0002 (#262 review 1): no new asset once the gate closed since the
      // batch's ticket.
      while (index < pending.count || !group.isEmpty) && isRunning && !isPaused && !Task.isCancelled {
        // Add tasks up to concurrency limit
        while activeCount < maxConcurrentUploads && index < pending.count && isRunning && !isPaused && !Task.isCancelled
          && executionGate.isOpen(since: ticket.gateClosures) {
          let asset = pending[index]
          index += 1
          activeCount += 1

          group.addTask { [weak self] in
            guard let self else { return .failed }
            let didUpload = await self.uploadSingleAsset(
              asset,
              masterKey: masterKey,
              authToken: authToken,
              baseURL: baseURL,
              batchAccountId: batchAccountId,
              ticket: ticket
            )
            if didUpload { return .uploaded }
            // A photo deleted or no longer shared was marked
            // `local_missing`; nothing went wrong, so it must not feed the
            // failure backoff below.
            return self.isLocalMissing(asset.localAssetId) ? .skipped : .failed
          }
        }

        // Wait for one to complete
        if let outcome = await group.next() {
          activeCount -= 1
          if !self.isRunning || Task.isCancelled {
            group.cancelAll()
            break
          }
          switch outcome {
          case .uploaded:
            uploaded += 1
            self.consecutiveFailures = 0
          case .skipped:
            break
          case .failed:
            self.consecutiveFailures += 1
            // 5 consecutive failures: 60s backoff
            if self.consecutiveFailures >= 5 {
              self.backoffUntil = Date().addingTimeInterval(60)
              NSLog("[NativeBackupEngine] 5 consecutive failures — backing off 60s")
            }
          }
        }
      }
    }

    let duration = Date().timeIntervalSince(batchStart)
    perfLog("batch.finish", [
      "uploaded": uploaded,
      "pending": pending.count,
      "durationMs": Int(duration * 1000)
    ])
    refreshProgress()

    onProgress?(totalAssets, completedAssets, failedAssets)
    onBatchComplete?(uploaded, pending.count - uploaded, duration)
    updateBackupStatusSurfaces()

    NSLog("[NativeBackupEngine] Batch complete: \(uploaded)/\(pending.count) uploaded in \(String(format: "%.1f", duration))s")

    #if os(iOS)
    // Update persistent notification
    if isRunning {
      updateNotification(
        uploaded: completedAssets,
        total: totalAssets,
        isComplete: pending.isEmpty && uploaded > 0,
        sessionUploaded: uploaded
      )
    }
    #endif

    return uploaded
  }

  /// Manual "Back up now" should give retry-exhausted rows another chance.
  /// Automatic background drains still respect the retry cap to avoid loops.
  ///
  /// The status set MUST mirror the drain selection set (`pending_upload`,
  /// `pending_reupload`, `staging`, `staged_upload`, `uploading`) — earlier this
  /// only reset `pending_upload`/`pending_reupload`, which silently EXCLUDED the
  /// resume-wedged rows: a chunk-upload that dead-letters leaves the asset in
  /// `staged_upload` (markFailed sets `staged_upload` whenever `staged_file_id`
  /// is set), so the exact rows a manual retry most needs to revive were the
  /// ones it skipped. With retry reset, the drain re-selects them and the
  /// `.uploading` (resumable) self-heal re-stages any with evicted `.enc` chunks.
  func resetRetryExhaustedUploadsForManualRun() {
    // Task 1669 Issue 2: this was the one `db` accessor in the class NOT
    // wrapped in `dbQueue.sync` — harmless while `init()` opened the
    // database synchronously (any caller was guaranteed to run after it),
    // but `init()` now defers `openDatabase()` to `dbQueue` (see its doc
    // comment), so every accessor must go through the same serial queue to
    // stay correctly ordered after it.
    dbQueue.sync {
      guard let db = db else { return }
      let sql = """
      UPDATE backup_assets
      SET retry_count = 0,
          error_message = NULL,
          last_attempt_at = NULL
      WHERE status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading')
        AND COALESCE(selected_for_backup, 1) = 1
        AND COALESCE(retry_count, 0) >= 10
      """
      var stmt: OpaquePointer?
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      defer { exsqlite3_finalize(stmt) }
      exsqlite3_step(stmt)
      let resetCount = exsqlite3_changes(db)
      if resetCount > 0 {
        NSLog("[NativeBackupEngine] Reset \(resetCount) retry-exhausted uploads for manual backup")
      }
    }
  }

  /// Manual "Back up now" should synchronously refresh the camera-roll index
  /// before attempting a batch. The normal observer scan is asynchronous, and
  /// a manual trigger can otherwise race ahead, see zero pending rows, and make
  /// the UI look active while no upload starts.
  func triggerManualBackup(limit: Int = 50) async throws -> [String: Any] {
    fileLimitStopReason = nil
    if !isRunning {
      start()
    } else {
      isPaused = false
      consecutiveFailures = 0
      backoffUntil = nil
    }

    guard isRunning else {
      // Task 1667 round 6: say why when it was the manifest, not the key.
      if manifestUnavailableStopReason != nil { throw BackupError.databaseUnavailable }
      throw BackupError.noMasterKey
    }

    resetRetryExhaustedUploadsForManualRun()
    let hasPending = await scanPhotoLibraryForPendingUploads(reason: "Manual backup scan")
    if hasPending || dbQueue.sync(execute: { hasPendingUploads() }) {
      wakeDrainLoop(reason: "manual-watch")
    }
    var progress = currentProgress()
    progress["batchUploaded"] = 0
    progress["manualTrigger"] = true
    return progress
  }

  // MARK: - Single Asset Upload

  private func uploadSingleAsset(
    _ asset: BackupAssetRow,
    masterKey: MasterKeyHandle,
    authToken: String,
    baseURL: String,
    /// Task 1531 [P1-2]: the account `masterKey`/`authToken` were captured
    /// for, frozen once at `processBatch`'s own start — NOT a fresh read of
    /// `currentAccountId` here. Used both as the value newly-staged rows get
    /// tagged with, and as the baseline the LIVE `currentAccountId` must
    /// still match at each checkpoint below.
    batchAccountId: String,
    /// Round 8: the batch's manifest write ticket; every write below checks
    /// it in its own `dbQueue` block.
    ticket: ManifestWriteFence.Ticket
  ) async -> Bool {
    guard isRunning && !isPaused && !Task.isCancelled else { return false }
    // LD-0002 (#262 review 1): see `ensureBatchAdmitted`.
    guard executionGate.isOpen(since: ticket.gateClosures) else { return false }

    // Task 1531 [P1-2]: refuse outright — no staging, no upload — unless the
    // LIVE `currentAccountId` still matches the account this batch's
    // `masterKey`/`authToken` were captured for. Before this, the guard only
    // checked that `currentAccountId` was non-nil (a fresh read at THIS
    // call's own time, not the batch's), which could pass even after the
    // account switched mid-batch — an `if let runningAccount =
    // currentAccountId, staged.stagedAccountId != runningAccount` further
    // down would then tag/compare against the NEW account while still
    // encrypting/uploading with the OLD batch's key+token. A nil OR
    // different account is not "no opinion, upload it anyway"; it is
    // "cannot prove this ciphertext still belongs to the account it's about
    // to be tagged/uploaded as".
    guard let runningAccountId = currentAccountId, runningAccountId == batchAccountId else {
      RuntimeTrace.event("backup.native.upload.refused_no_account", [
        "assetType": asset.assetType,
        "batchAccount": batchAccountId,
        "liveAccount": currentAccountId ?? "(nil)"
      ])
      NSLog("[NativeBackupEngine] Account changed since batch start — refusing to upload/stage: \(asset.localAssetId)")
      return false
    }

    perfLog("asset.start", [
      "assetType": asset.assetType,
      "retry": asset.retryCount
    ])

    do {
      if let staged = dbQueue.sync(execute: { getStagedAsset(localAssetId: asset.localAssetId) }) {
        // Task 1531 [P0] belt-and-braces: `start()` already sweeps mismatched
        // (and untagged/NULL — lead review 2026-09-25) staged assets before
        // the drain loop can reach them, but re-check here too so this path
        // is safe even if it's ever reached without going through `start()`
        // first (defense in depth, not the primary fix — see
        // purgeMismatchedStagedAssets). `batchAccountId` is guaranteed
        // non-empty by the guard above, so `staged.stagedAccountId !=
        // batchAccountId` is a plain String vs Optional<String> compare: a
        // `nil` stagedAccountId is UNTRUSTED, not "same account", so it
        // compares unequal and gets refused exactly like an explicit
        // mismatch.
        if staged.stagedAccountId != batchAccountId {
          RuntimeTrace.event("backup.native.staged_account_mismatch.refused_upload", [
            "stagedForAccount": staged.stagedAccountId ?? "(untagged/pre-migration)",
            "currentAccount": batchAccountId
          ])
          dbQueue.sync {
            guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
            if let stagedDir = staged.stagedDir {
              removeStagedDirectory(stagedDir: stagedDir, fileId: staged.stagedFileId ?? "")
            }
            // Task 1667 round 16 (finding 2): keeps this row first if it is
            // in flight for its owner (the restage clears its ids).
            restageMismatchedStagedRow(
              assetId: asset.localAssetId,
              error: "Re-encrypting: staged ciphertext not verified for this account"
            )
          }
          onFileStatus?(asset.localAssetId, "pending", nil, nil)
          NSLog("[NativeBackupEngine] Refused to upload staged asset encrypted for a different account: \(asset.localAssetId)")
          return false
        }

        updateBackupStatusSurfaces(reason: "Uploading encrypted backup")
        return try await uploadStagedAsset(
          staged,
          authToken: authToken,
          baseURL: baseURL,
          masterKey: masterKey,
          batchAccountId: batchAccountId,
          ticket: ticket
        )
      }

      dbQueue.sync {
        guard admitsWrite(ticket, "markStaging") else { return }
        markStaging(assetId: asset.localAssetId)
      }
      updateBackupStatusSurfaces(reason: "Encrypting backup")
      onFileStatus?(asset.localAssetId, "encrypting", nil, nil)

      guard isRunning && !Task.isCancelled else { return false }
      // 1. Generate file ID + the on-disk chunk temp area (shared by both paths)
      let fileId = UUID().uuidString.lowercased()
      let tempDir = NSTemporaryDirectory()
      var chunkPaths: [String] = []
      defer {
        for path in chunkPaths {
          try? FileManager.default.removeItem(atPath: path)
        }
      }
      guard isRunning && !Task.isCancelled else { return false }

      // 2. Encrypt to temp chunk files via the shared beebeeb-core ladder (task
      //    0672). Core owns the chunk plan (mobile profile) — no hardcoded 4 MiB
      //    — derives the per-file key in Rust from the borrowed MasterKeyHandle,
      //    and `finish()` runs the integrity guard before we stage/upload. Each
      //    frame (`chunk.data` = nonce||ct||tag) is byte-identical to the prior
      //    nonce+ciphertext layout, so existing downloads decrypt unchanged.
      //
      //    Videos stream straight from disk via `fromFile` so a multi-GB clip
      //    never enters RAM; photos use the in-memory `forPush` path. A video
      //    composition is first exported to a protected temporary file (0677).
      //    Only photos use the in-memory path.
      let resolvedUti: String
      let resolvedOriginalSize: Int

      if asset.assetType == "video" {
        let videoSource = try await fetchVideoFileSource(localId: asset.localAssetId)
        defer { videoSource.cleanup() }
        resolvedUti = videoSource.uti
        resolvedOriginalSize = videoSource.sizeBytes
        guard canStageEncryptedAsset(plaintextBytes: Int64(resolvedOriginalSize)) else {
          dbQueue.sync {
            guard admitsWrite(ticket, "markPending") else { return }
            markPending(assetId: asset.localAssetId, error: "Waiting for free iPhone storage before staging backup")
          }
          updateBackupStatusSurfaces(reason: "Waiting for iPhone storage")
          return false
        }
        guard isRunning && !Task.isCancelled else { return false }
        // Hold the AVURLAsset alive for the whole pull loop so its backing file
        // URL stays valid (task 0672 — risk #1: video-URL lifetime). The loop
        // reads one core-planned chunk at a time → peak memory ≈ one chunk.
        let completed: Bool = try withExtendedLifetime(videoSource) { () throws -> Bool in
          let encryptor = try ChunkEncryptorHandle.fromFile(
            masterKey: masterKey,
            fileId: fileId,
            inputPath: videoSource.url.path,
            profile: Self.chunkProfile
          )
          while let chunk = try encryptor.nextChunk() {
            guard isRunning && !Task.isCancelled else { return false }
            let path = (tempDir as NSString).appendingPathComponent("upload-\(fileId)-\(Int(chunk.index)).enc")
            try chunk.data.write(to: URL(fileURLWithPath: path))
            chunkPaths.append(path)
          }
          // Integrity guard (detects a source that shrank) before staging.
          _ = try encryptor.finish()
          return true
        }
        guard completed else { return false }
      } else {
        // In-memory path: photos only.
        let (data, uti) = try await fetchAssetData(localId: asset.localAssetId)
        guard canStageEncryptedAsset(plaintextBytes: Int64(data.count)) else {
          dbQueue.sync {
            guard admitsWrite(ticket, "markPending") else { return }
            markPending(assetId: asset.localAssetId, error: "Waiting for free iPhone storage before staging backup")
          }
          updateBackupStatusSurfaces(reason: "Waiting for iPhone storage")
          return false
        }
        guard isRunning && !Task.isCancelled else { return false }
        resolvedUti = uti
        resolvedOriginalSize = data.count
        let encryptor = try ChunkEncryptorHandle.forPush(
          masterKey: masterKey,
          fileId: fileId,
          fileSize: UInt64(data.count),
          profile: Self.chunkProfile
        )
        let plan = try encryptor.chunkPlan()
        let planChunkSize = Int(plan.chunkSizeBytes)
        let planChunkCount = Int(plan.chunkCount)
        for index in 0..<planChunkCount {
          guard isRunning && !Task.isCancelled else { return false }
          let start = index * planChunkSize
          let end = min(start + planChunkSize, data.count)
          let slice = start < end ? data.subdata(in: start..<end) : Data()
          let chunk = try encryptor.pushChunk(plaintext: slice)
          let path = (tempDir as NSString).appendingPathComponent("upload-\(fileId)-\(Int(chunk.index)).enc")
          try chunk.data.write(to: URL(fileURLWithPath: path))
          chunkPaths.append(path)
        }
        // Integrity guard (detects a source that shrank) before staging.
        _ = try encryptor.finish()
      }
      guard isRunning && !Task.isCancelled else { return false }

      // 3. Encrypt filename
      let ext = fileExtension(for: resolvedUti)
      let filename = "IMG_\(fileId).\(ext)"
      let mimeType = mimeTypeFromUTI(resolvedUti)
      let nameEncrypted = try masterKey.encryptName(fileId: fileId, filename: filename, mimeType: mimeType)
      guard isRunning && !Task.isCancelled else { return false }

      let staged = try stageEncryptedAsset(
        asset: asset,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: mimeType,
        originalSize: resolvedOriginalSize,
        chunkPaths: chunkPaths,
        accountId: batchAccountId,
        ticket: ticket
      )
      chunkPaths.removeAll()
      updateBackupStatusSurfaces(reason: "Uploading encrypted backup")

      return try await uploadStagedAsset(
        staged,
        authToken: authToken,
        baseURL: baseURL,
        masterKey: masterKey,
        batchAccountId: batchAccountId,
        ticket: ticket
      )

    } catch BackupError.assetNotFound {
      perfLog("asset.missing", [
        "assetType": asset.assetType,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        guard admitsWrite(ticket, "markLocalMissing") else { return }
        markLocalMissing(assetId: asset.localAssetId)
      }
      refreshProgress()
      updateBackupStatusSurfaces(reason: "Skipped a photo no longer on this iPhone or no longer shared")

      onFileStatus?(asset.localAssetId, "local_missing", nil, BackupError.assetNotFound.localizedDescription)
      NSLog("[NativeBackupEngine] Asset missing locally, skipped: \(asset.localAssetId)")

      return false
    } catch BackupError.uploadStalled(let chunkIndex) {
      // 408 storage.upload_stalled: the chunk body went idle — almost always the
      // staged `.enc` was deleted/replaced under the in-flight background task
      // (the 0-byte stall). Re-stage from scratch and requeue WITHOUT bumping
      // retry_count, so the asset re-encrypts and re-uploads on the next drain
      // instead of climbing toward the retry-10 dead-letter. The v2 session +
      // its partial chunks are reaped by the server's stale-upload cleanup.
      perfLog("asset.stalled", [
        "assetType": asset.assetType,
        "chunkIndex": chunkIndex,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
        clearStagedStateForRestage(
          assetId: asset.localAssetId,
          error: "Upload stalled (408); re-encrypting"
        )
      }
      if let stagedDir = asset.stagedDir, let fileId = asset.stagedFileId {
        removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
      }
      updateBackupStatusSurfaces(reason: "Re-encrypting backup")
      onFileStatus?(asset.localAssetId, "pending", nil, nil)
      NSLog("[NativeBackupEngine] Asset upload stalled on chunk \(chunkIndex); re-staging: \(asset.localAssetId)")
      return false
    } catch BackupError.accountRefused(let code) {
      // Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): the call
      // site that threw this already paused the WHOLE engine
      // (`handleConfirmedAccountRefusal`) and recorded why
      // (`accountRefusalStopReason`). This one asset's own recovery is
      // narrower: `markPending` — NOT `markFailed` — keeps its staged
      // chunks and leaves `retry_count` untouched, so it is neither
      // dead-lettered nor loses upload progress for a reason that has
      // nothing to do with this specific asset. It re-attempts on its own
      // the next time this engine actually drains (see `start()`'s
      // unconditional clear of the stop reason).
      perfLog("asset.account_refused", [
        "assetType": asset.assetType,
        "code": code,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        guard admitsWrite(ticket, "markPending") else { return }
        markPending(assetId: asset.localAssetId, error: Self.accountRefusalStopReasonMessage(for: code))
      }
      updateBackupStatusSurfaces(reason: "Backup paused")
      onFileStatus?(asset.localAssetId, "pending", nil, nil)
      NSLog("[NativeBackupEngine] Asset upload paused (account refused, \(code)): \(asset.localAssetId)")
      return false
    } catch BackupError.trialCapExceeded(let capMessage) {
      // Task 1605 — sibling of the `.accountRefused` catch above for the
      // 413 trial-cap case. Same "keep the queue" recovery.
      perfLog("asset.trial_cap_exceeded", [
        "assetType": asset.assetType,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        guard admitsWrite(ticket, "markPending") else { return }
        markPending(assetId: asset.localAssetId, error: capMessage)
      }
      updateBackupStatusSurfaces(reason: "Backup paused")
      onFileStatus?(asset.localAssetId, "pending", nil, nil)
      NSLog("[NativeBackupEngine] Asset upload paused (trial storage cap reached): \(asset.localAssetId)")
      return false
    } catch BackupError.httpStatus(let statusCode, let body) where
      AccountRefusalDetection.isObjectBudgetExceeded(statusCode: statusCode, body: Data(body.utf8)) {
      guard currentAccountId == batchAccountId else { return false }
      let message = AccountRefusalDetection.objectBudgetMessage
      fileLimitStopReason = message
      pause()
      dbQueue.sync {
        guard admitsWrite(ticket, "markFailed.object_budget") else { return }
        markFailed(assetId: asset.localAssetId, error: message, retryLimitReached: true)
      }
      failedAssets += 1
      updateBackupStatusSurfaces(reason: message)
      onFileStatus?(asset.localAssetId, "failed", nil, message)
      return false
    } catch {
      perfLog("asset.fail", [
        "assetType": asset.assetType,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        guard admitsWrite(ticket, "markFailed") else { return }
        markFailed(assetId: asset.localAssetId, error: error.localizedDescription)
      }
      failedAssets += 1
      updateBackupStatusSurfaces(reason: "Upload failed")

      onFileStatus?(asset.localAssetId, "failed", nil, error.localizedDescription)
      NSLog("[NativeBackupEngine] Asset upload failed: \(error.localizedDescription)")

      return false
    }
  }

  // MARK: - Persistent Staging

  private func stagingRootDirectory() throws -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let root = base.appendingPathComponent(stagedBackupDirectoryName, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func currentStagedDirectory(fileId: String) throws -> URL {
    try stagingRootDirectory().appendingPathComponent(fileId, isDirectory: true)
  }

  private func readableRegularFile(_ url: URL) -> Bool {
    guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
      return false
    }
    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    return values?.isRegularFile == true && (values?.fileSize ?? 0) > 0
  }

  private func resolveStagedChunks(asset: BackupAssetRow, fileId: String, ticket: ManifestWriteFence.Ticket) -> [StagedChunkRow]? {
    let currentDir: URL
    do {
      currentDir = try currentStagedDirectory(fileId: fileId)
    } catch {
      return nil
    }

    if asset.stagedDir != currentDir.path {
      dbQueue.sync {
        guard admitsWrite(ticket, "updateStagedDirectory") else { return }
        updateStagedDirectory(assetId: asset.localAssetId, stagedDir: currentDir.path)
      }
    }

    let chunks = dbQueue.sync { getPendingStagedChunks(assetId: asset.localAssetId) }
    var resolved: [StagedChunkRow] = []

    for chunk in chunks {
      let storedURL = URL(fileURLWithPath: chunk.path)
      if readableRegularFile(storedURL) {
        resolved.append(chunk)
        continue
      }

      let relocatedURL = currentDir.appendingPathComponent("\(chunk.index).enc")
      guard readableRegularFile(relocatedURL) else {
        NSLog("[NativeBackupEngine] Missing staged chunk \(chunk.index) for \(asset.localAssetId); clearing staged upload")
        return nil
      }

      dbQueue.sync {
        guard admitsWrite(ticket, "updateStagedChunkPath") else { return }
        updateStagedChunkPath(
          assetId: asset.localAssetId,
          chunkIndex: chunk.index,
          path: relocatedURL.path
        )
      }
      resolved.append(StagedChunkRow(index: chunk.index, path: relocatedURL.path))
    }

    return resolved
  }

  private func currentAvailableBytes() -> Int64 {
    guard let url = try? stagingRootDirectory(),
          let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
          let available = values.volumeAvailableCapacityForImportantUsage else {
      return 0
    }
    return Int64(available)
  }

  private func stagedBytesOnDisk() -> Int64 {
    guard let root = try? stagingRootDirectory(),
          let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
          ) else { return 0 }

    var total: Int64 = 0
    for case let fileURL as URL in enumerator {
      let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      total += Int64(size)
    }
    return total
  }

  private func estimatedEncryptedBytes(plaintextBytes: Int64) -> Int64 {
    let chunks = max(1, Int64(ceil(Double(plaintextBytes) / Double(chunkSize))))
    return plaintextBytes + (chunks * 64)
  }

  private func canStageEncryptedAsset(plaintextBytes: Int64) -> Bool {
    let needed = estimatedEncryptedBytes(plaintextBytes: plaintextBytes)
    let available = currentAvailableBytes()
    guard available > 0 else { return true }
    if available - needed < minimumFreeBytesAfterStaging {
      return false
    }
    return stagedBytesOnDisk() + needed <= maxStagedBackupBytes
  }

  /// Task 1531 [P1-2]: belt-and-braces re-check, same reasoning as
  /// `uploadSingleAsset`'s top-of-function guard — this is the ONLY place a
  /// fresh staged row is created (`stagedAccountId:` below), so it must
  /// refuse independently of its caller having already checked. Refuses
  /// BEFORE any chunk file is moved into the staging directory (no disk
  /// write, no DB row) rather than staging untagged and hoping a later sweep
  /// catches it.
  ///
  /// `accountId` is the caller's `batchAccountId` (the account
  /// `processBatch` captured its `masterKey`/`authToken` for) — NOT a fresh
  /// read taken here. It is what gets WRITTEN as `stagedAccountId` below, so
  /// the tag always matches the key that actually did the encrypting. The
  /// LIVE `currentAccountId` is re-checked against it right here, right
  /// before the write, so an account switch between `processBatch`'s
  /// capture and this exact moment (the encrypt step above can take a
  /// while for a large video) is refused rather than silently tagged with
  /// a value that no longer describes who's signed in.
  private func stageEncryptedAsset(
    asset: BackupAssetRow,
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    originalSize: Int,
    chunkPaths: [String],
    accountId: String,
    ticket: ManifestWriteFence.Ticket
  ) throws -> BackupAssetRow {
    guard !accountId.isEmpty, currentAccountId == accountId else {
      RuntimeTrace.event("backup.native.stage.refused_no_account", [
        "assetId": asset.localAssetId,
        "batchAccount": accountId,
        "liveAccount": currentAccountId ?? "(nil)"
      ])
      NSLog("[NativeBackupEngine] Account changed since batch start — refusing to stage: \(asset.localAssetId)")
      throw BackupError.accountUnknown
    }

    let root = try stagingRootDirectory()
    let dir = root.appendingPathComponent(fileId, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    var stagedPaths: [String] = []
    for (index, path) in chunkPaths.enumerated() {
      let destination = dir.appendingPathComponent("\(index).enc")
      if FileManager.default.fileExists(atPath: destination.path) {
        try FileManager.default.removeItem(at: destination)
      }
      try FileManager.default.moveItem(at: URL(fileURLWithPath: path), to: destination)
      stagedPaths.append(destination.path)
    }

    // Round 8: a batch that outlived a sign-out (or an account switch) must
    // not put its staged row back; its ciphertext is removed instead.
    // LD-0002 (#262 review 4): the staged row and its chunk rows are ONE
    // transaction (`BackupManifestStore.recordStaging`).
    let recordedStaging: Bool = dbQueue.sync {
      guard admitsWrite(ticket, "markStaged") else { return false }
      return markStaged(
        assetId: asset.localAssetId,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: mimeType,
        isMediaValue: mediaFlag(assetType: asset.assetType, mimeType: mimeType),
        originalSize: Int64(originalSize),
        chunkPaths: stagedPaths,
        stagedDir: dir.path,
        stagedAccountId: accountId
      )
    }
    guard recordedStaging else {
      try? FileManager.default.removeItem(at: dir)
      try ensureBatchAdmitted(ticket)
      throw BackupError.accountUnknown
    }

    let staged = dbQueue.sync { getStagedAsset(localAssetId: asset.localAssetId) }
    // LD-0002 (#262 review 1): a staged row that reads as missing because the
    // gate closed is not the pre-staging row.
    if staged == nil { try ensureBatchAdmitted(ticket) }
    return staged ?? asset
  }

  private func uploadStagedAsset(
    _ asset: BackupAssetRow,
    authToken: String,
    baseURL: String,
    masterKey: MasterKeyHandle,
    /// Task 1531 [P1-2]: the account this batch (and this specific staged
    /// row — both call sites already verified `asset.stagedAccountId ==
    /// batchAccountId` before calling in) is trusted for. Re-checked against
    /// the LIVE `currentAccountId` right before any network call below, and
    /// again right before the upload is marked complete — the loop that PUTs
    /// chunks can run long enough for the account to change mid-upload.
    batchAccountId: String,
    /// Round 8: the batch's manifest write ticket.
    ticket: ManifestWriteFence.Ticket
  ) async throws -> Bool {
    try ensureBatchAdmitted(ticket)
    guard let fileId = asset.stagedFileId,
          let nameEncrypted = asset.stagedNameEncrypted,
          let stagedDir = asset.stagedDir else {
      dbQueue.sync {
        guard admitsWrite(ticket, "markPending") else { return }
        markPending(assetId: asset.localAssetId, error: "Missing staged backup metadata")
      }
      return false
    }
    guard currentAccountId == batchAccountId else {
      RuntimeTrace.event("backup.native.upload_staged.refused_account_changed", [
        "assetId": asset.localAssetId,
        "batchAccount": batchAccountId,
        "liveAccount": currentAccountId ?? "(nil)"
      ])
      NSLog("[NativeBackupEngine] Account changed since batch start — refusing to upload staged asset: \(asset.localAssetId)")
      return false
    }

    // `var` so the `.uploading` (resumable) self-heal below can re-bind to a freshly
    // revalidated set (paths may have been relocated by resolveStagedChunks).
    guard var chunks = resolveStagedChunks(asset: asset, fileId: fileId, ticket: ticket) else {
      dbQueue.sync {
        guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
        clearStagedStateForRestage(
          assetId: asset.localAssetId,
          error: "Encrypted staging files moved or expired; re-encrypting"
        )
      }
      if let currentDir = try? currentStagedDirectory(fileId: fileId) {
        try? FileManager.default.removeItem(at: currentDir)
      }
      if stagedDir != (try? currentStagedDirectory(fileId: fileId).path) {
        try? FileManager.default.removeItem(atPath: stagedDir)
      }
      updateBackupStatusSurfaces(reason: "Re-encrypting backup")
      return false
    }

    // Task 1589: `var` — a swept session (404 on a chunk PUT or complete)
    // re-inits under the SAME `fileId`, which can hand back a fresh
    // `uploadSessionId` (and, in principle, a `serverFileId`, though in
    // practice the server takes over the SAME id it was given).
    var serverFileId: String
    var uploadSessionId: String
    // Task 1589: the server's recommended heartbeat cadence for the CURRENT
    // session; set on every (re-)init below, kept at the default across a
    // pure resume (no fresh init call happens on that path).
    var heartbeatIntervalSecs = Self.defaultHeartbeatIntervalSecs
    let isResumingExistingRemote: Bool
    // Resume requires BOTH the file_id (remoteFileId) AND the v2 session id. A
    // row that has a file_id but no session id is a pre-migration remnant or a
    // half-written init — re-stage cleanly rather than guessing a session id.
    if let existing = asset.remoteFileId, !existing.isEmpty,
       let existingSession = asset.stagedUploadSessionId, !existingSession.isEmpty,
       // Task SF-0001 (2275 L13/A7c): resumable ONLY when the stored remote id
       // is the id this engine minted (`stagedFileId`). A pre-update session
       // stored whatever id the server echoed — it must never be resumed.
       existing == fileId {
      serverFileId = existing
      uploadSessionId = existingSession
      isResumingExistingRemote = true
    } else if let existing = asset.remoteFileId, !existing.isEmpty {
      // Task SF-0001 (2275 L13/A7c): no session id, or the stored id is not the
      // one this client minted (pre-update state, or the server changed it) —
      // never resumed.
      // mobile#259 review M10: an upload under OUR OWN id may have FINISHED
      // (its session id was lost, or the app died after the complete). Then
      // the photo is backed up: record it, as the resume path does, instead
      // of uploading it twice.
      // mobile#259 round 3: ONLY under our own id. Staging seals the name and
      // every chunk under `fileId`, so a finished upload under any other id is
      // one no reader can open; recording it would end the retries on a
      // backup that does not exist. A foreign id is always abandoned and the
      // photo staged again under our own.
      if existing == fileId,
         try await Self.isFinishedUpload(inspectExistingUpload(fileId: existing, authToken: authToken, baseURL: baseURL)) {
        let recorded: Bool = dbQueue.sync {
          guard admitsWrite(ticket, "markUploadComplete") else { return false }
          guard markUploadComplete(assetId: asset.localAssetId, remoteFileId: existing, accountId: batchAccountId) else {
            return false
          }
          deleteStagedChunks(assetId: asset.localAssetId)
          return true
        }
        guard recorded else {
          RuntimeTrace.event("backup.native.upload.record_failed", ["path": "pre_update_complete"])
          throw BackupError.databaseUnavailable
        }
        removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
        RuntimeTrace.event("backup.native.upload.pre_update_complete_recorded")
        updateBackupStatusSurfaces(reason: "Recovered completed backup")
        onFileStatus?(asset.localAssetId, "uploaded", nil, nil)
        await markOnServer(
          assetId: asset.localAssetId,
          fileId: existing,
          authToken: authToken,
          baseURL: baseURL,
          accountId: batchAccountId,
          ticket: ticket
        )
        generateAndUploadThumbnail(
          phAssetId: asset.localAssetId,
          serverFileId: existing,
          assetType: asset.assetType,
          mediaTypeHint: asset.stagedMimeType,
          masterKey: masterKey,
          authToken: authToken,
          baseURL: baseURL,
          accountId: batchAccountId
        )
        return true
      }
      await abandonUpload(fileId: existing, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)
      // Stale file_id without a session id (or with a foreign id) — drop it
      // and re-init below.
      dbQueue.sync {
        guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
        clearStagedStateForRestage(
          assetId: asset.localAssetId,
          error: "Upload session id missing for an existing remote; re-encrypting"
        )
      }
      removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
      updateBackupStatusSurfaces(reason: "Re-encrypting backup")
      return false
    } else {
      guard let parentFolderId, !parentFolderId.isEmpty else {
        RuntimeTrace.event("backup.native.upload_aborted", [
          "reason": "missing_parent_folder",
          "assetType": asset.assetType,
        ])
        dbQueue.sync {
          guard admitsWrite(ticket, "markPending") else { return }
          markPending(assetId: asset.localAssetId, error: "Missing backup destination folder")
        }
        updateBackupStatusSurfaces(reason: "Waiting for backup folder")
        return false
      }
      let session = try await initUploadSession(
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: asset.stagedMimeType,
        isMedia: asset.stagedIsMedia,
        createdAt: asset.createdAt,
        sizeBytes: Int(asset.stagedOriginalSize),
        chunkCount: asset.stagedChunkCount,
        authToken: authToken,
        baseURL: baseURL,
        accountId: batchAccountId
      )
      // Task SF-0001 (2275 L13/A7): the init answer must name the id this
      // engine proposed, and encrypted under — checked before ANY chunk PUT.
      // On a mismatch the session for the REQUESTED id is abandoned (mobile#259
      // review M5); nothing is sent to the echoed one.
      do {
        try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: session.fileId)
      } catch {
        await abandonUpload(fileId: fileId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)
        throw error
      }
      // mobile#259 review M10: the minted id, not the answer's (equal after the
      // check, and the answer is never the source of an id).
      serverFileId = fileId
      uploadSessionId = session.uploadSessionId
      heartbeatIntervalSecs = session.heartbeatIntervalSecs
      dbQueue.sync {
        guard admitsWrite(ticket, "markUploading") else { return }
        markUploading(
          assetId: asset.localAssetId,
          remoteFileId: serverFileId,
          uploadSessionId: uploadSessionId
        )
      }
      isResumingExistingRemote = false
    }

    if isResumingExistingRemote {
      switch try await inspectExistingUpload(
        fileId: serverFileId,
        authToken: authToken,
        baseURL: baseURL
      ) {
      // Round 15: the resume path keeps its old reading of a trashed file
      // (complete); only the resolution and the flush treat it as not
      // backed up.
      case .complete, .completeInTrash:
        let recorded: Bool = dbQueue.sync {
          guard admitsWrite(ticket, "markUploadComplete") else { return false }
          guard markUploadComplete(assetId: asset.localAssetId, remoteFileId: serverFileId, accountId: batchAccountId) else {
            return false
          }
          deleteStagedChunks(assetId: asset.localAssetId)
          return true
        }
        guard recorded else {
          RuntimeTrace.event("backup.native.upload.record_failed", ["path": "resume"])
          throw BackupError.databaseUnavailable
        }
        removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
        updateBackupStatusSurfaces(reason: "Recovered completed backup")
        onFileStatus?(asset.localAssetId, "uploaded", nil, nil)
        // Task 1667: record it in the server's per-device map so an emptied
        // manifest (sign-out, reinstall) can be rebuilt instead of re-uploaded.
        await markOnServer(
          assetId: asset.localAssetId,
          fileId: serverFileId,
          authToken: authToken,
          baseURL: baseURL,
          accountId: batchAccountId,
          ticket: ticket
        )
        generateAndUploadThumbnail(
          phAssetId: asset.localAssetId,
          serverFileId: serverFileId,
          assetType: asset.assetType,
          mediaTypeHint: asset.stagedMimeType,
          masterKey: masterKey,
          authToken: authToken,
          baseURL: baseURL,
          accountId: batchAccountId
        )
        return true

      case .gone:
        dbQueue.sync {
          guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
          clearStagedStateForRestage(
            assetId: asset.localAssetId,
            error: "Remote upload session disappeared; re-encrypting"
          )
        }
        removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
        updateBackupStatusSurfaces(reason: "Re-encrypting backup")
        return false

      case .uploading:
        // Self-heal a wedged resume. The server still reports this session
        // resumable, but iOS may have evicted the staged `.enc` files (Caches/
        // tmp are reclaimed under storage pressure) since we resolved `chunks`
        // above. Re-verify every non-complete chunk's staged file exists and is
        // non-zero via the same helper used on the initial staging check. If it
        // can no longer be reconciled, route to the re-stage branch (identical
        // to `.gone`): clear staged state, drop the old file_id, and
        // re-encrypt from scratch — instead of `markUploading` on an
        // unreconcilable session and then throwing on the missing-file PUT every
        // drain until the asset dead-letters at retry 10. The orphaned server
        // session is reaped by the server's stale_upload_cleanup worker.
        guard let revalidated = resolveStagedChunks(asset: asset, fileId: fileId, ticket: ticket) else {
          dbQueue.sync {
            guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
            clearStagedStateForRestage(
              assetId: asset.localAssetId,
              error: "Resumable session lost its staged chunks; re-encrypting"
            )
          }
          removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
          updateBackupStatusSurfaces(reason: "Re-encrypting backup")
          return false
        }
        chunks = revalidated
        dbQueue.sync {
          guard admitsWrite(ticket, "markUploading") else { return }
          markUploading(
            assetId: asset.localAssetId,
            remoteFileId: serverFileId,
            uploadSessionId: nil // COALESCE keeps the row's existing session id
          )
        }
      }
    }

    onFileStatus?(asset.localAssetId, "uploading", nil, nil)

    // Task 1589 — the gap this heartbeat covers is BETWEEN two chunk
    // requests, not one chunk's own (potentially very long) streaming body,
    // which the server already renews server-side while it streams.
    // Task 1600: explicit reference-type state (`HeartbeatPacer`), not a
    // captured `var` local — see the type's doc comment for why.
    let pacer = HeartbeatPacer(intervalSecs: heartbeatIntervalSecs)

    do {
      try await runChunksAndComplete(
        chunks,
        sessionId: uploadSessionId,
        expectedFileId: fileId,
        asset: asset,
        authToken: authToken,
        baseURL: baseURL,
        batchAccountId: batchAccountId,
        ticket: ticket,
        pacer: pacer
      )
    } catch is CancellationError {
      return false
    } catch {
      guard isBackupUploadSessionGone(error) else { throw error }

      // One bounded re-init: SAME file id (the encryption key derives from
      // it — no re-encrypt), restart every staged chunk from index 0. Never
      // a second time for this asset in this drain.
      perfLog("asset.session_swept", ["assetId": asset.localAssetId])
      let reinitSession = try await initUploadSession(
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: asset.stagedMimeType,
        isMedia: asset.stagedIsMedia,
        createdAt: asset.createdAt,
        sizeBytes: Int(asset.stagedOriginalSize),
        chunkCount: asset.stagedChunkCount,
        authToken: authToken,
        baseURL: baseURL,
        accountId: batchAccountId
      )
      // Task 1599 followup 1: the re-init MUST hand back the SAME file id —
      // `fileId` is what the staged `.enc` chunks (and the encrypted name)
      // were produced under; adopting a different server id here would
      // upload that ciphertext against the wrong file's identity. Checked
      // BEFORE any local/server state is mutated to reflect the new
      // session, so a mismatch fails this asset cleanly rather than
      // half-adopting it.
      guard reinitSession.fileId == fileId else {
        RuntimeTrace.event("backup.native.upload_staged.reinit_file_id_mismatch", [
          "assetId": asset.localAssetId
        ])
        NSLog("[NativeBackupEngine] Re-init file id mismatch — refusing: \(asset.localAssetId)")
        // mobile#259 round 3: as at the first init (review M5), the session
        // for the REQUESTED id is abandoned; nothing is sent to the echoed one.
        await abandonUpload(fileId: fileId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)
        throw BackupError.reinitFileIdMismatch
      }
      // mobile#259 round 3: the minted id (equal after the check).
      serverFileId = fileId
      uploadSessionId = reinitSession.uploadSessionId
      heartbeatIntervalSecs = reinitSession.heartbeatIntervalSecs
      pacer.intervalSecs = heartbeatIntervalSecs
      pacer.lastSentAt = Date()
      dbQueue.sync {
        guard admitsWrite(ticket, "markUploading") else { return }
        markUploading(
          assetId: asset.localAssetId,
          remoteFileId: serverFileId,
          uploadSessionId: uploadSessionId
        )
      }

      // Every staged `.enc` chunk (NOT just the ones local bookkeeping still
      // thought were pending) — the new session has nothing uploaded to it.
      var allStaged: [StagedChunkRow] = []
      let dir = (try? currentStagedDirectory(fileId: fileId)) ?? URL(fileURLWithPath: stagedDir)
      for index in 0..<asset.stagedChunkCount {
        let url = dir.appendingPathComponent("\(index).enc")
        guard readableRegularFile(url) else {
          dbQueue.sync {
            guard admitsWrite(ticket, "clearStagedStateForRestage") else { return }
            clearStagedStateForRestage(
              assetId: asset.localAssetId,
              error: "Staged chunk \(index) missing after a session re-init; re-encrypting"
            )
          }
          removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
          updateBackupStatusSurfaces(reason: "Re-encrypting backup")
          return false
        }
        allStaged.append(StagedChunkRow(index: index, path: url.path))
      }
      dbQueue.sync {
        guard admitsWrite(ticket, "replaceStagedChunks") else { return }
        replaceStagedChunks(assetId: asset.localAssetId, fileId: fileId, chunkPaths: allStaged.map { $0.path })
      }

      do {
        try await runChunksAndComplete(
          allStaged,
          sessionId: uploadSessionId,
          expectedFileId: fileId,
          asset: asset,
          authToken: authToken,
          baseURL: baseURL,
          batchAccountId: batchAccountId,
          ticket: ticket,
          pacer: pacer
        )
      } catch is CancellationError {
        return false
      } catch {
        // A second sweep in a row: bounded — never re-init again. Routes to
        // the caller's generic `catch { markFailed }` (retry_count+1, status
        // back to `pending_upload`/`staged_upload` — failed-retryable, never
        // left stuck "uploading").
        guard isBackupUploadSessionGone(error) else { throw error }
        throw BackupError.uploadSessionGoneTwice
      }
    }

    let recorded: Bool = dbQueue.sync {
      guard admitsWrite(ticket, "markUploadComplete") else { return false }
      guard markUploadComplete(assetId: asset.localAssetId, remoteFileId: serverFileId, accountId: batchAccountId) else {
        return false
      }
      deleteStagedChunks(assetId: asset.localAssetId)
      return true
    }
    // Round 7 sweep: nothing staged is deleted for an upload the manifest
    // did not record (see `markUploadComplete`).
    guard recorded else {
      RuntimeTrace.event("backup.native.upload.record_failed", ["path": "complete"])
      throw BackupError.databaseUnavailable
    }
    removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
    // Task 1667: see the resume branch above.
    await markOnServer(
      assetId: asset.localAssetId,
      fileId: serverFileId,
      authToken: authToken,
      baseURL: baseURL,
      accountId: batchAccountId,
      ticket: ticket
    )

    updateBackupStatusSurfaces()
    perfLog("asset.finish", [
      "bytes": asset.stagedOriginalSize,
      "chunks": asset.stagedChunkCount
    ])

    onFileStatus?(asset.localAssetId, "uploaded", nil, nil)
    NSLog("[NativeBackupEngine] Uploaded staged asset (\(asset.stagedOriginalSize) bytes, \(asset.stagedChunkCount) chunks)")

    generateAndUploadThumbnail(
      phAssetId: asset.localAssetId,
      serverFileId: serverFileId,
      assetType: asset.assetType,
      mediaTypeHint: asset.stagedMimeType,
      masterKey: masterKey,
      authToken: authToken,
      baseURL: baseURL,
      accountId: batchAccountId
    )

    return true
  }

  // Task 1589: extracted so a swept v2 session (404 — server PR #120's
  // sweeper, or the legacy 400 "not writable: expired") can be recovered by
  // re-initing the SAME file id and re-PUTting every ALREADY-STAGED chunk
  // (no re-encrypt needed — the file key derives from `fileId`, unchanged
  // by the takeover) from index 0, at most once per attempt.
  //
  // Task 1600: a private instance method with fully explicit parameters,
  // not a local function nested inside `uploadStagedAsset`. It used to
  // capture `asset`/`authToken`/`baseURL`/`batchAccountId` from the
  // enclosing scope and call a `[weak self]` async closure that itself
  // captured and mutated a `var` local across `await` points — that capture
  // chain is the prime suspect for the build-224 EXC_BAD_ACCESS crash (see
  // `HeartbeatPacer`'s doc comment). This method captures nothing but
  // `self`.
  private func runChunksAndComplete(
    _ chunksToSend: [StagedChunkRow],
    sessionId: String,
    /// Task SF-0001: the id this engine minted for the asset; the completion
    /// answer must name it.
    expectedFileId: String,
    asset: BackupAssetRow,
    authToken: String,
    baseURL: String,
    batchAccountId: String,
    ticket: ManifestWriteFence.Ticket,
    pacer: HeartbeatPacer
  ) async throws {
    // v2 chunk PUTs are idempotent (INSERT…ON CONFLICT DO UPDATE), so
    // re-sending an already-stored chunk on a resume is safe. `chunksToSend`
    // already excludes chunks the local bookkeeping marked 'uploaded'
    // (getPendingStagedChunks), so a resume only re-drives the genuinely-
    // incomplete tail.
    for chunk in chunksToSend {
      guard isRunning && !Task.isCancelled else { throw CancellationError() }
      await heartbeatIfDue(pacer: pacer, sessionId: sessionId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)
      try await uploadStagedChunk(
        localAssetId: asset.localAssetId,
        uploadSessionId: sessionId,
        chunkIndex: chunk.index,
        fileURL: URL(fileURLWithPath: chunk.path),
        authToken: authToken,
        baseURL: baseURL,
        accountId: batchAccountId,
        ticket: ticket
      )
    }

    // LD-0002 (#262 review 5): with the gate closed this count reads 0, which
    // would send `upload/complete` for chunks whose results were never
    // recorded.
    try ensureBatchAdmitted(ticket)
    let remaining = dbQueue.sync { countPendingStagedChunks(assetId: asset.localAssetId) }
    try ensureBatchAdmitted(ticket)
    guard remaining == 0 else {
      // The re-PUT loop finished but the local bookkeeping still reports chunks
      // pending. Surface a diagnosable error with the offending indices instead
      // of returning false silently — the silence is exactly why this wedge was
      // invisible (no error status, no log line) while it spun every drain until
      // the asset dead-lettered at retry 10. Throwing routes to markFailed with
      // a concrete message and still re-stages on a later attempt.
      let unreconciled = dbQueue.sync { getPendingStagedChunks(assetId: asset.localAssetId) }
        .map { $0.index }
      throw BackupError.unreconciledChunks(unreconciled)
    }

    // Task 1531 [P1-2]: re-check right before the one irreversible step. The
    // chunk PUT loop above can run long enough (large video, slow network)
    // for the account to change mid-upload; refusing here — before
    // `upload/complete` and before `markUploadComplete` writes the local
    // row as done — means a stale upload never gets marked finished under
    // the wrong account's bookkeeping. The already-PUT chunks on the server
    // are reaped by the server's stale-upload cleanup, same as any other
    // abandoned session.
    guard currentAccountId == batchAccountId else {
      RuntimeTrace.event("backup.native.upload_staged.refused_account_changed", [
        "assetId": asset.localAssetId,
        "batchAccount": batchAccountId,
        "liveAccount": currentAccountId ?? "(nil)",
        "stage": "pre_complete"
      ])
      NSLog("[NativeBackupEngine] Account changed mid-upload — refusing to complete: \(asset.localAssetId)")
      throw CancellationError()
    }

    await heartbeatIfDue(pacer: pacer, sessionId: sessionId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)
    try await completeUpload(
      uploadSessionId: sessionId,
      expectedFileId: expectedFileId,
      authToken: authToken,
      baseURL: baseURL,
      accountId: batchAccountId
    )
  }

  /// Task 1600: plain private instance method (no captures beyond `self`),
  /// replacing the `[weak self]` async closure that used to capture and
  /// mutate a `var lastHeartbeatAt` local from `uploadStagedAsset`.
  private func heartbeatIfDue(
    pacer: HeartbeatPacer,
    sessionId: String,
    authToken: String,
    baseURL: String,
    accountId: String
  ) async {
    guard Date().timeIntervalSince(pacer.lastSentAt) >= pacer.intervalSecs else { return }
    await sendHeartbeat(uploadSessionId: sessionId, authToken: authToken, baseURL: baseURL, accountId: accountId)
    pacer.lastSentAt = Date()
  }

  private func removeStagedDirectory(stagedDir: String, fileId: String) {
    try? FileManager.default.removeItem(atPath: stagedDir)
    if let currentDir = try? currentStagedDirectory(fileId: fileId),
       stagedDir != currentDir.path {
      try? FileManager.default.removeItem(at: currentDir)
    }
  }

  /// mobile#259 round 3: what the resume path reads as "this backup is done"
  /// (`.complete`, and a trashed file too, round 15), for the lost-session
  /// recovery to read the same way.
  static func isFinishedUpload(_ state: PhotoBackupServerResponses.ExistingUpload) -> Bool {
    switch state {
    case .complete, .completeInTrash: return true
    default: return false
    }
  }

  /// Decide how to resume an upload whose session was opened in a prior pass.
  ///
  /// v2 has no session-status GET (only init/chunks/complete), so we read the
  /// durable file row via GET /api/v1/files/{file_id}
  /// (`PhotoBackupServerResponses.existingUpload`):
  ///   • 404 with the API's NotFound body → `.gone`      (file gone — re-stage)
  ///   • is_uploading == false             → `.complete` / `.completeInTrash`
  ///   • is_uploading == true              → `.uploading` (re-PUT the
  ///                             non-uploaded tail, then POST complete — chunk
  ///                             PUTs are idempotent)
  ///   • anything else (a non-API 404, a body without the booleans, 5xx, a
  ///     timeout) THROWS: the caller keeps the row and retries later
  ///     (task 1667 round 15, review item 2: it used to read any 404 as gone
  ///     and a 2xx without `is_uploading` as resumable, and the sign-in
  ///     resolution then dropped a kept row and uploaded the photo again).
  ///   • 429 → throws after setting `backoffUntil` from `Retry-After`.
  /// The "which chunks to re-send" decision is purely LOCAL: the caller drives
  /// only chunks the local `backup_upload_chunks` table still marks pending.
  /// This is correct without a server status GET because v2 chunk PUTs are
  /// idempotent — re-sending a chunk the server already stored is a no-op
  /// (`skipped:true`), and `complete` validates the full set server-side and
  /// fails loudly if any chunk is genuinely missing, which routes back to a
  /// re-stage. No silent partial-file completion is possible.
  private func inspectExistingUpload(
    fileId: String,
    authToken: String,
    baseURL: String,
    /// Task 1667 round 14: the sign-out flush hands the budget it has left.
    requestTimeout: TimeInterval? = nil
  ) async throws -> PhotoBackupServerResponses.ExistingUpload {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.httpMethod = "GET"
    if let requestTimeout { request.timeoutInterval = requestTimeout }
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await metadataSession.data(for: request)
    let http = response as? HTTPURLResponse
    let statusCode = http?.statusCode ?? 0
    do {
      let state = try PhotoBackupServerResponses.existingUpload(
        statusCode: statusCode,
        contentType: http?.value(forHTTPHeaderField: "Content-Type"),
        retryAfter: http?.value(forHTTPHeaderField: "Retry-After"),
        data: data
      )
      // Task SF-0001 (mobile#259 review M6): an answer about a file must be
      // about THAT file. Without this, an upload whose completion answer named
      // another item (the asset stays failed) was marked complete by the next
      // resume's `.complete` here, with no echo check at all.
      if state != .gone {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: body?["id"] as? String, stage: .completion)
      }
      return state
    } catch let limited as PhotoBackupServerResponses.RateLimited {
      // Round 15 (review item 2): the server's Retry-After is honoured; the
      // rebuild gate's deferral never shortens it (`ManifestRebuildGate
      // .backoffDeadline`).
      backoffUntil = Date().addingTimeInterval(limited.retryAfter ?? 60)
      throw BackupError.httpStatus(429, "Rate limited")
    } catch let unexpected as PhotoBackupServerResponses.UnexpectedResponse {
      RuntimeTrace.event("backup.native.inspect_upload.unexpected", [
        "status": statusCode, "reason": unexpected.reason,
      ])
      throw BackupError.httpStatus(statusCode, unexpected.reason)
    }
  }

  private func uploadStagedChunk(
    localAssetId: String,
    uploadSessionId: String,
    chunkIndex: Int,
    fileURL: URL,
    authToken: String,
    baseURL: String,
    /// Task 1599: the caller's confirmed batch/account id
    /// (`uploadStagedAsset`'s `batchAccountId`, itself re-checked against
    /// the LIVE `currentAccountId` immediately before this call) — never a
    /// fresh, unchecked read taken here. Refused (not silently sent
    /// header-less) when empty: an upload with no confirmed owner must not
    /// reach the network at all.
    accountId: String,
    /// Round 8: the batch's manifest write ticket, kept for this chunk's
    /// completion callback.
    ticket: ManifestWriteFence.Ticket
  ) async throws {
    guard !accountId.isEmpty else {
      RuntimeTrace.event("backup.native.upload_chunk.refused_no_account")
      throw BackupError.accountUnknown
    }
    guard fileURL.isFileURL,
          FileManager.default.isReadableFile(atPath: fileURL.path) else {
      throw BackupError.assetLoadFailed
    }

    // v2 chunk route: PUT /api/v1/uploads/{session}/chunks/{index} — streams the
    // body to storage and fail-fasts with 408 storage.upload_stalled on an idle
    // body, instead of the legacy /files/{id}/chunks/{n} route that let a 0-byte
    // body hang for ~22 min and leak an is_uploading orphan.
    guard let url = URL(string: "\(baseURL)/api/v1/uploads/\(uploadSessionId)/chunks/\(chunkIndex)") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "PUT"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

    let description = BackgroundChunkTaskDescription(
      localAssetId: localAssetId,
      uploadSessionId: uploadSessionId,
      chunkIndex: chunkIndex
    )

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let task = backgroundSession.uploadTask(with: request, fromFile: fileURL)
      if let data = try? JSONEncoder().encode(description),
         let encoded = String(data: data, encoding: .utf8) {
        task.taskDescription = encoded
      }
      chunkUploadContinuations[task.taskIdentifier] = continuation
      chunkTaskTickets[task.taskIdentifier] = ticket
      dbQueue.async { [weak self] in
        guard let self, self.admitsWrite(ticket, "markChunkUploading") else { return }
        self.markChunkUploading(assetId: localAssetId, chunkIndex: chunkIndex, taskId: task.taskIdentifier)
      }
      task.resume()
    }
  }

  // MARK: - Encryption

  // NOTE: the old `encryptData(data:fileKey:)` 4 MiB chunk loop was removed in
  // task 0672 — the camera-roll pipeline now encrypts via the shared core
  // `ChunkEncryptorHandle` ladder (see the staging path above). The single-frame
  // thumbnail encrypt still uses `fileKey.encryptChunk` directly (that is a
  // single AES-GCM blob, not a chunk loop, and is correct as-is).

  // MARK: - PHAsset Data Fetch

  private func fetchAssetData(localId: String) async throws -> (Data, String) {
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
    guard let phAsset = fetchResult.firstObject else {
      throw BackupError.assetNotFound
    }

    return try await withCheckedThrowingContinuation { continuation in
      let options = PHImageRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      options.deliveryMode = .highQualityFormat

      PHImageManager.default().requestImageDataAndOrientation(for: phAsset, options: options) { data, uti, _, info in
        Self.phkitCallbackQueue.async {
          if let error = info?[PHImageErrorKey] as? Error {
            continuation.resume(throwing: error)
          } else if let data = data {
            continuation.resume(returning: (data, uti ?? "public.jpeg"))
          } else {
            continuation.resume(throwing: BackupError.assetLoadFailed)
          }
        }
      }
    }
  }

  /// Resolve the original file or export a composition to disk, never to Data.
  private func fetchVideoFileSource(localId: String) async throws -> BackupVideoFileSource {
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
    guard let phAsset = fetchResult.firstObject, phAsset.mediaType == .video else {
      throw BackupError.assetNotFound
    }
    let (asset, mix): (AVAsset, AVAudioMix?) = try await withCheckedThrowingContinuation { continuation in
      let options = PHVideoRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { asset, mix, info in
        Self.phkitCallbackQueue.async {
          if let error = info?[PHImageErrorKey] as? Error { continuation.resume(throwing: error) }
          else if let asset { continuation.resume(returning: (asset, mix)) }
          else { continuation.resume(throwing: BackupError.assetLoadFailed) }
        }
      }
    }
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("beebeeb-photokit-cache", isDirectory: true)
    return try await BackupVideoFileSource.resolve(asset: asset, audioMix: mix, exportDirectory: directory)
  }

  // MARK: - API Calls (metadata session — standard URLSession, not background)

  /// Open a v2 upload session (POST /api/v1/uploads/init). Returns both the
  /// `upload_session_id` (the chunk/complete route anchor) and the durable
  /// `file_id`. The v2 init derives the chunk plan server-side from
  /// `profile` ("mobile") + `file_size_bytes`, which matches the core "mobile"
  /// plan the asset was staged with (same source of truth), so we omit the
  /// chunk_count/chunk_size pair and let the server compute it — then assert the
  /// returned count equals the staged count to catch any drift early.
  private func initUploadSession(
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    isMedia: Bool,
    createdAt: String,
    sizeBytes: Int,
    chunkCount: Int,
    authToken: String,
    baseURL: String,
    /// Task 1599: the caller's confirmed batch/account id — see
    /// `uploadStagedChunk`'s matching parameter doc.
    accountId: String
  ) async throws -> UploadSessionInit {
    guard !accountId.isEmpty else {
      RuntimeTrace.event("backup.native.init_upload.refused_no_account")
      throw BackupError.accountUnknown
    }
    guard let url = URL(string: "\(baseURL)/api/v1/uploads/init") else {
      throw BackupError.invalidServerURL
    }

    var body: [String: Any] = [
      // v2 names `name_encrypted` as `file_name`; `size_bytes` as
      // `file_size_bytes` (= plaintext byte count — server recomputes stored
      // size from the chunks). `file_id` is honored so thumbnails + name
      // envelope stay bound to the same id we encrypted under.
      "file_id": fileId,
      "file_name": nameEncrypted,
      "file_size_bytes": sizeBytes,
      "profile": Self.chunkProfile,
      "is_media": isMedia,
      "created_at": normalizedCreatedAt(createdAt),
    ]
    if let parentFolderId, !parentFolderId.isEmpty {
      body["parent_id"] = parentFolderId
    }
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
      throw BackupError.jsonEncoding
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = bodyData

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    // Task 1599: checked BEFORE the generic 429/status handling below — this
    // route can also 409 for an unrelated reason (a live foreign lease, task
    // 1589 — "upload is already in progress for this file"), so the body must
    // be inspected, never a bare `statusCode == 409`.
    if statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
      handleConfirmedAccountMismatch()
      throw BackupError.accountMismatchConfirmed
    }

    // Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): this route is
    // ALSO gated by `ensure_can_upload` (server PR #129) — a typed 409 for
    // an account that cannot store data right now for a billing reason.
    // Checked before the generic 429/status handling below, same reason as
    // the account_mismatch check above: a bare status code can't
    // distinguish this from the unrelated 1589 "live foreign lease" 409.
    if statusCode == 409, let code = AccountRefusalDetection.accountRefusalCode(data) {
      handleConfirmedAccountRefusal(code: code)
      throw BackupError.accountRefused(code: code)
    }
    // Task 1605 — the sibling 413: the 25 GB never-paid-trial cap. Checked
    // before the generic status handling for the same reason — an ordinary
    // out-of-plan-quota 413 must NOT take this branch (it stays a generic
    // retryable failure, unchanged by this task).
    if statusCode == 413, AccountRefusalDetection.isTrialCapQuotaExceeded(data) {
      // The server's own cap (`limit_bytes`), purchase-free copy shared word for
      // word with the JS path (PR #168 review).
      let message = AccountRefusalDetection.trialCapMessage(limitBytes: AccountRefusalDetection.trialCapLimitBytes(data))
      handleConfirmedTrialCapExceeded(message: message)
      throw BackupError.trialCapExceeded(message: message)
    }

    // Handle rate limiting
    if statusCode == 429 {
      if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
         let seconds = Double(retryAfter) {
        backoffUntil = Date().addingTimeInterval(seconds)
      } else {
        backoffUntil = Date().addingTimeInterval(60)
      }
      throw BackupError.httpStatus(429, "Rate limited")
    }

    guard (200..<300).contains(statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw BackupError.httpStatus(statusCode, body)
    }

    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let uploadSessionId = json["upload_session_id"] as? String,
          !uploadSessionId.isEmpty,
          let serverFileId = json["file_id"] as? String,
          !serverFileId.isEmpty else {
      throw BackupError.invalidResponse
    }

    let serverChunkCount = (json["chunk_count"] as? Int) ?? chunkCount
    if serverChunkCount != chunkCount {
      // The server-derived plan disagrees with what we staged — re-staging under
      // the server plan is the only safe recovery. Surface as invalidResponse so
      // the caller routes to the re-stage branch rather than PUTting a mismatched
      // chunk set.
      NSLog("[NativeBackupEngine] init chunk_count mismatch: staged=\(chunkCount) server=\(serverChunkCount)")
      throw BackupError.invalidResponse
    }

    // Task 1589 — server PR #120 returns this on every init; fall back to the
    // documented default (lease 3600 s / 3) for a pre-#120 server.
    let heartbeatIntervalSecs = (json["heartbeat_interval_secs"] as? Double)
      ?? (json["heartbeat_interval_secs"] as? Int).map(Double.init)
      ?? Self.defaultHeartbeatIntervalSecs

    return UploadSessionInit(
      uploadSessionId: uploadSessionId,
      fileId: serverFileId,
      chunkCount: serverChunkCount,
      heartbeatIntervalSecs: heartbeatIntervalSecs
    )
  }

  /// Task 1589 — conservative fallback when a server response omits
  /// `heartbeat_interval_secs` (pre-#120).
  private static let defaultHeartbeatIntervalSecs: Double = 90

  /// Task 1589 — renew a v2 upload session's lease directly (server PR #120,
  /// `POST /uploads/{id}/heartbeat`), for the gap BETWEEN two chunk requests
  /// on the same session (the loop below scheduling the next chunk, a brief
  /// pause the process survives). A single chunk's own in-flight body already
  /// renews its own lease server-side while it streams (up to 256 MiB per
  /// chunk on the Backup profile) — this covers everything else. Best-effort:
  /// errors are swallowed, never thrown — a missed renewal just means the
  /// NEXT chunk/complete may see a 404 and go through the re-init path in
  /// `uploadStagedAsset`, which is exactly the recovery this task adds.
  private func sendHeartbeat(
    uploadSessionId: String,
    authToken: String,
    baseURL: String,
    /// Task 1599: the caller's confirmed batch/account id — see
    /// `uploadStagedChunk`'s matching parameter doc. A best-effort renewal
    /// with no confirmed owner is skipped outright (not sent header-less):
    /// a missed renewal here is harmless (the doc comment above already
    /// covers the recovery path), so refusing is strictly safer than
    /// guessing.
    accountId: String
  ) async {
    guard !accountId.isEmpty else {
      RuntimeTrace.event("backup.native.upload_heartbeat.refused_no_account")
      return
    }
    guard let url = URL(string: "\(baseURL)/api/v1/uploads/\(uploadSessionId)/heartbeat") else { return }
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)
    do {
      let (data, response) = try await metadataSession.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      // Task 1599: this route also 409s for "session exists but already
      // completed" (server `heartbeat_upload`, unrelated to account
      // ownership) — the body must be checked, never a bare status code.
      if statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
        handleConfirmedAccountMismatch()
        NSLog("[NativeBackupEngine] heartbeat refused: account mismatch")
      }
    } catch {
      NSLog("[NativeBackupEngine] heartbeat failed (best-effort): \(error.localizedDescription)")
    }
  }

  // NOTE: the legacy in-process `uploadChunk(...)` helper (PUT
  // /files/{id}/chunks/{n} via the async `backgroundSession.upload(for:fromFile:)`
  // convenience) was removed in the v2 migration. It had no callers — the live
  // path is `uploadStagedChunk` via the delegate/continuation pattern — and kept
  // a reference to the legacy route alive. The single chunk-PUT surface is now
  // `uploadStagedChunk` on /uploads/{session}/chunks/{i}.

  private func completeUpload(
    uploadSessionId: String,
    /// Task SF-0001 (2275 L13/A7): the id this engine proposed. The completion
    /// answer must name it before the row is marked done.
    expectedFileId: String,
    authToken: String,
    baseURL: String,
    /// Task 1599: the caller's confirmed batch/account id — see
    /// `uploadStagedChunk`'s matching parameter doc. This is the one
    /// irreversible step (`uploadStagedAsset` already re-checks
    /// `currentAccountId == batchAccountId` right before calling in — see
    /// that call site's own comment), so an empty/unconfirmed id refuses
    /// here too rather than completing under an unknown identity.
    accountId: String
  ) async throws {
    guard !accountId.isEmpty else {
      RuntimeTrace.event("backup.native.complete_upload.refused_no_account")
      throw BackupError.accountUnknown
    }
    guard let url = URL(string: "\(baseURL)/api/v1/uploads/\(uploadSessionId)/complete") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    if statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
      handleConfirmedAccountMismatch()
      throw BackupError.accountMismatchConfirmed
    }
    // Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): server PR
    // #129's review added an `ensure_can_upload` re-check to THIS route too
    // (`routes/uploads.rs::complete_upload`) — a session opened before a
    // never-paid trial's cancellation must not be able to FINALIZE after
    // it, even if every chunk already landed. Same typed-body check as
    // `initUploadSession`'s.
    if statusCode == 409, let code = AccountRefusalDetection.accountRefusalCode(data) {
      handleConfirmedAccountRefusal(code: code)
      throw BackupError.accountRefused(code: code)
    }

    guard (200..<300).contains(statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw BackupError.httpStatus(statusCode, body)
    }

    // Task SF-0001 (2275 L13/A7): the completion answer names the item it
    // finalized. It must be the id this client proposed — otherwise abort
    // before the row is marked complete under someone else's identity.
    let echoedId = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    try UploadItemIdEcho.assertEchoedId(
      chosen: expectedFileId,
      echoed: (echoedId?["id"] as? String),
      stage: .completion
    )
  }

  /// Task SF-0001 (2275 L13/A7c): best-effort abandonment of a persisted
  /// upload session whose id this client did not mint. Never throws — an
  /// expired session is already gone server-side.
  private func abandonUpload(
    fileId: String,
    authToken: String,
    baseURL: String,
    accountId: String
  ) async {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)/upload/abandon") else { return }
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)
    _ = try? await metadataSession.data(for: request)
  }

  // MARK: - SQLite Database

  /// Open the same database that React Native reads for backup insights.
  /// expo-sqlite stores databases in <documentDir>/SQLite/<name>.
  /// `<Documents>/SQLite/beebeeb-backup.db` — expo-sqlite's location for the
  /// JS layer's `openDatabaseAsync('beebeeb-backup.db')`, so both share it.
  static func backupDatabaseURL() -> URL {
    let documentDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    return documentDir
      .appendingPathComponent("SQLite", isDirectory: true)
      .appendingPathComponent("beebeeb-backup.db", isDirectory: false)
  }

  /// The launch open, enqueued once from `init()`. Every later open goes
  /// through `openManifestIfClosed` (task 1667 round 6): `start()` and the
  /// background task call it, and so does the recovery after a failed
  /// sign-out reset. A pending sign-out reset is applied first, and a file
  /// that cannot be opened, read or emptied leaves no handle open
  /// (`BackupManifestHandle.openIfClosed`).
  private func openDatabase() {
    let failure = manifestHandle.openIfClosed()
    RuntimeTrace.event("backup.native.manifest.open", [
      "trigger": "init",
      "ok": failure == nil,
      "failure": failure?.rawValue ?? NSNull(),
      "appliedPendingReset": failure == nil && manifestHandle.lastOpenAppliedPendingReset,
    ])
    if let failure {
      NSLog("[NativeBackupEngine] Backup manifest could not be opened at launch (\(failure.rawValue)); start() retries")
    }
  }

  /// Task 1667 round 6: opens the manifest when its handle is closed. MUST
  /// run on `dbQueue`. nil = a handle is open on return.
  private func openManifestIfClosed(trigger: String) -> BackupManifestHandle.OpenFailure? {
    let wasOpen = manifestHandle.isOpen
    let failure = manifestHandle.openIfClosed()
    if !wasOpen {
      RuntimeTrace.event("backup.native.manifest.open", [
        "trigger": trigger,
        "ok": failure == nil,
        "failure": failure?.rawValue ?? NSNull(),
        "appliedPendingReset": failure == nil && manifestHandle.lastOpenAppliedPendingReset,
      ])
    }
    return failure
  }

  /// The manifest schema. Static and handed the handle (round 6) so
  /// `BackupManifestHandle` runs it on every open, not just the first.
  static func ensureTables(_ db: OpaquePointer) {
    let sql = """
    CREATE TABLE IF NOT EXISTS backup_assets (
      local_asset_id TEXT PRIMARY KEY,
      remote_file_id TEXT,
      remote_path TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      uploaded_at TEXT,
      asset_type TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at INTEGER,
      last_attempt_at INTEGER,
      retry_count INTEGER DEFAULT 0,
      error_message TEXT,
      staged_file_id TEXT,
      staged_name_encrypted TEXT,
      staged_mime_type TEXT,
      staged_is_media INTEGER DEFAULT 0,
      staged_original_size INTEGER DEFAULT 0,
      staged_chunk_count INTEGER DEFAULT 0,
      staged_dir TEXT,
      staged_at INTEGER,
      upload_session_id TEXT,
      selected_for_backup INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS backup_upload_chunks (
      local_asset_id TEXT NOT NULL,
      server_file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id INTEGER,
      last_error TEXT,
      uploaded_at INTEGER,
      PRIMARY KEY(local_asset_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_backup_assets_status_type
      ON backup_assets(status, asset_type);
    CREATE INDEX IF NOT EXISTS idx_backup_assets_created_at
      ON backup_assets(created_at);
    CREATE INDEX IF NOT EXISTS idx_backup_upload_chunks_asset_status
      ON backup_upload_chunks(local_asset_id, status);
    """
    exsqlite3_exec(db, sql, nil, nil, nil)

    let migrations = [
      "ALTER TABLE backup_assets ADD COLUMN staged_file_id TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_name_encrypted TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_mime_type TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_is_media INTEGER DEFAULT 0",
      "ALTER TABLE backup_assets ADD COLUMN staged_original_size INTEGER DEFAULT 0",
      "ALTER TABLE backup_assets ADD COLUMN staged_chunk_count INTEGER DEFAULT 0",
      "ALTER TABLE backup_assets ADD COLUMN staged_dir TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_at INTEGER",
      "ALTER TABLE backup_assets ADD COLUMN upload_session_id TEXT",
      "ALTER TABLE backup_assets ADD COLUMN selected_for_backup INTEGER DEFAULT 1",
      // Task 1531 [P0]: tags which account's master key encrypted the staged
      // chunks + name envelope. See purgeMismatchedStagedAssets below.
      "ALTER TABLE backup_assets ADD COLUMN staged_account_id TEXT",
    ]
    for migration in migrations {
      exsqlite3_exec(db, migration, nil, nil, nil)
    }
    // Task 1667: uploaded_account_id + server_marked_at.
    BackupManifestStore.migrate(db)

    migratePhotoKitMissingAssetRows(db, nowMs: BackupManifestStore.currentMs())
  }

  private static func migratePhotoKitMissingAssetRows(_ db: OpaquePointer, nowMs: Int64) {
    let sql = """
    UPDATE backup_assets
    SET status = 'local_missing',
        retry_count = 0,
        error_message = 'Photo no longer on this iPhone or no longer shared with Beebeeb',
        last_attempt_at = ?
    WHERE status != 'uploaded'
      AND (
        error_message LIKE '%Photo asset not found%'
        OR error_message LIKE '%not found in library%'
      )
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int64(stmt, 1, nowMs)
    exsqlite3_step(stmt)
    let changed = exsqlite3_changes(db)
    if changed > 0 {
      NSLog("[NativeBackupEngine] Moved \(changed) missing PhotoKit asset rows to local_missing")
    }
  }

  /// The manifest rows for scanned PhotoKit assets (the statement lives in
  /// `BackupManifestStore.insertScannedAssets`, behind the fence in
  /// `FencedManifestWrites.scanInsert`).
  private func scannedAssets(_ assets: [PHAsset]) -> [BackupManifestStore.ScannedAsset] {
    assets.map { asset in
      BackupManifestStore.ScannedAsset(
        localAssetId: asset.localIdentifier,
        createdAt: isoString(from: asset.creationDate ?? Date()),
        assetType: asset.mediaType == .video ? "video" : "photo"
      )
    }
  }

  /// Records a scan insert's outcome. MUST run on `dbQueue`, in the block
  /// that wrote. Round 7 sweep: a failed insert is recorded
  /// (`scanInsertHealth`) and traced, never read as a complete one.
  /// Round 10: sticky until a FULL scan inserts successfully.
  /// Round 8: a fenced insert wrote nothing and changes nothing (the trace
  /// is the fence's).
  private func recordScanInsert(
    _ written: FencedManifestWrites.ScanWrite, assets: Int, source: ScanInsertHealth.Source
  ) {
    switch written {
    case .fenced, .noHandle:
      return
    case .written(let inserted, let entered):
      manifestHandle.scanInsertHealth.record(inserted: inserted, source: source)
      if !inserted {
        RuntimeTrace.event("backup.native.scan.insert_failed", ["assets": assets])
      } else if entered > 0 {
        // Round 11 (review finding 9): new rows owe a bulk check. Round 12
        // (review item 10): only rows that ENTERED the queue (new, or back
        // from local_missing); `assets` is the scanned count, and every full
        // scan re-upserts the whole library.
        requestBulkServerCheck()
      }
    }
  }

  /// Get pending uploads ordered by creation date (newest first), respecting retry limits.
  func getPendingUploads(limit: Int) -> [BackupAssetRow] {
    guard let db = db else { return [] }
    var results: [BackupAssetRow] = []

    let sql = """
    SELECT local_asset_id, remote_file_id, asset_type, content_hash, file_size, created_at,
           COALESCE(retry_count, 0), error_message,
           staged_file_id, staged_name_encrypted, staged_mime_type,
           COALESCE(staged_is_media, 0), COALESCE(staged_original_size, 0),
           COALESCE(staged_chunk_count, 0), staged_dir, upload_session_id, staged_account_id
    FROM backup_assets
    WHERE status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading')
      AND COALESCE(selected_for_backup, 1) = 1
      AND COALESCE(retry_count, 0) < 10
    ORDER BY created_at DESC
    LIMIT ?
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int(stmt, 1, Int32(limit))

    var rc = exsqlite3_step(stmt)
    while rc == SQLITE_ROW {
      results.append(backupAssetRow(from: stmt))
      rc = exsqlite3_step(stmt)
    }
    // LD-0002 rule 3: an expiry interrupted this read (thread 17 of the 252
    // crash was here). No rows: the batch ends and every row stays pending.
    if rc == SQLITE_INTERRUPT { return [] }

    return results
  }

  private func backupAssetRow(from stmt: OpaquePointer?) -> BackupAssetRow {
    let localAssetId = String(cString: exsqlite3_column_text(stmt, 0))
    let remoteFileId: String? = exsqlite3_column_type(stmt, 1) != SQLITE_NULL
      ? String(cString: exsqlite3_column_text(stmt, 1))
      : nil
    let assetType = String(cString: exsqlite3_column_text(stmt, 2))
    let contentHash = String(cString: exsqlite3_column_text(stmt, 3))
    let fileSize = exsqlite3_column_int64(stmt, 4)
    let createdAt = String(cString: exsqlite3_column_text(stmt, 5))
    let retryCount = Int(exsqlite3_column_int(stmt, 6))
    let errorMsg: String? = exsqlite3_column_type(stmt, 7) != SQLITE_NULL
      ? String(cString: exsqlite3_column_text(stmt, 7))
      : nil
    let stagedFileId: String? = exsqlite3_column_type(stmt, 8) != SQLITE_NULL
      ? String(cString: exsqlite3_column_text(stmt, 8))
      : nil
    let stagedNameEncrypted: String? = exsqlite3_column_type(stmt, 9) != SQLITE_NULL
      ? String(cString: exsqlite3_column_text(stmt, 9))
      : nil
    let stagedMimeType: String? = exsqlite3_column_type(stmt, 10) != SQLITE_NULL
      ? String(cString: exsqlite3_column_text(stmt, 10))
      : nil

    return BackupAssetRow(
      localAssetId: localAssetId,
      remoteFileId: remoteFileId,
      assetType: assetType,
      contentHash: contentHash,
      fileSize: fileSize,
      createdAt: createdAt,
      retryCount: retryCount,
      errorMessage: errorMsg,
      filename: nil,
      stagedFileId: stagedFileId,
      stagedNameEncrypted: stagedNameEncrypted,
      stagedMimeType: stagedMimeType,
      stagedIsMedia: exsqlite3_column_int(stmt, 11) != 0,
      stagedOriginalSize: exsqlite3_column_int64(stmt, 12),
      stagedChunkCount: Int(exsqlite3_column_int(stmt, 13)),
      stagedDir: exsqlite3_column_type(stmt, 14) != SQLITE_NULL
        ? String(cString: exsqlite3_column_text(stmt, 14))
        : nil,
      stagedUploadSessionId: exsqlite3_column_type(stmt, 15) != SQLITE_NULL
        ? String(cString: exsqlite3_column_text(stmt, 15))
        : nil,
      stagedAccountId: exsqlite3_column_type(stmt, 16) != SQLITE_NULL
        ? String(cString: exsqlite3_column_text(stmt, 16))
        : nil
    )
  }

  /// The staged row and its chunk rows in one transaction
  /// (`BackupManifestStore.recordStaging`, LD-0002 #262 review 4). False =
  /// nothing changed.
  private func markStaged(
    assetId: String,
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    isMediaValue: Bool,
    originalSize: Int64,
    chunkPaths: [String],
    stagedDir: String,
    stagedAccountId: String?
  ) -> Bool {
    guard let db = db else { return false }
    return BackupManifestStore.recordStaging(
      db,
      assetId: assetId,
      fileId: fileId,
      nameEncrypted: nameEncrypted,
      mimeType: mimeType,
      isMedia: isMediaValue,
      originalSize: originalSize,
      chunkPaths: chunkPaths,
      stagedDir: stagedDir,
      stagedAccountId: stagedAccountId,
      nowMs: nowMs()
    )
  }

  private func getStagedAsset(localAssetId: String) -> BackupAssetRow? {
    guard let db = db else { return nil }
    let sql = """
    SELECT local_asset_id, remote_file_id, asset_type, content_hash, file_size, created_at,
           COALESCE(retry_count, 0), error_message,
           staged_file_id, staged_name_encrypted, staged_mime_type,
           COALESCE(staged_is_media, 0), COALESCE(staged_original_size, 0),
           COALESCE(staged_chunk_count, 0), staged_dir, upload_session_id, staged_account_id
    FROM backup_assets
    WHERE local_asset_id = ?
      AND staged_file_id IS NOT NULL
      AND staged_dir IS NOT NULL
    LIMIT 1
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, localAssetId)
    guard exsqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return backupAssetRow(from: stmt)
  }

  private func hasPendingUploads() -> Bool {
    guard let db = db else { return false }
    let sql = """
    SELECT 1
    FROM backup_assets
    WHERE status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading')
      AND COALESCE(selected_for_backup, 1) = 1
      AND COALESCE(retry_count, 0) < 10
    LIMIT 1
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
    defer { exsqlite3_finalize(stmt) }
    return exsqlite3_step(stmt) == SQLITE_ROW
  }

  /// Mark an asset as currently uploading.
  private func markUploading(assetId: String) {
    guard let db = db else { return }
    let nowMs = nowMs()
    let sql = "UPDATE backup_assets SET status = 'uploading', last_attempt_at = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int64(stmt, 1, nowMs)
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_step(stmt)
  }

  private func markUploading(assetId: String, remoteFileId: String, uploadSessionId: String?) {
    guard let db = db else { return }
    // COALESCE keeps an existing session id on a resume re-`markUploading` where
    // the caller passes nil (recovered from the row, not freshly re-inited).
    let sql = """
    UPDATE backup_assets
    SET status = 'uploading',
        remote_file_id = ?,
        upload_session_id = COALESCE(?, upload_session_id),
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, remoteFileId)
    if let uploadSessionId {
      BackupManifestStore.bindText(stmt, 2, uploadSessionId)
    } else {
      exsqlite3_bind_null(stmt, 2)
    }
    exsqlite3_bind_int64(stmt, 3, nowMs())
    BackupManifestStore.bindText(stmt, 4, assetId)
    exsqlite3_step(stmt)
  }

  private func markStaging(assetId: String) {
    guard let db = db else { return }
    let sql = "UPDATE backup_assets SET status = 'staging', last_attempt_at = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int64(stmt, 1, nowMs())
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_step(stmt)
  }

  private func markPending(assetId: String, error: String?) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = CASE WHEN staged_file_id IS NOT NULL THEN 'staged_upload' ELSE 'pending_upload' END,
        error_message = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    if let error {
      BackupManifestStore.bindText(stmt, 1, error)
    } else {
      exsqlite3_bind_null(stmt, 1)
    }
    exsqlite3_bind_int64(stmt, 2, nowMs())
    BackupManifestStore.bindText(stmt, 3, assetId)
    exsqlite3_step(stmt)
  }

  private func updateStagedDirectory(assetId: String, stagedDir: String) {
    guard let db = db else { return }
    let sql = "UPDATE backup_assets SET staged_dir = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, stagedDir)
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_step(stmt)
  }

  /// Round 15: the statement lives in `BackupManifestStore.restageSQL`, which
  /// the teardown purge (`purgeAllStaged`) also runs, so the swift tests
  /// drive the shipped statement.
  private func clearStagedStateForRestage(assetId: String, error: String) {
    guard let db = db else { return }
    BackupManifestStore.clearStagedForRestage(db, assetId: assetId, error: error, nowMs: nowMs())
  }

  /// Task 1667 round 16 (review of mobile#182 at 083d5f23, finding 2):
  /// `uploadSingleAsset`'s per-row refusal of a row staged for another
  /// account. `BackupManifestStore.restageMismatchedRow` keeps the row for
  /// its owner if it is in flight, then clears it like
  /// `clearStagedStateForRestage`. MUST run on `dbQueue`.
  private func restageMismatchedStagedRow(assetId: String, error: String) {
    guard let db = db else { return }
    let result = BackupManifestStore.restageMismatchedRow(db, assetId: assetId, error: error, nowMs: nowMs())
    RuntimeTrace.event("backup.native.staged_account_mismatch.in_flight_kept", ["kept": result.keptInFlight ?? -1])
  }

  /// Mark an asset as successfully uploaded.
  ///
  /// Task 1667 round 7 sweep: false when the manifest did not record it (no
  /// handle, a failed write). The caller then keeps the staged chunks, the
  /// remote file id and the session id, so the next attempt resumes, finds
  /// the upload already complete and records it; it used to delete them
  /// after a failed write, and the photo was uploaded again.
  private func markUploadComplete(assetId: String, remoteFileId: String, accountId: String) -> Bool {
    guard let db = db else { return false }
    // Task 1667: the row records WHICH account owns the remote file
    // (`uploaded_account_id`) and that the server's per-device map does not
    // know it yet (`server_marked_at = NULL`, see `markOnServer`).
    return BackupManifestStore.markUploaded(
      db,
      assetId: assetId,
      remoteFileId: remoteFileId,
      accountId: accountId,
      uploadedAtIso: ISO8601DateFormatter().string(from: Date())
    )
  }

  /// Mark an asset as failed, incrementing retry count.
  private func markFailed(assetId: String, error: String, retryLimitReached: Bool = false) {
    guard let db = db else { return }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    // Increment retry_count. Assets with retry_count >= 10 become dead letters.
    let sql = """
    UPDATE backup_assets
    SET status = CASE WHEN staged_file_id IS NOT NULL THEN 'staged_upload' ELSE 'pending_upload' END,
        retry_count = \(retryLimitReached ? "10" : "COALESCE(retry_count, 0) + 1"),
        error_message = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, error)
    exsqlite3_bind_int64(stmt, 2, nowMs)
    BackupManifestStore.bindText(stmt, 3, assetId)
    exsqlite3_step(stmt)
  }

  private func markLocalMissing(assetId: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = 'local_missing',
        retry_count = 0,
        error_message = 'Photo no longer on this iPhone or no longer shared with Beebeeb',
        last_attempt_at = ?
    WHERE local_asset_id = ?
      AND status != 'uploaded'
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int64(stmt, 1, nowMs())
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_step(stmt)
  }

  /// One asset's result inside a `processBatch` task group.
  private enum BatchAssetOutcome {
    case uploaded
    /// Gone from the library or no longer shared (`local_missing`).
    case skipped
    case failed
  }

  private func isLocalMissing(_ localId: String) -> Bool {
    return dbQueue.sync {
      guard let db = self.db else { return false }
      var stmt: OpaquePointer?
      defer { exsqlite3_finalize(stmt) }
      let sql = "SELECT 1 FROM backup_assets WHERE local_asset_id = ? AND status = 'local_missing' LIMIT 1"
      guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
      BackupManifestStore.bindText(stmt, 1, localId)
      return exsqlite3_step(stmt) == SQLITE_ROW
    }
  }

  /// LD-0002 (B5): one transaction in `BackupManifestStore`. A replace that
  /// did not finish changed nothing: the old rows stay, never a partial set.
  private func replaceStagedChunks(assetId: String, fileId: String, chunkPaths: [String]) {
    guard let db = db else { return }
    if !BackupManifestStore.replaceStagedChunks(db, assetId: assetId, fileId: fileId, chunkPaths: chunkPaths) {
      RuntimeTrace.event("backup.native.staged_chunks.replace_failed", ["chunks": chunkPaths.count])
    }
  }

  private func getPendingStagedChunks(assetId: String) -> [StagedChunkRow] {
    guard let db = db else { return [] }
    let sql = """
    SELECT chunk_index, path
    FROM backup_upload_chunks
    WHERE local_asset_id = ?
      AND status != 'uploaded'
    ORDER BY chunk_index ASC
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, assetId)
    var chunks: [StagedChunkRow] = []
    while exsqlite3_step(stmt) == SQLITE_ROW {
      chunks.append(StagedChunkRow(
        index: Int(exsqlite3_column_int(stmt, 0)),
        path: String(cString: exsqlite3_column_text(stmt, 1))
      ))
    }
    return chunks
  }

  private func updateStagedChunkPath(assetId: String, chunkIndex: Int, path: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET path = ?
    WHERE local_asset_id = ? AND chunk_index = ?
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, path)
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    exsqlite3_step(stmt)
  }

  private func countPendingStagedChunks(assetId: String) -> Int {
    guard let db = db else { return 0 }
    var stmt: OpaquePointer?
    let sql = """
    SELECT COUNT(*)
    FROM backup_upload_chunks
    WHERE local_asset_id = ?
      AND status != 'uploaded'
    """
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, assetId)
    return exsqlite3_step(stmt) == SQLITE_ROW ? Int(exsqlite3_column_int(stmt, 0)) : 0
  }

  private func markChunkUploading(assetId: String, chunkIndex: Int, taskId: Int) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET status = 'uploading', task_id = ?, last_error = NULL
    WHERE local_asset_id = ? AND chunk_index = ?
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int(stmt, 1, Int32(taskId))
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    exsqlite3_step(stmt)
  }

  /// Round 8: a chunk callback only touches the chunk rows of the upload
  /// session its PUT was sent for (`uploadSessionId`, from the task
  /// description). A callback that arrives after a sign-out reset (in this
  /// process, or in a later one that iOS relaunched for the background
  /// session) finds no such row: the reset removed it, and the next
  /// account's rows carry their own session ids. In-process, the batch's
  /// write ticket is checked too (`admitsChunkCallback`).
  private static let chunkSessionPredicate = """
    local_asset_id = ? AND chunk_index = ?
    AND EXISTS (
      SELECT 1 FROM backup_assets a
      WHERE a.local_asset_id = backup_upload_chunks.local_asset_id
        AND a.upload_session_id = ?
    )
    """

  private func markChunkUploaded(assetId: String, chunkIndex: Int, uploadSessionId: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET status = 'uploaded', uploaded_at = ?, last_error = NULL
    WHERE \(Self.chunkSessionPredicate)
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int64(stmt, 1, nowMs())
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    BackupManifestStore.bindText(stmt, 4, uploadSessionId)
    exsqlite3_step(stmt)
  }

  private func markChunkFailed(assetId: String, chunkIndex: Int, uploadSessionId: String, error: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET status = 'pending', task_id = NULL, last_error = ?
    WHERE \(Self.chunkSessionPredicate)
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, error)
    BackupManifestStore.bindText(stmt, 2, assetId)
    exsqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    BackupManifestStore.bindText(stmt, 4, uploadSessionId)
    exsqlite3_step(stmt)
  }

  /// Round 8: the fence for a chunk-upload callback. MUST run on `dbQueue`,
  /// in the block that writes. With the batch's ticket (the PUT was sent by
  /// this process) the ticket must be admitted; without one (a task iOS
  /// handed back after a relaunch) the session predicate above is the fence.
  private func admitsChunkCallback(_ ticket: ManifestWriteFence.Ticket?, _ writer: String) -> Bool {
    guard let ticket else { return true }
    return manifestHandle.writeFence.admits(ticket, writer: writer)
  }

  private func deleteStagedChunks(assetId: String) {
    guard let db = db else { return }
    let sql = "DELETE FROM backup_upload_chunks WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    BackupManifestStore.bindText(stmt, 1, assetId)
    exsqlite3_step(stmt)
  }

  /// Recover assets stuck in 'uploading' state for more than 5 minutes.
  /// This handles crashes or app terminations mid-upload.
  func recoverStuckUploads() {
    guard let db = db else { return }
    let fiveMinAgoMs = Int64((Date().timeIntervalSince1970 - 300) * 1000)
    let sql = """
    UPDATE backup_assets
    SET status = CASE WHEN staged_file_id IS NOT NULL THEN 'staged_upload' ELSE 'pending_upload' END
    WHERE status IN ('uploading', 'staging')
      AND (last_attempt_at IS NULL OR last_attempt_at < ?)
    """
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { exsqlite3_finalize(stmt) }
    exsqlite3_bind_int64(stmt, 1, fiveMinAgoMs)
    exsqlite3_step(stmt)

    let changes = exsqlite3_changes(db)
    if changes > 0 {
      NSLog("[NativeBackupEngine] Recovered \(changes) stuck uploads")
    }

    // Only reset chunks whose owning URLSession task is NOT currently awaited in
    // this process. A chunk we hold a live continuation for is mid-flight on the
    // background session — resetting it here would orphan that task (it keeps
    // running, and its staged source file may later be re-staged/deleted →
    // 0-byte PUT). Orphans from a prior launch were already cancelled by
    // `reconcileOrphanedBackgroundTasks()`, so their task_id is safe to clear.
    let liveTaskIds = chunkUploadContinuations.keys
    if liveTaskIds.isEmpty {
      exsqlite3_exec(db, "UPDATE backup_upload_chunks SET status = 'pending', task_id = NULL WHERE status = 'uploading'", nil, nil, nil)
    } else {
      let keep = liveTaskIds.map(String.init).joined(separator: ",")
      let sql = "UPDATE backup_upload_chunks SET status = 'pending', task_id = NULL WHERE status = 'uploading' AND (task_id IS NULL OR task_id NOT IN (\(keep)))"
      exsqlite3_exec(db, sql, nil, nil, nil)
    }
  }

  /// Task 1531 [P0]: drop every already-encrypted staged asset whose
  /// `staged_account_id` is NOT PROVEN to be `accountId` — the account the
  /// engine is about to upload as. That means both an explicit mismatch
  /// (tagged for a different account) AND a NULL tag (untagged: staged
  /// before this migration, or before any account id was known at stage
  /// time) are purged. Only a `staged_account_id` that is EQUAL to
  /// `accountId` is trusted.
  ///
  /// Root cause this closes: `backup_assets` is one on-disk queue shared by
  /// every account that has ever signed in on this device (no account
  /// scoping existed before this task). Staging encrypts a photo's chunks +
  /// name envelope to disk under whichever master key was cached AT THAT
  /// MOMENT (`uploadSingleAsset` → `stageEncryptedAsset`); if the app signs
  /// out (or switches accounts) before the matching upload completes, the
  /// ciphertext and its `backup_assets`/`backup_upload_chunks` rows are never
  /// purged by sign-out (`purgeAllPlaintextCaches()` only sweeps *plaintext*
  /// paths — this is ciphertext, so it was never in scope). The next account
  /// to enable photo backup on this device would otherwise have its very
  /// first `processBatch()` resume that stale row (`uploadSingleAsset` finds
  /// `getStagedAsset(...)` non-nil and calls `uploadStagedAsset` directly,
  /// which never re-derives the key — it PUTs the on-disk ciphertext as-is),
  /// uploading a file that unwraps under the new account's own
  /// `derive_file_key` share-wrap but was never actually encrypted with that
  /// key — the exact "share unwraps, decrypt fails" shape reported in 1531/1534.
  ///
  /// Called proactively from `start()` (before the first `processBatch()` can
  /// run for the newly-current account) and defensively from
  /// `uploadSingleAsset` immediately before an already-staged row is PUT, so
  /// the fix does not depend on `start()` always running first (e.g. a
  /// `BGProcessingTask` resume).
  ///
  /// Lead review on this task (2026-09-25) corrected an earlier version that
  /// left a NULL `staged_account_id` untouched, reasoning it meant
  /// "pre-migration / single-account device, trust it". That is exactly the
  /// founder's reported device state: rows staged under account A BEFORE
  /// this column existed (so tagged NULL by the migration, which cannot
  /// retroactively know who staged them) are still NULL after signing in as
  /// account B on the same, now-updated build — the old logic would upload
  /// them into B untouched, reproducing 1531 through the "trusted" branch.
  /// A NULL tag carries no proof of which account encrypted the bytes, so it
  /// is UNTRUSTED, not "same account". Re-staging is cheap (the source is
  /// still the Photos library asset — only the ciphertext is discarded), so
  /// purging on ANY unproven tag is strictly safer than uploading it. This
  /// intentionally purges every NULL-tagged staged row exactly once per
  /// device history: `stageEncryptedAsset` always writes a non-nil
  /// `staged_account_id` going forward (see below), so once a row is purged
  /// and re-staged it can never come back as NULL. Only ever-uploaded rows
  /// (`status = 'uploaded'`, `staged_file_id IS NULL`) are untouched by this
  /// query — completed history is not "staged" and is never re-encrypted or
  /// re-uploaded by this sweep.
  ///
  /// MUST be called from `dbQueue` (matches every other `db`-touching method
  /// here) — it does not wrap itself, so a caller that is not already on
  /// `dbQueue` must do `dbQueue.sync { purgeMismatchedStagedAssets(...) }`
  /// (see `start()`), not call it directly.
  ///
  /// Task 1667 round 16 (review of mobile#182 at 083d5f23, finding 2): the
  /// select and the restage live in `BackupManifestStore.purgeMismatchedStaged`,
  /// which first keeps the mismatched account's in-flight uploads (scoped to
  /// those rows) for resolution at that account's next sign-in. Without it, a
  /// missed teardown followed by a relaunch as another account cleared the
  /// ids of an upload that may be complete on the server, and the photo
  /// uploaded a second time when its account returned.
  @discardableResult
  func purgeMismatchedStagedAssets(currentAccountId accountId: String?) -> Int {
    guard let db = db, let accountId, !accountId.isEmpty else { return 0 }
    let result = BackupManifestStore.purgeMismatchedStaged(
      db, currentAccountId: accountId, nowMs: nowMs(),
      error: "Re-encrypting: staged ciphertext not verified for this account"
    ) { row in
      if let stagedDir = row.stagedDir {
        removeStagedDirectory(stagedDir: stagedDir, fileId: row.fileId)
      }
      RuntimeTrace.event("backup.native.staged_account_mismatch.purged", [
        "stagedForAccount": row.forAccount ?? "(untagged/pre-migration)",
        "currentAccount": accountId
      ])
    }
    guard result.purged > 0 else { return 0 }
    RuntimeTrace.event("backup.native.staged_account_mismatch.in_flight_kept", ["kept": result.keptInFlight ?? -1])
    NSLog("[NativeBackupEngine] Purged \(result.purged) staged asset(s) encrypted for a different (or unproven) account")
    return result.purged
  }

  /// Task 1531 [P0] round 3 (lead review): purge EVERY staged asset,
  /// unconditionally — not account-scoped like `purgeMismatchedStagedAssets`
  /// above. Called from `clearAccountAndPurgeStaged()` (sign-out / account
  /// switch teardown, via `disablePhotoBackup` in BeebeebCryptoModule.swift),
  /// the point at which `currentAccountId` is about to become nil.
  ///
  /// `purgeMismatchedStagedAssets` cannot do this job: it *requires* a
  /// non-nil `accountId` to compare rows against and is a deliberate no-op
  /// once there is none (see its guard — a nil accountId there means "cannot
  /// prove anything", not "purge everything"). Left to that function alone,
  /// whatever the outgoing account had staged would sit on disk, still
  /// tagged for that account, until the NEXT sign-in's `start()` happens to
  /// discover the mismatch — an open window between sign-out and the next
  /// sign-in during which the ciphertext is neither trusted nor removed.
  /// Purging unconditionally here closes that window immediately instead of
  /// deferring it to the next `start()`.
  ///
  /// MUST be called from `dbQueue` (matches purgeMismatchedStagedAssets).
  @discardableResult
  private func purgeAllStagedAssets() -> Int {
    guard let db = db else { return 0 }
    // Task 1667 round 15 (review of mobile#182 at dd97f2ac, P1 item 1): the
    // uploads that may be in flight on the server are kept for resolution
    // BEFORE their ids are cleared, inside the purge itself, so every caller
    // is covered (the provider unmount's teardownAllBackup runs before the
    // signed-out purge; the toggle-off and the read-only stop never reach
    // prepareForStoragePurge at all).
    let result = BackupManifestStore.purgeAllStaged(
      db, nowMs: nowMs(), error: "Re-encrypting: account signed out before upload completed"
    ) { row in
      if let stagedDir = row.stagedDir {
        removeStagedDirectory(stagedDir: stagedDir, fileId: row.fileId)
      }
      RuntimeTrace.event("backup.native.sign_out.staged_purged", [
        "stagedForAccount": row.forAccount ?? "(untagged/pre-migration)"
      ])
    }
    RuntimeTrace.event("backup.native.sign_out.in_flight_kept", ["kept": result.keptInFlight ?? -1])
    if result.purged > 0 {
      NSLog("[NativeBackupEngine] Sign-out: purged \(result.purged) staged asset(s)")
    }
    return result.purged
  }

  /// Task 1531 [P0] round 3 (lead review): sign-out / account-switch
  /// teardown. Called from `disablePhotoBackup()` (the single-surface
  /// Camera Roll toggle-off path, gated on Contacts/Calendar's `isBound`)
  /// and, unconditionally, from `teardownAllBackup()` (round 6 finding N1 —
  /// the full sign-out / account-switch path) in BeebeebCryptoModule.swift.
  ///
  /// Task 1531 [P2-E] (round 5 delta review): clears `currentAccountId` to
  /// nil FIRST, THEN purges — the previous order (purge, then clear) left a
  /// window, for as long as `purgeAllStagedAssets` takes to enumerate and
  /// delete staged directories on `dbQueue`, during which `currentAccountId`
  /// still read the OUTGOING account as valid. Every other engine entry
  /// point that reads `currentAccountId` (`start()`'s guard,
  /// `handleBackgroundTask`'s guard, `bindAccount`'s comparison) treats nil
  /// as "refuse outright" — clearing first means nothing can begin
  /// staging/uploading against the outgoing account while the sweep is
  /// still in flight, closing that window rather than merely hoping nothing
  /// races it. Reordering does NOT change what gets purged or logged:
  /// `purgeAllStagedAssets` is already unconditional (not scoped to
  /// `currentAccountId`), and its diagnostic (`row.forAccount` above) reads
  /// each row's OWN `staged_account_id` column, never the live
  /// `currentAccountId` — the previous doc comment's claim that purging
  /// first was needed to preserve that diagnostic was itself mistaken.
  func clearAccountAndPurgeStaged() {
    fileLimitStopReason = nil
    currentAccountId = nil
    dbQueue.sync { purgeAllStagedAssets() }
    // Task 1531 [P1-3] (lead review, round 4): belt-and-braces — `stop()`
    // (called right before this, in `disablePhotoBackup()`) now releases
    // `masterKeyHandle` and cancels `backgroundTaskHandle` unconditionally,
    // but this function has exactly one call site today and is documented
    // as safe to call independently (see the doc comment above); don't rely
    // on caller ordering to keep that true.
    masterKeyHandle = nil
    backgroundTaskHandle?.cancel()
    backgroundTaskHandle = nil
  }

  // MARK: - Task 1667 round 8: manifest write fence

  /// The write ticket an async producer takes when it STARTS: before its
  /// PhotoKit fetch, network call or batch (`ManifestWriteFence`). nil = it
  /// may not write at all (no account, signed out since, another account
  /// bound). MUST NOT run on `dbQueue`.
  private func manifestWriteTicket(_ producer: String, accountId: String? = nil) -> ManifestWriteFence.Ticket? {
    let account = accountId ?? currentAccountId
    // LD-0002 (#262 review 1): read BEFORE the ticket, so a closure in between
    // makes the ticket stale (its writes refused), never the other way round.
    let gateClosures = executionGate.closures
    var ticket: ManifestWriteFence.Ticket? = dbQueue.sync { manifestHandle.writeFence.issue(for: account) }
    ticket?.gateClosures = gateClosures
    if ticket == nil {
      RuntimeTrace.event("backup.native.manifest.write_ticket_refused", [
        "producer": producer, "hasAccount": account?.isEmpty == false,
      ])
    }
    return ticket
  }

  /// The fence check for one write. MUST run on `dbQueue`, in the SAME
  /// closure as the write it guards (`native-backup-write-fence.test.ts`
  /// checks every writer call site). A refused write is traced by the fence.
  ///
  /// LD-0002 (#262 review 1): also refused when the gate closed since the
  /// producer took its ticket, even if it reopened since. Inside that window
  /// `db` was nil and the producer read it as "no row": a batch that read a
  /// staged photo as unstaged encrypted it again under a new file id, and its
  /// `markStaged` then landed next to the old server file and session.
  /// Background-URLSession completions (`admitsChunkCallback`) record what
  /// the server already has and are not refused.
  private func admitsWrite(_ ticket: ManifestWriteFence.Ticket?, _ writer: String) -> Bool {
    if let ticket, ticket.gateClosures != executionGate.closures {
      RuntimeTrace.event("backup.native.manifest.write_after_gate_closed", ["writer": writer])
      return false
    }
    return manifestHandle.writeFence.admits(ticket, writer: writer)
  }

  /// LD-0002 (#262 review 1, 5): a batch whose ticket predates a gate closure
  /// takes no further network or manifest step. Its reads in that window
  /// returned nil / 0 / "no row", which it would otherwise act on (re-encrypt
  /// a staged photo, call `upload/complete` with unrecorded chunks).
  private func ensureBatchAdmitted(_ ticket: ManifestWriteFence.Ticket) throws {
    guard executionGate.isOpen(since: ticket.gateClosures) else {
      RuntimeTrace.event("backup.native.batch.stopped_gate_closed")
      throw CancellationError()
    }
  }

  /// `stop()` and sign-out: cancel every observer-spawned scan. Best effort
  /// (a PhotoKit fetch already running is not interruptible); the fence is
  /// the guarantee.
  private func cancelScanTasks() {
    engineStateLock.lock()
    let tasks = Array(_scanTasks.values)
    _scanTasks.removeAll()
    engineStateLock.unlock()
    for task in tasks { task.cancel() }
  }

  /// Spawns a camera-roll scan the engine can cancel (`registerPhotoObserver`,
  /// `photoLibraryDidChange` with an album selection).
  private func spawnScan(reason: String, wakeReason: String) {
    let id = UUID()
    // Registered under the lock it is created under, so its own removal
    // (which takes the same lock) can never run before the insert.
    engineStateLock.lock()
    _scanTasks[id] = Task { [weak self] in
      guard let self else { return }
      defer {
        self.engineStateLock.lock()
        self._scanTasks.removeValue(forKey: id)
        self.engineStateLock.unlock()
      }
      if await self.scanPhotoLibraryForPendingUploads(reason: reason) {
        self.wakeDrainLoop(reason: wakeReason)
      }
    }
    engineStateLock.unlock()
  }

  // MARK: - Task 1667: account-scoped manifest + server map

  /// Adopt pre-column rows for `accountId` and re-queue another account's
  /// rows (`BackupManifestStore.claim`). Cheap (two indexed UPDATEs); safe
  /// to run on every bind.
  func claimManifest(forAccount accountId: String) {
    guard !accountId.isEmpty else { return }
    // Round 8: a write, so it is fenced like every other one.
    guard let ticket = manifestWriteTicket("claim", accountId: accountId) else { return }
    // Best-effort here (bind); a claim that could not commit is retried, and
    // enforced, by `ensureManifestReadyForUploads` before any upload.
    let claimed: (adopted: Int, requeued: Int)? = dbQueue.sync {
      guard self.admitsWrite(ticket, "claim") else { return nil }
      guard let db = self.db else { return nil }
      return BackupManifestStore.claim(db, accountId: accountId, nowMs: self.nowMs())
    }
    guard let result = claimed else {
      RuntimeTrace.event("backup.native.manifest.claim_failed")
      return
    }
    if result.adopted > 0 || result.requeued > 0 {
      RuntimeTrace.event("backup.native.manifest.claimed", [
        "adopted": result.adopted,
        "requeued": result.requeued,
      ])
    }
  }

  /// True when uploads for `accountId` may start: the manifest holds rows
  /// this account uploaded, or it was rebuilt from the server's per-device
  /// map in this process. An EMPTY manifest (after sign-out, or a reinstall)
  /// is rebuilt first — photos the server already maps to a file of this
  /// account become `uploaded` — so nothing already backed up from this
  /// device is uploaded twice. When the server cannot be asked (no device id
  /// yet, offline, 5xx) this returns false and no upload starts; the next
  /// batch asks again. Never deletes anything.
  ///
  /// Round 4 (Codex P1 "Fail closed when applying the server identifier
  /// map"): the order and the rule live in `ManifestRebuildGate.run`. EVERY
  /// step fails closed — the claim, the "needs a rebuild?" read, the fetch,
  /// the server-map write and the kept-marks write each return nil (or
  /// throw) on failure, never a count of 0 — and a failure keeps uploads
  /// paused behind a bounded backoff until the step succeeds. The account is
  /// marked ready only on `.ready`.
  ///
  /// Round 8: every database step runs behind the caller's write `ticket`
  /// (taken when its scan or batch started). The map is fetched over the
  /// network between the claim and the write; a sign-out reset in that
  /// window drops the write (`applyMapFailed`), so the outgoing account's
  /// PhotoKit ids and file ids never land in the emptied manifest.
  func ensureManifestReadyForUploads(
    accountId: String, authToken: String, baseURL: String, ticket: ManifestWriteFence.Ticket
  ) async -> Bool {
    guard !accountId.isEmpty, ticket.accountId == accountId else { return false }
    let steps = ManifestRebuildGate.Steps(
      needsRebuild: { [weak self] in
        guard let self else { return nil }
        return self.dbQueue.sync { () -> Bool? in
          FencedManifestWrites.needsRebuild(
            self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId,
            scanInsertFailed: self.manifestHandle.scanInsertHealth.failed, nowMs: self.nowMs()
          )
        }
      },
      hasDeviceId: { [weak self] in
        guard let deviceId = self?.backupDeviceId else { return false }
        return !deviceId.isEmpty
      },
      fetchMap: { [weak self] in
        guard let self, let deviceId = self.backupDeviceId, !deviceId.isEmpty else {
          throw BackupError.notConfigured
        }
        do {
          // Round 11 (review finding 2, server task 2036): the identifiers
          // map only. The server leaves trashed files out of it; native code
          // no longer reads `GET /files/index` (task 1959). On a server that
          // answered `/check` without `backed_up` (no task 2036) the map may
          // still include trashed files: the fetch fails (the gate defers).
          // Round 12 (review item 2): unless one lightweight `/check` (at most
          // one per backoff period) finds the server has `backed_up` now.
          let probeSteps = self.serverCheckSteps(
            accountId: accountId, authToken: authToken, baseURL: baseURL, ticket: ticket
          )
          return try await PendingUploadServerCheck.rebuildFetch(
            // Round 13 (review item 7): unknown support probes first too.
            backedUpSupported: { self.serverBackedUpSupported },
            takeProbeSlot: { self.takeBackedUpProbeSlot() },
            probe: {
              RuntimeTrace.event("backup.native.server_check.capability_probe")
              _ = try await probeSteps.check([PendingUploadServerCheck.capabilityProbeIdentifier])
            },
            fetch: {
              try await self.fetchServerIdentifierMap(
                authToken: authToken, baseURL: baseURL, accountId: accountId, deviceId: deviceId
              )
            }
          )
        } catch {
          RuntimeTrace.event("backup.native.manifest_rebuild.fetch_error", [
            "error": String(describing: error).prefix(160).description,
          ])
          throw error
        }
      },
      isStillCurrent: { [weak self] in self?.currentAccountId == accountId },
      applyMap: { [weak self] map in
        guard let self else { return nil }
        return self.dbQueue.sync { () -> Int? in
          FencedManifestWrites.applyServerMap(
            self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId,
            map: map, uploadedAtIso: ISO8601DateFormatter().string(from: Date()), nowMs: self.nowMs()
          )
        }
      },
      applyKept: { [weak self] in self?.applyKeptPendingMarks(accountId: accountId, ticket: ticket) },
      // Task 1667 round 14 (review of mobile#182 at 18312919, the P1): this
      // account's uploads that were in flight at its last sign-out, asked
      // before any upload. Complete -> a kept mark (promoted by applyKept,
      // marked by the catch-up); not complete -> dropped, uploads as normal.
      resolveKept: { [weak self] in
        guard let self else { return .storeFailed }
        let resolved = await KeptUploadResolution.run(
          load: {
            self.dbQueue.sync {
              FencedManifestWrites.loadKeptInFlight(
                self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId,
                nowMs: self.nowMs()
              )
            }
          },
          // Round 15 (review items 2 and 3): complete ONLY on the API's 2xx
          // body with is_uploading false and the file not in the Trash; a
          // trashed file is not backed up, so the row is dropped and the
          // photo queued. Anything that is not the API's answer throws (defer).
          ask: { row in
            try await self.inspectExistingUpload(
              fileId: row.fileId, authToken: authToken, baseURL: baseURL
            ) == .complete
          },
          record: { row, complete in
            RuntimeTrace.event("backup.native.pending_marks.in_flight_resolved", ["complete": complete])
            return self.dbQueue.sync {
              FencedManifestWrites.resolveKeptInFlight(
                self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId,
                row: row, complete: complete
              )
            }
          }
        )
        return resolved
      }
    )
    let outcome = await ManifestRebuildGate.run(alreadyReady: manifestReadyForAccount == accountId, steps: steps)
    switch outcome {
    case let .ready(rebuilt, promoted, keptApplied):
      manifestReadyForAccount = accountId
      manifestRebuildFailures = 0
      // Round 15 (review item 6): ANY successful pass clears the pause (round
      // 12 cleared it only when `rebuilt`).
      recordGatePause(outcome)
      if rebuilt {
        RuntimeTrace.event("backup.native.manifest_rebuild.done", [
          "promoted": promoted,
          "keptApplied": keptApplied,
        ])
      }
      return true
    case let .deferred(reason):
      let failures = manifestRebuildFailures + 1
      manifestRebuildFailures = failures
      let wait = ManifestRebuildGate.backoff(for: reason, consecutiveFailures: failures)
      // Round 15 (review item 2): never shortens a 429's Retry-After.
      if let wait {
        backoffUntil = ManifestRebuildGate.backoffDeadline(existing: backoffUntil, now: Date(), wait: wait)
      }
      // Round 12 (review item 6): say why (fetch failed, server without
      // backed_up, no device id). Round 15: not for a local resolution failure.
      recordGatePause(outcome)
      RuntimeTrace.event("backup.native.manifest_rebuild.deferred", [
        "reason": reason.rawValue,
        "consecutive": failures,
        "backoffSeconds": wait.map { Int($0) } ?? 0,
      ])
      return false
    }
  }

  /// Task 1667 round 2 (Codex P1 "Preserve uploads that have not reached the
  /// server map"): uploads this account made from this device that were not
  /// yet in the server's map when it signed out (`backup_pending_marks`)
  /// become `uploaded` again in the manifest instead of being uploaded a
  /// second time; the mark catch-up then sends them to the server. Local
  /// only, scoped to `accountId`; runs before every batch because rows the
  /// scan has not inserted yet can only be matched later.
  ///
  /// Round 4: nil when they could not be applied (no handle, writer lock);
  /// the gate then keeps uploads paused instead of uploading those photos.
  /// Round 5 (Codex P2 "Expire pending marks even when the current account
  /// has none"): the 30-day expiry of `backup_pending_marks`, for EVERY
  /// account, as its own step. Runs at every sign-in (`confirmMasterKeyHandle`)
  /// and bind, besides the sign-out reset and every kept-marks step before a
  /// batch (`BackupManifestStore.applyPendingMarks`, before its account
  /// count). So an account that never signs in on this device again does not
  /// leave its user id and PhotoKit/file ids here past 30 days because only
  /// other accounts use the device. Best-effort: nil (no handle, writer lock)
  /// is traced, and the next trigger expires the rows.
  @discardableResult
  func expireKeptPendingMarks(trigger: String) -> Int? {
    let expired: Int? = dbQueue.sync {
      guard let db = self.db else { return nil }
      return BackupManifestStore.expirePendingMarks(db, nowMs: self.nowMs())
    }
    if let expired {
      if expired > 0 {
        RuntimeTrace.event("backup.native.pending_marks.expired", ["expired": expired, "trigger": trigger])
      }
    } else {
      RuntimeTrace.event("backup.native.pending_marks.expire_failed", ["trigger": trigger])
    }
    return expired
  }

  func applyKeptPendingMarks(accountId: String, ticket: ManifestWriteFence.Ticket) -> Int? {
    let promoted: Int? = dbQueue.sync {
      FencedManifestWrites.applyKept(
        self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId, nowMs: self.nowMs()
      )
    }
    if let promoted, promoted > 0 {
      RuntimeTrace.event("backup.native.pending_marks.applied", ["promoted": promoted])
    }
    return promoted
  }

  /// `GET /api/v1/files/photo-backup/identifiers` for this device, as
  /// local identifier -> file id. Any failure throws, a 404 included (round
  /// 5, Codex P1 "Fail closed when the identifier route returns 404"): the
  /// handler never answers 404, so one is a routing or proxy failure, and
  /// `ManifestRebuildGate` defers on it like on any failed fetch. Only a 2xx
  /// `{"identifiers": {}}` is an empty map (`PhotoBackupServerResponses`).
  ///
  /// Round 10: sent through `PhotoBackupServerClient` (the same requests the
  /// server-check test answers).
  private func fetchServerIdentifierMap(
    authToken: String, baseURL: String, accountId: String, deviceId: String
  ) async throws -> [String: String] {
    let client = photoBackupServerClient(authToken: authToken, baseURL: baseURL, accountId: accountId, deviceId: deviceId)
    return try await client.identifierMap()
  }

  /// Task 1667 round 10: the photo-backup server reads, with the engine's
  /// headers and its 409 account-mismatch handling.
  private func photoBackupServerClient(
    authToken: String, baseURL: String, accountId: String, deviceId: String
  ) -> PhotoBackupServerClient {
    PhotoBackupServerClient(
      session: metadataSession,
      baseURL: baseURL,
      authToken: authToken,
      deviceId: deviceId,
      decorate: { request in
        ProvenanceHeaders.apply(to: &request)
        applyExpectedUserHeader(to: &request, accountId: accountId)
      },
      inspect: { [weak self] statusCode, data in
        if statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
          self?.handleConfirmedAccountMismatch()
          throw BackupError.accountMismatchConfirmed
        }
      }
    )
  }

  /// Round 13 (review item 7): nil until a `/check` (or the rebuild's probe)
  /// answered in this process/account.
  private var serverBackedUpSupported: Bool? {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _backedUpSupport.supported
  }

  /// Round 12 (review item 2): the rebuild's probe slot (one per backoff
  /// period while the server lacks `backed_up`).
  private func takeBackedUpProbeSlot() -> Bool {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _backedUpSupport.takeProbeSlot(now: Date())
  }

  // MARK: - Server-check pause reason (round 12, review item 6)

  /// The reason Settings shows while uploads are paused on the server check.
  private var serverCheckPausedReason: String? {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _serverCheckPause.stopReason
  }

  /// Round 13 (item 6): the pause as the status surfaces show it.
  private var serverCheckPauseSurface: BackupSurfaceState.State? {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _serverCheckPause.surface
  }

  private var serverCheckPauseCause: ServerCheckPause.Cause? {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _serverCheckPause.cause
  }

  /// Records a deferred `/check` and, when the reason changed, publishes it
  /// to the status surfaces (once per change, not once per deferred batch).
  private func recordServerCheckPause(_ reason: PendingUploadServerCheck.DeferReason) {
    engineStateLock.lock()
    let changed = _serverCheckPause.record(reason)
    let message = _serverCheckPause.stopReason
    engineStateLock.unlock()
    publishServerCheckPause(changed: changed, message: message)
  }

  /// Round 15 (review item 6): one rebuild-gate pass (`ServerCheckPause
  /// .recordGate`). A pause it set is published; a pause it cleared refreshes
  /// the surfaces, so the widget and Live Activity stop saying "paused" even
  /// when the batch then finds nothing to upload.
  private func recordGatePause(_ outcome: ManifestRebuildGate.Outcome) {
    engineStateLock.lock()
    let changed = _serverCheckPause.recordGate(outcome, lacksBackedUp: _backedUpSupport.lacksBackedUp)
    let message = _serverCheckPause.stopReason
    engineStateLock.unlock()
    if changed, message == nil {
      RuntimeTrace.event("backup.native.server_check.pause_cleared")
      updateBackupStatusSurfaces()
      return
    }
    publishServerCheckPause(changed: changed, message: message)
  }

  private func clearServerCheckPause() {
    engineStateLock.lock()
    let changed = _serverCheckPause.clear()
    engineStateLock.unlock()
    if changed { RuntimeTrace.event("backup.native.server_check.pause_cleared") }
  }

  private func publishServerCheckPause(changed: Bool, message: String?) {
    guard changed, let message else { return }
    RuntimeTrace.event("backup.native.server_check.paused", [
      "cause": serverCheckPauseCause?.rawValue ?? NSNull(),
    ])
    updateBackupStatusSurfaces(reason: message)
  }

  /// Round 11: the `/check` steps both passes share. Every answer also tells
  /// whether the server carries `backed_up` (task 2036).
  private func serverCheckSteps(
    accountId: String, authToken: String, baseURL: String, ticket: ManifestWriteFence.Ticket
  ) -> PendingUploadServerCheck.Steps {
    let deviceId = backupDeviceId ?? ""
    let client = photoBackupServerClient(authToken: authToken, baseURL: baseURL, accountId: accountId, deviceId: deviceId)
    return PendingUploadServerCheck.Steps(
      hasDeviceId: { !deviceId.isEmpty },
      check: { [weak self] ids in
        do {
          let hits = try await client.check(ids)
          self?.noteServerBackedUpSupport(true)
          return hits
        } catch let error as PhotoBackupServerResponses.ServerLacksBackedUp {
          self?.noteServerBackedUpSupport(false)
          throw error
        }
      },
      isStillCurrent: { [weak self] in self?.currentAccountId == accountId },
      promote: { [weak self] hits in
        guard let self else { return nil }
        return self.dbQueue.sync { () -> Set<String>? in
          FencedManifestWrites.promoteCheckedHits(
            self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId,
            hits: hits, uploadedAtIso: ISO8601DateFormatter().string(from: Date()), nowMs: self.nowMs()
          )
        }
      }
    )
  }

  /// Round 11 (review finding 2): a server without `backed_up` is logged
  /// ONCE per process ("server lacks backed_up (task 2036)"); every deferred
  /// batch is still traced.
  private func noteServerBackedUpSupport(_ supported: Bool) {
    engineStateLock.lock()
    _backedUpSupport.note(supported: supported)
    engineStateLock.unlock()
    if !supported, PendingUploadServerCheck.serverLacksBackedUpNotice.shouldFire() {
      NSLog("[NativeBackupEngine] \(PendingUploadServerCheck.serverLacksBackedUpMessage): camera-roll uploads stay paused")
      RuntimeTrace.event("backup.native.server_check.server_lacks_backed_up", [
        "message": PendingUploadServerCheck.serverLacksBackedUpMessage,
      ])
    }
  }

  /// Round 11: the bulk-check state, read and written through these sync
  /// helpers (`engineStateLock` is not taken in an async context).
  /// The coverage to filter against when a bulk pass is owed (consumed);
  /// nil when none is.
  private func takeBulkServerCheckRequest() -> ServerCheckCoverage? {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    guard _bulkServerCheckRequested else { return nil }
    _bulkServerCheckRequested = false
    return _serverCheckCoverage
  }

  private func recordBulkServerCheck(_ outcome: PendingUploadServerCheck.BulkOutcome, accountId: String, generation: UInt64) {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    _serverCheckCoverage.record(outcome.needsBackup, accountId: accountId, generation: generation, now: Date())
    _lastBatchServerPromoted += outcome.promoted.count
  }

  private func noteServerCheckSucceeded(promoted: Int) {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    _serverCheckFailures = 0
    _lastBatchServerPromoted += promoted
  }

  /// Consecutive deferred checks, this one included.
  private func noteServerCheckDeferred() -> Int {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    _serverCheckFailures += 1
    return _serverCheckFailures
  }

  /// Round 11 (review finding 9): request a bulk pass before the next batch
  /// (a drain start, a background task, rows inserted by a scan).
  private func requestBulkServerCheck() {
    engineStateLock.lock()
    _bulkServerCheckRequested = true
    engineStateLock.unlock()
  }

  /// Round 11 (review finding 9): the bulk dedupe. When requested, ask
  /// `/photo-backup/check` about EVERY fresh pending row not covered yet, in
  /// chunks of 500, before the drain selects a batch: the server's hits are
  /// promoted in bulk, and the rows it answered "needs backup" are covered,
  /// so the per-batch guard skips them. Before, each 12-row batch carried its
  /// own /check, and 5,000 rows the server already had took about 420 batch
  /// cycles to promote. A failed pass changes nothing it did not finish; the
  /// per-batch guard still checks every uncovered row (fail closed there).
  private func bulkServerCheckIfRequested(
    accountId: String, authToken: String, baseURL: String, ticket: ManifestWriteFence.Ticket
  ) async {
    guard let coverage = takeBulkServerCheckRequest() else { return }
    let all: [String]? = dbQueue.sync {
      guard let db = self.db else { return nil }
      return BackupManifestStore.freshPendingIds(db)
    }
    guard let all else {
      RuntimeTrace.event("backup.native.server_check.bulk_load_failed")
      return
    }
    let candidates = coverage.uncovered(all, accountId: accountId, generation: ticket.generation, now: Date())
    guard !candidates.isEmpty else { return }
    let steps = serverCheckSteps(
      accountId: accountId, authToken: authToken, baseURL: baseURL, ticket: ticket
    )
    let outcome = await PendingUploadServerCheck.bulk(candidates: candidates, steps: steps) { [weak self] in
      guard let self else { return false }
      return self.isRunning && !Task.isCancelled && self.currentAccountId == accountId
    }
    recordBulkServerCheck(outcome, accountId: accountId, generation: ticket.generation)
    if let stopped = outcome.stopped {
      recordServerCheckPause(stopped)
    } else if outcome.requests > 0 {
      clearServerCheckPause()
    }
    RuntimeTrace.event("backup.native.server_check.bulk", [
      "candidates": candidates.count, "requests": outcome.requests, "promoted": outcome.promoted.count,
      "needsBackup": outcome.needsBackup.count, "stopped": outcome.stopped?.rawValue ?? NSNull(),
    ])
  }

  /// Task 1667 round 10 (review finding 1, adopted by the lead): the dedupe
  /// guarantee. Before any row of this batch starts a NEW upload (no staged
  /// file yet), the server is asked whether this device already backed it
  /// up. Round 11 (findings 2 and 9, server task 2036): `/photo-backup/check`
  /// answers with `backed_up` (file ids, Trash excluded server-side); only
  /// those rows are promoted, with that file id, and left out of the batch.
  /// Rows a bulk pass already covered ("needs backup") are not asked again.
  /// Returns the rows to upload, or nil when the batch must not upload
  /// anything now (any step failed, or the server lacks `backed_up`: fail
  /// closed, with a backoff). Rows already staged are resumptions of an
  /// upload that passed this check before it was staged.
  private func rowsCheckedAgainstServer(
    _ pending: [BackupAssetRow], accountId: String, authToken: String, baseURL: String,
    ticket: ManifestWriteFence.Ticket
  ) async -> [BackupAssetRow]? {
    // Round 12 (review item 1, duplicate upload): EVERY fresh row of the
    // batch is asked, whatever an earlier bulk pass answered for it. In round
    // 11 a covered row skipped this check for 15 minutes, so a row the JS
    // reconcile re-queued after it uploaded, or whose file came back out of
    // the Trash, uploaded a second time.
    let fresh = PendingUploadServerCheck.batchCandidates(
      pending.map { (id: $0.localAssetId, staged: $0.stagedFileId != nil) }
    )
    guard !fresh.isEmpty else {
      // Nothing to ask: staged rows resume uploads checked before staging.
      clearServerCheckPause()
      return pending
    }
    let steps = serverCheckSteps(
      accountId: accountId, authToken: authToken, baseURL: baseURL, ticket: ticket
    )
    let outcome = await PendingUploadServerCheck.run(candidates: fresh, steps: steps)
    switch outcome {
    case let .proceed(skip, promoted, _):
      noteServerCheckSucceeded(promoted: promoted.count)
      clearServerCheckPause()
      if !skip.isEmpty {
        RuntimeTrace.event("backup.native.server_check.applied", [
          "checked": fresh.count, "promoted": promoted.count, "skipped": skip.count,
        ])
      }
      return pending.filter { !skip.contains($0.localAssetId) }
    case let .deferred(reason):
      let failures = noteServerCheckDeferred()
      let wait = PendingUploadServerCheck.backoff(for: reason, consecutiveFailures: failures)
      if let wait { backoffUntil = Date().addingTimeInterval(wait) }
      // Round 12 (review item 6): Settings says backup is paused, and why.
      recordServerCheckPause(reason)
      RuntimeTrace.event("backup.native.server_check.deferred", [
        "reason": reason.rawValue, "checked": fresh.count, "consecutive": failures,
        "backoffSeconds": wait.map { Int($0) } ?? 0,
      ])
      return nil
    }
  }

  /// Round 10: rows the last batch's server check promoted, consumed once.
  private func takeLastBatchServerPromoted() -> Int {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    let n = _lastBatchServerPromoted
    _lastBatchServerPromoted = 0
    return n
  }

  /// `POST /api/v1/files/photo-backup/mark` for one completed upload, then
  /// `server_marked_at` on success. Best-effort: a failure leaves the row
  /// unmarked for `flushServerMarks` to retry. Returns false when the caller
  /// should stop sending more marks now (network, 429, 5xx, account change).
  ///
  /// Round 5 (Codex P1 "Fail closed when the identifier route returns 404"):
  /// a 404 is done ("file gone, nothing to map") ONLY with the API's own
  /// NotFound body (`PhotoBackupServerResponses.markOutcome`). Any other 404
  /// is a failure: no `server_marked_at`, so the row stays a pending mark,
  /// the sign-out reset keeps it and the next sign-in promotes it.
  @discardableResult
  ///
  /// Round 8: the local record runs behind the caller's write `ticket` (the
  /// batch's, the scan's or the sign-out flush's). A response that arrives
  /// after a sign-out reset records nothing; the server holds the mark.
  func markOnServer(
    assetId: String, fileId: String, authToken: String, baseURL: String, accountId: String,
    ticket: ManifestWriteFence.Ticket, requestTimeout: TimeInterval? = nil
  ) async -> Bool {
    guard !accountId.isEmpty, currentAccountId == accountId else { return false }
    guard let deviceId = backupDeviceId, !deviceId.isEmpty else { return false }
    guard let url = URL(string: "\(baseURL)/api/v1/files/photo-backup/mark") else { return false }
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    applyExpectedUserHeader(to: &request, accountId: accountId)
    request.httpMethod = "POST"
    // Round 3: the sign-out flush hands the budget it has left; a request
    // never outlives it (metadataSession's own limit is 30 s).
    if let requestTimeout { request.timeoutInterval = requestTimeout }
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.setValue(deviceId, forHTTPHeaderField: "X-Beebeeb-Device-Id")
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
      "local_identifier": assetId,
      "file_id": fileId,
    ])
    do {
      let (data, response) = try await metadataSession.data(for: request)
      let http = response as? HTTPURLResponse
      let statusCode = http?.statusCode ?? 0
      if statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
        handleConfirmedAccountMismatch()
        return false
      }
      let outcome = PhotoBackupServerResponses.markOutcome(
        statusCode: statusCode,
        contentType: http?.value(forHTTPHeaderField: "Content-Type"),
        data: data
      )
      guard outcome.recordsServerMark else {
        RuntimeTrace.event("backup.native.server_mark.failed", ["status": statusCode])
        return false
      }
      if outcome == .fileGone {
        RuntimeTrace.event("backup.native.server_mark.file_gone")
      }
      dbQueue.sync {
        _ = FencedManifestWrites.recordServerMarked(
          self.db, fence: self.manifestHandle.writeFence, ticket: ticket,
          assetId: assetId, fileId: fileId, nowMs: self.nowMs()
        )
      }
      return true
    } catch {
      RuntimeTrace.event("backup.native.server_mark.failed", ["status": 0])
      return false
    }
  }

  /// Catch-up: marks rows uploaded but not yet in the server map (every row
  /// uploaded before task 1667, plus any mark that failed). Sequential and
  /// bounded so a large legacy manifest drains over a few scans without
  /// pressing the server; stops at the first failure.
  func flushServerMarks(
    accountId: String, authToken: String, baseURL: String, ticket: ManifestWriteFence.Ticket, limit: Int = 300
  ) async {
    guard backupDeviceId?.isEmpty == false else { return }
    let loaded: [(assetId: String, fileId: String)]? = dbQueue.sync {
      guard let db = self.db else { return nil }
      return BackupManifestStore.pendingServerMarks(db, accountId: accountId, limit: limit)
    }
    // Round 7 sweep: a read failure is not "all marked"; traced, and the
    // next scan's catch-up reads again.
    guard let rows = loaded else {
      RuntimeTrace.event("backup.native.server_mark.load_failed", ["trigger": "catch_up"])
      return
    }
    guard !rows.isEmpty else { return }
    let deadline = Date().addingTimeInterval(20)
    var marked = 0
    for row in rows {
      if Task.isCancelled || Date() > deadline { break }
      guard await markOnServer(
        assetId: row.assetId, fileId: row.fileId, authToken: authToken, baseURL: baseURL, accountId: accountId,
        ticket: ticket
      ) else { break }
      marked += 1
    }
    RuntimeTrace.event("backup.native.server_mark.catch_up", ["candidates": rows.count, "marked": marked])
  }

  /// Task 1667 round 2 (Codex P1 "Preserve uploads that have not reached the
  /// server map"): called by the JS sign-out BEFORE the session is revoked.
  /// Sends EVERY upload of the signed-in account that the server's map does
  /// not have yet (no 300-row cap), each with up to `attemptsPerRow`
  /// attempts. Whatever is still unmarked afterwards is kept by the reset
  /// (`backup_pending_marks`). Returns (candidates, marked).
  ///
  /// Round 3 (Codex P1 "Enforce the eight-second sign-out deadline"): the
  /// WHOLE flush, row load included, is bounded by `SignOutMarkFlush.run`'s
  /// hard deadline. A stalled mark request is cancelled when it passes, and
  /// each request's timeout is the budget left, so a dead endpoint can no
  /// longer hold sign-out for metadataSession's 30 s / 60 s.
  func flushServerMarksForSignOut(deadline: TimeInterval = SignOutMarkFlush.defaultDeadline, attemptsPerRow: Int = 2) async -> (candidates: Int, marked: Int) {
    guard let accountId = currentAccountId, !accountId.isEmpty,
          let authToken = token, let baseURL = apiBaseUrl,
          backupDeviceId?.isEmpty == false else { return (0, 0) }
    // Round 8: the flush takes its write ticket at its start; its adoption
    // and its `server_marked_at` records run behind it.
    guard let ticket = manifestWriteTicket("sign_out_mark_flush", accountId: accountId) else { return (0, 0) }
    let outcome = await SignOutMarkFlush.run(
      deadline: deadline,
      attemptsPerRow: attemptsPerRow,
      loadRows: { [weak self] () -> [SignOutMarkFlush.Row] in
        guard let self else { return [] }
        // Rows from before `uploaded_account_id` belong to this account too.
        // Round 7 sweep: a failed adoption or read is traced, not read as
        // "nothing to mark". The flush can send nothing it cannot read; the
        // reset then keeps every unmarked row (and refuses to run when the
        // adoption fails), so no association is lost either way.
        return self.dbQueue.sync {
          let hasHandle = self.db != nil
          let loaded = FencedManifestWrites.loadSignOutMarks(
            self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId
          )
          if loaded.adoptFailed {
            RuntimeTrace.event("backup.native.server_mark.load_failed", ["trigger": "sign_out", "step": "adopt"])
          }
          guard let rows = loaded.rows else {
            RuntimeTrace.event("backup.native.server_mark.load_failed", [
              "trigger": "sign_out", "step": hasHandle ? "read_or_fenced" : "no_handle",
            ])
            return []
          }
          // Task 1667 round 14 (review of mobile#182 at 18312919, the P1):
          // uploads in flight may already be complete on the server. Asked
          // after the unmarked rows; whatever this flush does not settle,
          // the reset keeps for resolution at the next sign-in.
          let inFlight = FencedManifestWrites.loadSignOutInFlight(
            self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId
          )
          if inFlight == nil {
            RuntimeTrace.event("backup.native.server_mark.load_failed", ["trigger": "sign_out", "step": "in_flight"])
          }
          return rows.map { SignOutMarkFlush.Row.unmarked(assetId: $0.assetId, fileId: $0.fileId) }
            + (inFlight ?? []).map { SignOutMarkFlush.Row.inFlight(assetId: $0.assetId, fileId: $0.fileId) }
        }
      },
      shouldStop: { [weak self] in self?.currentAccountId != accountId },
      mark: { [weak self] row, requestTimeout in
        guard let self else { return false }
        switch row {
        case let .unmarked(assetId, fileId):
          return await self.markOnServer(
            assetId: assetId, fileId: fileId, authToken: authToken, baseURL: baseURL,
            accountId: accountId, ticket: ticket, requestTimeout: requestTimeout
          )
        case let .inFlight(assetId, fileId):
          return await SignOutMarkFlush.settleInFlight(
            isComplete: {
              // Round 15: complete only on the API's answer, never trashed.
              try await self.inspectExistingUpload(
                fileId: fileId, authToken: authToken, baseURL: baseURL, requestTimeout: requestTimeout
              ) == .complete
            },
            recordUploaded: {
              self.dbQueue.sync {
                FencedManifestWrites.recordInFlightComplete(
                  self.db, fence: self.manifestHandle.writeFence, ticket: ticket, accountId: accountId,
                  assetId: assetId, fileId: fileId, uploadedAtIso: ISO8601DateFormatter().string(from: Date())
                )
              }
            },
            mark: {
              await self.markOnServer(
                assetId: assetId, fileId: fileId, authToken: authToken, baseURL: baseURL,
                accountId: accountId, ticket: ticket, requestTimeout: requestTimeout
              )
            }
          )
        }
      }
    )
    RuntimeTrace.event("backup.native.server_mark.sign_out_flush", [
      "candidates": outcome.candidates, "marked": outcome.marked, "timedOut": outcome.timedOut,
    ])
    return (outcome.candidates, outcome.marked)
  }

  /// Sign-out (every path reaches the native `purgePlaintextStorage`): stop
  /// and unbind the engine, empty the manifest THROUGH the open handle, and
  /// forget the previous account's backup folder. Before task 1667 the purge
  /// unlinked the file under both handles: the process kept writing a
  /// deleted inode and the next cold launch re-uploaded every photo into the
  /// same folder.
  ///
  /// `kept` is ALWAYS the database and its sidecars: the JS layer's
  /// expo-sqlite connection is still open on them, and nothing may be
  /// unlinked beneath it (round 2, Codex P1 "Reopen the JS database after a
  /// reset failure"). When the reset fails (`resetFailed`), the engine
  /// closes its own handle, records `manifestResetPendingKey`, and refuses
  /// to reopen until the JS side has closed its handle and called
  /// `finishStoragePurgeAfterFailedReset`, which resets (or, failing that,
  /// replaces) the file with no connection open and then reopens the
  /// engine's handle on it (round 6).
  ///
  /// Round 9 (Codex P1 "Delete retained marks during permanent account
  /// deletion"): `mode` comes from JS (`purgeAllPlaintextCaches`). With
  /// `.accountDeleted` the reset keeps nothing of the outgoing account and of
  /// `deletedAccountIds`, deletes their kept marks, and every later reset in
  /// this process does the same (`BackupManifestHandle.resetForSignOut`).
  /// The in-memory "last unbound account" is forgotten too.
  func prepareForStoragePurge(
    mode: ManifestPurgeMode = .signOut,
    deletedAccountIds: Set<String> = []
  ) -> (kept: Set<String>, resetFailed: Bool) {
    // Round 13 (review item 3): bound, or only remembered (`inferred`); a
    // deletion never counts a remembered account as deleted unless JS names it.
    let outgoing = outgoingAccountForReset()
    stop()
    backupClientSessionId = nil
    // Task 1667 round 14/15: the staged purge keeps the in-flight uploads for
    // resolution before it clears their ids (`purgeAllStagedAssets` ->
    // `BackupManifestStore.purgeAllStaged`, round 15: inside the purge, so
    // the provider unmount's teardown, which usually runs first, keeps them
    // too). The reset applies the discard and the expiry to them like to
    // every kept mark.
    clearAccountAndPurgeStaged()
    // 1962 Bug 4: the next account must not inherit this one's Backups folder.
    parentFolderId = nil
    manifestReadyForAccount = nil
    manifestRebuildFailures = 0
    clearManifestAvailability()
    // Round 10: the batch check's server state belongs to the outgoing account.
    // Round 11: the bulk coverage (the file-index and identifier-map caches
    // are gone with the liveness read).
    // Round 12 (review items 2 and 6): whether the server lacks `backed_up`
    // and the pause reason are the outgoing session's; the next account
    // starts from "not seen" (a probe is never needed to clear it).
    engineStateLock.lock()
    _serverCheckCoverage.clear()
    _bulkServerCheckRequested = true
    _serverCheckFailures = 0
    _lastBatchServerPromoted = 0
    _backedUpSupport.reset()
    _serverCheckPause.clear()
    engineStateLock.unlock()
    let dbPath = Self.backupDatabaseURL().standardizedFileURL.path
    let kept: Set<String> = [dbPath, dbPath + "-wal", dbPath + "-shm"]
    // Round 8 (Codex P1 "Fence late photo scans before resetting the
    // manifest"): `resetForSignOut` advances and seals the write fence FIRST,
    // in this same `dbQueue` block. Every scan, observer callback, rebuild
    // step, batch write, mark record and chunk callback still in flight took
    // its ticket before this block, so whatever it writes after it is
    // dropped: when this returns, no producer from before the sign-out can
    // write, and none can start until the next sign-in binds the fence.
    // (`stop()` above also cancelled the observer-spawned scans; that cancel
    // is best effort, the fence is the guarantee.)
    let (resetOK, fenceGeneration, discardAll): (Bool, UInt64, Bool) = dbQueue.sync {
      let ok = manifestHandle.resetForSignOut(
        outgoingAccountId: outgoing.accountId, outgoingInferred: outgoing.inferred,
        mode: mode, deletedAccountIds: deletedAccountIds
      )
      return (ok, manifestHandle.writeFence.generation, manifestHandle.activeDiscard.all)
    }
    // Round 11 (review finding 5): a scan that started after `stop()` above
    // but before the reset sealed the fence may have stored its fetch result
    // in between; drop it now (a later store is refused by the sealed fence).
    lifecycle.clearFetchResult()
    if mode == .accountDeleted {
      forgetUnboundAccount()
    }
    RuntimeTrace.event("backup.native.storage_purge.prepared", [
      "resetInPlace": resetOK, "fenceGeneration": Int(fenceGeneration),
      "mode": mode.rawValue, "discardAll": discardAll,
    ])
    return (kept, !resetOK)
  }

  /// Task 1667 round 10 (review findings 5 + 7): the gate before EVERY JS
  /// (expo-sqlite) open of the manifest (`BackupDatabase.openAndMigrate`,
  /// through the module's `admitBackupManifestJsOpen`). A sign-out reset
  /// still pending is applied first, on the engine's own connection, while
  /// JS holds none; JS is admitted only when none is pending on return, so
  /// it never reads the outgoing account's rows. From then until JS confirms
  /// its handles closed, the engine never closes or checkpoints a connection
  /// outside the purge hold (`BackupManifestHandle.peerMayHoldFile`).
  func admitJsManifestOpen(priorHandlesClosed: Bool) -> BackupManifestHandle.PeerOpenGate {
    let gate: BackupManifestHandle.PeerOpenGate = dbQueue.sync {
      manifestHandle.admitPeerOpen(priorPeerHandlesClosed: priorHandlesClosed)
    }
    RuntimeTrace.event("backup.native.manifest.js_open_gate", [
      "admitted": gate.admitted, "priorHandlesClosed": priorHandlesClosed,
      "failure": gate.failure?.rawValue ?? NSNull(),
    ])
    return gate
  }

  /// Second half of a sign-out whose in-place reset failed; JS calls it once
  /// its own handle is closed (`allowUnlink` = that close succeeded). With
  /// no connection open, the reset is retried on a connection of its own; if
  /// it still fails and `allowUnlink`, the file is replaced, carrying the
  /// kept pending marks over. No handle in this process points at a deleted
  /// inode afterwards: JS reopens lazily on the resulting file.
  ///
  /// Round 6 (Codex P2 "Reopen the native manifest after successful
  /// recovery"): the engine's handle is reopened on that file in the SAME
  /// `dbQueue.sync` block as the recovery, still inside the JS purge hold, so
  /// a sign-in later in this process finds an open manifest. Before, the
  /// handle stayed closed until the next launch and `start()` ran without a
  /// database. When the recovery or the reopen fails, `start()` reopens (or
  /// reports `manifestUnavailableReason` and retries).
  func finishStoragePurgeAfterFailedReset(allowUnlink: Bool) -> BackupManifestHandle.FinishResult {
    let result: BackupManifestHandle.FinishResult = dbQueue.sync {
      manifestHandle.finishAfterFailedReset(allowUnlink: allowUnlink)
    }
    RuntimeTrace.event("backup.native.storage_purge.recovered", [
      "ok": result.ok, "unlinked": result.unlinked, "allowUnlink": allowUnlink,
      "reopened": result.reopened, "reopenFailure": result.reopenFailure?.rawValue ?? NSNull(),
    ])
    return result
  }

  // MARK: - Manifest availability (task 1667 round 6)

  /// The reason `start()` refused because the manifest could not be opened.
  private var manifestUnavailableStopReason: String? {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _manifestAvailability.stopReason
  }

  /// Records an open attempt. A success clears the reason; a scheduled
  /// `start()` retry is left alone (it is still owed: only `start()` itself
  /// proceeding, `stop()` or sign-out cancel it).
  private func recordManifestOpen(_ failure: BackupManifestHandle.OpenFailure?) -> ManifestAvailability.Decision {
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    return _manifestAvailability.record(failure)
  }

  private func cancelManifestOpenRetry() {
    lifecycle.cancelRetries()
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    _manifestOpenRetry?.cancel()
    _manifestOpenRetry = nil
  }

  /// Sign-out and `stop()`: no reason, no retry.
  private func clearManifestAvailability() {
    lifecycle.cancelRetries()
    engineStateLock.lock(); defer { engineStateLock.unlock() }
    _manifestAvailability.clear()
    _manifestOpenRetry?.cancel()
    _manifestOpenRetry = nil
  }

  /// `start()` again after `delay`, for the same account. `stop()`, sign-out
  /// and a `start()` that proceeds cancel it; an account change makes it a
  /// no-op. It runs even if a background task set `isRunning` meanwhile:
  /// `start()` then finishes the foreground setup that path skips.
  ///
  /// Round 11 (review finding 3): the retry runs `start()`'s body inside
  /// `lifecycle.runRetry`, ONE transition with the check: only while the
  /// user still wants backup running (`stop()` / `disablePhotoBackup` /
  /// sign-out clear that) and this is still the latest retry. Before, it
  /// called `start()` from this global queue with no lock, and
  /// `DispatchWorkItem.cancel()` cannot stop a retry already executing, so a
  /// retry racing the user's stop set `isRunning = true` after backup was
  /// turned off.
  private func scheduleManifestOpenRetry(accountId: String, after delay: TimeInterval) {
    let token = lifecycle.scheduleRetry()
    let retry = DispatchWorkItem { [weak self] in
      guard let self else { return }
      // LD-0002: an open runs SQLite (schema, a pending reset). Not after
      // background time ended: try again later.
      guard self.executionGate.canStartSQLiteWork else {
        RuntimeTrace.event("backup.native.manifest.open_retry_deferred")
        self.scheduleManifestOpenRetry(accountId: accountId, after: delay)
        return
      }
      // Round 12 (review item 8): the key is read outside the lock, like
      // `start()`'s.
      let ran = self.lifecycle.runRetry(token, prepare: { self.prepareStartMasterKey() }) { prepared in
        guard self.currentAccountId == accountId else { return .done }
        RuntimeTrace.event("backup.native.manifest.open_retry")
        return self.startLocked(prepared: prepared)
      }
      if !ran { RuntimeTrace.event("backup.native.manifest.open_retry_void") }
    }
    engineStateLock.lock()
    _manifestOpenRetry?.cancel()
    _manifestOpenRetry = retry
    engineStateLock.unlock()
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: retry)
  }

  /// `start()`'s manifest check (round 6). Opens the manifest if its handle
  /// is closed. When that fails, the engine does not run without it: a
  /// running engine is stopped, the reason is published (progress dict +
  /// status surfaces) and a retry is scheduled. MUST NOT run on `dbQueue`.
  private func ensureManifestOpenForStart(accountId: String) -> Bool {
    let failure = dbQueue.sync { openManifestIfClosed(trigger: "start") }
    if failure != nil, isRunning {
      // Round 11: keeps the user's intent, so the retry below may start again.
      lifecycle.internalStop { stopLocked() }
    }
    switch recordManifestOpen(failure) {
    case .proceed:
      cancelManifestOpenRetry()
      return true
    case .refuse(let reason, let retryAfter):
      RuntimeTrace.event("backup.native.start.refused_manifest_unavailable", [
        "failure": failure?.rawValue ?? NSNull(),
        "retryAfterS": retryAfter,
      ])
      NSLog("[NativeBackupEngine] Backup manifest unavailable (\(failure?.rawValue ?? "?")) — not starting; retry in \(Int(retryAfter)) s")
      scheduleManifestOpenRetry(accountId: accountId, after: retryAfter)
      updateBackupStatusSurfaces(reason: reason)
      return false
    }
  }

  /// Refresh progress counters from the database.
  ///
  /// LD-0002 (P2a): the counters change only when every read finished with
  /// the gate open; a quiesce that interrupted them (it closes the gate first,
  /// and an interrupted step reads as 0) keeps the last values. `db` is nil
  /// while the gate is closed, so nothing here runs then.
  private func refreshProgress() {
    dbQueue.sync {
      guard let db = db else { return }
      let reads = executionGate.readIfUninterrupted { () -> ProgressReads in
        Self.migratePhotoKitMissingAssetRows(db, nowMs: nowMs())
        let selectedCondition = "COALESCE(selected_for_backup, 1) = 1"
        // Byte progress is recomputed from durable SQLite state so heartbeats stay
        // sane across resumes/relaunches and cannot double-count older manual
        // in-memory increments. Prefer staged_original_size once known; file_size
        // is populated with the same original byte count during staging and remains
        // after completed rows clear their staged state.
        return ProgressReads(
          total: countWhere(db: db, condition: selectedCondition),
          completed: countWhere(db: db, condition: "\(selectedCondition) AND status = 'uploaded'"),
          failed: countWhere(db: db, condition: "\(selectedCondition) AND COALESCE(retry_count, 0) >= 10"),
          inProgress: countWhere(db: db, condition: "\(selectedCondition) AND status IN ('staging', 'staged_upload', 'uploading')"),
          bytesTotal: sumBytes(
            db: db,
            expression: "MAX(COALESCE(staged_original_size, 0), COALESCE(file_size, 0))",
            condition: selectedCondition
          ),
          bytesUploaded: sumBytes(
            db: db,
            expression: "MAX(COALESCE(staged_original_size, 0), COALESCE(file_size, 0))",
            condition: "\(selectedCondition) AND status = 'uploaded'"
          ),
          uploadedChunkBytes: uploadedStagedChunkBytes(db: db)
        )
      }
      guard let reads else { return }
      totalAssets = reads.total
      completedAssets = reads.completed
      failedAssets = reads.failed
      inProgressAssets = reads.inProgress
      bytesTotal = reads.bytesTotal
      bytesUploaded = reads.bytesUploaded
      bytesTransferProgress = max(reads.bytesUploaded, reads.bytesUploaded + reads.uploadedChunkBytes)
    }
  }

  private struct ProgressReads {
    let total: Int
    let completed: Int
    let failed: Int
    let inProgress: Int
    let bytesTotal: Int64
    let bytesUploaded: Int64
    let uploadedChunkBytes: Int64
  }

  private func sumBytes(db: OpaquePointer, expression: String, condition: String) -> Int64 {
    var stmt: OpaquePointer?
    let sql = "SELECT COALESCE(SUM(\(expression)), 0) FROM backup_assets WHERE \(condition)"
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { exsqlite3_finalize(stmt) }
    return exsqlite3_step(stmt) == SQLITE_ROW ? exsqlite3_column_int64(stmt, 0) : 0
  }

  private func uploadedStagedChunkBytes(db: OpaquePointer) -> Int64 {
    var total: Int64 = 0
    var stmt: OpaquePointer?
    let sql = """
    SELECT c.path
    FROM backup_upload_chunks c
    JOIN backup_assets a ON a.local_asset_id = c.local_asset_id
    WHERE c.status = 'uploaded'
      AND a.status != 'uploaded'
      AND COALESCE(a.selected_for_backup, 1) = 1
    """
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { exsqlite3_finalize(stmt) }
    while exsqlite3_step(stmt) == SQLITE_ROW {
      guard exsqlite3_column_type(stmt, 0) != SQLITE_NULL,
            let pathPointer = exsqlite3_column_text(stmt, 0) else { continue }
      let path = String(cString: pathPointer)
      let size = (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      total += Int64(max(0, size))
    }
    return total
  }

  private func countWhere(db: OpaquePointer, condition: String) -> Int {
    var stmt: OpaquePointer?
    let sql = "SELECT COUNT(*) FROM backup_assets WHERE \(condition)"
    guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { exsqlite3_finalize(stmt) }
    return exsqlite3_step(stmt) == SQLITE_ROW ? Int(exsqlite3_column_int(stmt, 0)) : 0
  }

  // MARK: - Notification

  #if os(iOS)
  private func updateNotification(uploaded _: Int, total _: Int, isComplete: Bool, sessionUploaded: Int) {
    DispatchQueue.main.async {
      if UIApplication.shared.applicationState == .active {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
        return
      }

      let content = UNMutableNotificationContent()
      content.title = "Beebeeb Backup"
      guard isComplete else { return }
      guard UserDefaults.standard.object(forKey: "io.beebeeb.backupNotifications.backupSummaries") as? Bool ?? true else {
        return
      }
      guard sessionUploaded > 0 else { return }
      let label = sessionUploaded == 1 ? "1 new photo" : "\(sessionUploaded) new photos"
      content.body = "Beebeeb backed up \(label) in the last 24 hours"
      content.sound = nil

      let request = UNNotificationRequest(
        identifier: "io.beebeeb.backup-progress",
        content: content,
        trigger: nil
      )
      UNUserNotificationCenter.current().add(request) { _ in }

      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
      }
    }
  }
  #endif

  // MARK: - Thumbnail Generation

  /// Long edge requested from PhotoKit for the thumbnail SOURCE image. Large
  /// enough to feed the 1280px `large` ladder crisply; both the `medium` (768px)
  /// and `large` (1280px) variants are downsampled from this single fetch via
  /// the shared `ThumbnailGenerator` ladder (task 0631).
  private let thumbSourceMaxSize = 1600

  /// Generate and upload the medium + large thumbnails (and a blurhash) for an
  /// uploaded asset. Best-effort: failures are logged but never block the upload
  /// pipeline. One PhotoKit fetch yields the source image; the medium (768px),
  /// large (1280px) and blurhash are all derived from it (task 0631).
  private func generateAndUploadThumbnail(
    phAssetId: String,
    serverFileId: String,
    assetType: String,
    mediaTypeHint: String?,
    masterKey: MasterKeyHandle,
    authToken: String,
    baseURL: String,
    /// Task 1599: the caller's confirmed batch/account id — see
    /// `uploadStagedChunk`'s matching parameter doc. Both call sites are
    /// inside `uploadStagedAsset`, so `batchAccountId` is always available.
    accountId: String
  ) {
    Task.detached(priority: .utility) { [weak self] in
      guard let self else { return }
      guard !accountId.isEmpty else {
        RuntimeTrace.event("backup.native.thumbnail.refused_no_account")
        NSLog("[NativeBackupEngine] Thumbnail upload skipped: no confirmed account")
        return
      }
      do {
        let isVideo = assetType == "video" || self.isVideoType(mediaTypeHint)
        let source: UIImage = isVideo
          ? try await self.fetchVideoSourceFrame(phAssetId: phAssetId)
          : try await self.fetchPhotoSourceImage(phAssetId: phAssetId)

        let fileKey = try masterKey.deriveFileKey(fileId: Data(serverFileId.utf8))

        // Blurhash placeholder — images only (the web/JS path skips video too).
        // Best-effort; nil simply means the Photos grid shows no instant gradient.
        let blurhash = isVideo ? nil : BlurHashEncoder.encode(source)

        // Medium thumbnail. Carries the blurhash so the server persists it on
        // files.blurhash alongside has_thumbnail (server only stores the
        // placeholder with the medium variant).
        if let mediumData = ThumbnailGenerator.generate(from: source, config: .medium) {
          await self.putThumbnail(
            variant: nil,
            data: mediumData,
            fileKey: fileKey,
            maxBytes: ThumbnailGenerator.Config.medium.maxBytes + 28,
            blurhash: blurhash,
            serverFileId: serverFileId,
            authToken: authToken,
            baseURL: baseURL,
            accountId: accountId
          )
        } else {
          NSLog("[NativeBackupEngine] Medium thumbnail produced no output")
        }

        // Small thumbnail (384px, q0.35) — what the dense Photos grid (7 and 12
        // columns) requests. Same decoded source, independent best-effort PUT to
        // /thumbnail/small; no blurhash (only the medium variant carries one).
        if let smallData = ThumbnailGenerator.generate(from: source, config: .small) {
          await self.putThumbnail(
            variant: "small",
            data: smallData,
            fileKey: fileKey,
            maxBytes: ThumbnailGenerator.Config.small.maxBytes + 28,
            blurhash: nil,
            serverFileId: serverFileId,
            authToken: authToken,
            baseURL: baseURL,
            accountId: accountId
          )
        } else {
          NSLog("[NativeBackupEngine] Small thumbnail produced no output")
        }

        // Large thumbnail (1280px) — used by the preview screen + web preview.
        // Independent best-effort PUT to /thumbnail/large; sets has_large_thumbnail.
        if let largeData = ThumbnailGenerator.generate(from: source, config: .large) {
          await self.putThumbnail(
            variant: "large",
            data: largeData,
            fileKey: fileKey,
            maxBytes: ThumbnailGenerator.Config.large.maxBytes + 28,
            blurhash: nil,
            serverFileId: serverFileId,
            authToken: authToken,
            baseURL: baseURL,
            accountId: accountId
          )
        } else {
          NSLog("[NativeBackupEngine] Large thumbnail produced no output")
        }
      } catch {
        NSLog("[NativeBackupEngine] Thumbnail generation failed: \(error.localizedDescription)")
      }

      // Photo preview tier: images only, only when the mirrored setting is enabled
      // FOR THIS BATCH'S ACCOUNT (a setting mirrored for another account counts as
      // disabled). Runs after the upload and the thumbnails are done, on this
      // detached task (no engine lock, no manifest access). Failures are logged
      // inside the helper and can never fail or retry the backup.
      let isVideoAsset = assetType == "video" || self.isVideoType(mediaTypeHint)
      if !isVideoAsset, PhotoPreviewSettingStore.current(forAccount: accountId) != nil {
        do {
          let previewKey = try masterKey.deriveFileKey(fileId: Data(serverFileId.utf8))
          await PhotoPreviewAfterUpload.run(
            phAssetId: phAssetId,
            serverFileId: serverFileId,
            fileKey: previewKey,
            authToken: authToken,
            baseURL: baseURL,
            accountId: accountId
          )
        } catch {
          NSLog("[NativeBackupEngine] Photo preview skipped: \(error.localizedDescription)")
        }
      }
    }
  }

  /// Encrypt one thumbnail variant and PUT it. `variant == nil` → the medium
  /// endpoint (`/thumbnail`); otherwise `/thumbnail/<variant>`. A non-nil
  /// `blurhash` is appended as a `?blurhash=` query param (server persists it
  /// only on the medium variant). Best-effort — never throws.
  private func putThumbnail(
    variant: String?,
    data: Data,
    fileKey: FileKeyHandle,
    maxBytes: Int,
    blurhash: String?,
    serverFileId: String,
    authToken: String,
    baseURL: String,
    /// Task 1599: the caller's confirmed batch/account id — see
    /// `uploadStagedChunk`'s matching parameter doc.
    accountId: String
  ) async {
    let label = variant ?? "medium"
    do {
      let enc = try fileKey.encryptChunk(plaintext: data)
      // Wire format: nonce(12) || ciphertext — matches the web client.
      var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
      wire.append(enc.nonce)
      wire.append(enc.ciphertext)
      guard wire.count <= maxBytes else {
        NSLog("[NativeBackupEngine] \(label) thumbnail skipped: encrypted payload too large (\(wire.count) bytes)")
        return
      }

      let suffix = variant.map { "/\($0)" } ?? ""
      var urlString = "\(baseURL)/api/v1/files/\(serverFileId)/thumbnail\(suffix)"
      // Encode against the unreserved set so base83 symbols (#, +, ?, …) and the
      // `+`-means-space urlencoded pitfall are all percent-escaped.
      if let blurhash, !blurhash.isEmpty,
         let encoded = blurhash.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
        urlString += "?blurhash=\(encoded)"
      }
      guard let thumbUrl = URL(string: urlString) else { return }
      var request = URLRequest(url: thumbUrl)
      ProvenanceHeaders.apply(to: &request)
      applyExpectedUserHeader(to: &request, accountId: accountId)
      request.httpMethod = "PUT"
      request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      request.httpBody = wire

      let (responseData, response) = try await URLSession.shared.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(statusCode) {
        NSLog("[NativeBackupEngine] \(label) thumbnail uploaded\(blurhash != nil ? " (+blurhash)" : "")")
      } else if statusCode == 409, AccountMismatchDetection.isAccountMismatch(responseData) {
        handleConfirmedAccountMismatch()
        NSLog("[NativeBackupEngine] \(label) thumbnail refused: account mismatch")
      } else {
        NSLog("[NativeBackupEngine] \(label) thumbnail upload HTTP \(statusCode)")
      }
    } catch {
      NSLog("[NativeBackupEngine] \(label) thumbnail upload failed: \(error.localizedDescription)")
    }
  }

  /// Extract a source frame (1s in, or 0s for very short clips) from a video
  /// asset at `thumbSourceMaxSize`, for downstream medium + large generation.
  private func fetchVideoSourceFrame(phAssetId: String) async throws -> UIImage {
    let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [phAssetId], options: nil).firstObject
    guard let phAsset else { throw BackupError.assetNotFound }

    let avAsset: AVAsset = try await withCheckedThrowingContinuation { continuation in
      let options = PHVideoRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { asset, _, info in
        Self.phkitCallbackQueue.async {
          if let error = info?[PHImageErrorKey] as? Error {
            continuation.resume(throwing: error)
          } else if let asset {
            continuation.resume(returning: asset)
          } else {
            continuation.resume(throwing: BackupError.assetLoadFailed)
          }
        }
      }
    }

    let generator = AVAssetImageGenerator(asset: avAsset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: thumbSourceMaxSize, height: thumbSourceMaxSize)

    let time = CMTime(seconds: 1.0, preferredTimescale: 600)
    let cgImage: CGImage
    do {
      cgImage = try generator.copyCGImage(at: time, actualTime: nil)
    } catch {
      // Fall back to time 0 if 1s is beyond the video duration
      cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
    }
    return UIImage(cgImage: cgImage)
  }

  /// Fetch a source image (JPEG, HEIC, PNG, DNG, etc) from PhotoKit at
  /// `thumbSourceMaxSize`. Works for all image types incl. RAW/DNG because
  /// Photos.framework handles the decoding.
  private func fetchPhotoSourceImage(phAssetId: String) async throws -> UIImage {
    let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [phAssetId], options: nil).firstObject
    guard let phAsset else { throw BackupError.assetNotFound }

    return try await withCheckedThrowingContinuation { continuation in
      let options = PHImageRequestOptions()
      options.deliveryMode = .highQualityFormat
      options.isNetworkAccessAllowed = true
      options.isSynchronous = false
      options.resizeMode = .exact

      let targetSize = CGSize(width: thumbSourceMaxSize, height: thumbSourceMaxSize)
      PHImageManager.default().requestImage(
        for: phAsset,
        targetSize: targetSize,
        contentMode: .aspectFit,
        options: options
      ) { result, info in
        Self.phkitCallbackQueue.async {
          let isDegraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
          if isDegraded { return } // Wait for the high-quality callback
          if let error = info?[PHImageErrorKey] as? Error {
            continuation.resume(throwing: error)
          } else if let result {
            continuation.resume(returning: result)
          } else {
            continuation.resume(throwing: BackupError.assetLoadFailed)
          }
        }
      }
    }
  }

  /// Whether the given UTI represents a video type.
  private func isVideoType(_ value: String?) -> Bool {
    guard let value = value?.lowercased() else { return false }
    return value.hasPrefix("video/") ||
           value == "com.apple.quicktime-movie" ||
           value == "public.mpeg-4" ||
           value.hasPrefix("public.movie") ||
           value.hasPrefix("public.video")
  }

  private func mediaFlag(assetType: String, mimeType: String?) -> Bool {
    if assetType == "photo" || assetType == "video" {
      return true
    }
    guard let mimeType = mimeType?.lowercased() else {
      return false
    }
    return mimeType.hasPrefix("image/") || mimeType.hasPrefix("video/")
  }

  // MARK: - MIME / Extension Helpers

  private func mimeTypeFromUTI(_ uti: String) -> String? {
    let map: [String: String] = [
      "public.jpeg": "image/jpeg",
      "public.png": "image/png",
      "public.heic": "image/heic",
      "public.heif": "image/heif",
      "public.tiff": "image/tiff",
      "com.adobe.raw-image": "image/x-adobe-dng",
      "com.apple.quicktime-movie": "video/quicktime",
      "public.mpeg-4": "video/mp4",
    ]
    if let mimeType = map[uti] {
      return mimeType
    }
    return UTType(uti)?.preferredMIMEType
  }

  private func fileExtension(for uti: String) -> String {
    let map: [String: String] = [
      "public.jpeg": "jpg",
      "public.png": "png",
      "public.heic": "heic",
      "public.heif": "heif",
      "public.tiff": "tiff",
      "com.adobe.raw-image": "dng",
      "com.apple.quicktime-movie": "mov",
      "public.mpeg-4": "mp4",
    ]
    return map[uti] ?? "bin"
  }
}

// MARK: - PHPhotoLibraryChangeObserver

extension NativeBackupEngine: PHPhotoLibraryChangeObserver {
  /// Round 8 (Codex P1 "Fence late photo scans before resetting the
  /// manifest"): PhotoKit can deliver this callback after `stop()`
  /// unregistered the observer, and its insert runs later on `dbQueue`. The
  /// callback takes its write ticket on entry, before the change details are
  /// computed, and the insert runs behind it: a sign-out reset in between
  /// drops the insert. No ticket (signed out, another account) = nothing to do.
  func photoLibraryDidChange(_ changeInstance: PHChange) {
    // A limited-library selection change is a removal as much
    // as an insert; the incremental path below only inserts. A limited
    // library is the user's hand-picked set, so a full rescan is cheap.
    if !selectedPhotoAlbumIds.isEmpty || PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited {
      let reason = selectedPhotoAlbumIds.isEmpty ? "Shared photos rescanned" : "Selected albums rescanned"
      spawnScan(reason: reason, wakeReason: "photo-library-selected")
      return
    }

    guard let ticket = manifestWriteTicket("photo_library_change") else { return }
    guard let old = currentFetchResult else { return }
    guard let details = changeInstance.changeDetails(for: old) else { return }

    // Round 11 (review finding 5): replaced only while `old` is still the
    // stored result; a stop or sign-out since cleared it, and this change is
    // then not inserted (the next full scan takes it).
    guard lifecycle.replaceFetchResult(expected: old, with: details.fetchResultAfterChanges) else { return }
    let inserted = scannedAssets(details.insertedObjects)
    if !inserted.isEmpty {
      dbQueue.async { [weak self] in
        guard let self else { return }
        let written = FencedManifestWrites.scanInsert(
          self.db, fence: self.manifestHandle.writeFence, ticket: ticket, writer: "photo_library_change.insert",
          assets: inserted, selection: nil, nowMs: self.nowMs()
        )
        self.recordScanInsert(written, assets: inserted.count, source: .incremental)
        guard written != .fenced else { return }
        if self.hasPendingUploads() {
          self.wakeDrainLoop(reason: "photo-library")
        }
        DispatchQueue.main.async {
          self.updateBackupStatusSurfaces(reason: "New photos detected")
        }
      }
      NSLog("[NativeBackupEngine] Detected \(inserted.count) new assets in photo library")
    }
  }
}

// MARK: - URLSessionDelegate

extension NativeBackupEngine: URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {

  /// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): accumulate the
  /// response body for a chunk-PUT background task as it streams in, capped
  /// — see `chunkResponseBodyBuffers`'s doc comment for why this exists and
  /// why the cap is safe. Only chunk-PUT tasks carry a `taskDescription`
  /// (set in `uploadStagedChunk`), so a background DOWNLOAD/other task this
  /// engine doesn't originate (there are none today, but this delegate is
  /// shared session-wide) is never buffered.
  ///
  /// Task 1605 review round 3 (P2): this used to be a subscript GET, then a
  /// separate subscript SET — two lock acquisitions with a window between
  /// them where `stop()`'s `chunkResponseBodyBuffers.removeAll()` (a
  /// different thread — `stop()` can run from the JS bridge's queue mid
  /// chunk-upload) could land, and the SET below would then resurrect the
  /// very entry `removeAll()` had just cleared for a task that is
  /// supposedly stopped. `.mutate(key:)` does the read, cap check, and
  /// write in ONE compound locked operation (`LockedDictionary`'s own doc
  /// comment), so a concurrent `removeAll()` can only land strictly before
  /// or strictly after this whole tick — never in the middle of it.
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard dataTask.taskDescription != nil else { return }
    chunkResponseBodyBuffers.mutate(key: dataTask.taskIdentifier) { existing in
      let existing = existing ?? Data()
      guard existing.count < Self.chunkResponseBodyCapBytes else { return existing }
      var updated = existing
      updated.append(data.prefix(Self.chunkResponseBodyCapBytes - existing.count))
      return updated
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let description = task.taskDescription,
       let data = description.data(using: .utf8),
       let chunk = try? JSONDecoder().decode(BackgroundChunkTaskDescription.self, from: data) {
      let statusCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
      let continuation = chunkUploadContinuations.removeValue(forKey: task.taskIdentifier)
      let responseBody = chunkResponseBodyBuffers.removeValue(forKey: task.taskIdentifier)
      let ticket = chunkTaskTickets.removeValue(forKey: task.taskIdentifier)

      if let error {
        runBackgroundCompletionWrite("markChunkFailed") { [weak self] in
          guard let self, self.admitsChunkCallback(ticket, "markChunkFailed") else { return }
          self.markChunkFailed(
            assetId: chunk.localAssetId,
            chunkIndex: chunk.chunkIndex,
            uploadSessionId: chunk.uploadSessionId,
            error: error.localizedDescription
          )
        }
        continuation?.resume(throwing: error)
      } else if (200..<300).contains(statusCode) {
        runBackgroundCompletionWrite("markChunkUploaded") { [weak self] in
          guard let self else { return }
          guard self.admitsChunkCallback(ticket, "markChunkUploaded") else { return }
          self.markChunkUploaded(
            assetId: chunk.localAssetId, chunkIndex: chunk.chunkIndex, uploadSessionId: chunk.uploadSessionId
          )
          DispatchQueue.main.async {
            self.updateBackupStatusSurfaces()
            self.wakeDrainLoop(reason: "background-chunk")
          }
        }
        continuation?.resume()
      } else if statusCode == 409, let responseBody, AccountRefusalDetection.accountRefusalCode(responseBody) != nil {
        // Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0): this
        // route re-checks `ensure_can_upload` on EVERY chunk (server PR
        // #129 review) — a session opened before a never-paid trial's
        // cancellation must not go on accepting chunks after it. Checked
        // BEFORE the `account_mismatch` fallback below: the two are
        // distinguishable now that a body is captured (`didReceive` above),
        // and must never be confused — this IS the right account.
        let code = AccountRefusalDetection.accountRefusalCode(responseBody)!
        handleConfirmedAccountRefusal(code: code)
        runBackgroundCompletionWrite("markChunkFailed") { [weak self] in
          guard let self, self.admitsChunkCallback(ticket, "markChunkFailed") else { return }
          self.markChunkFailed(
            assetId: chunk.localAssetId,
            chunkIndex: chunk.chunkIndex,
            uploadSessionId: chunk.uploadSessionId,
            error: "account refused (409 \(code))"
          )
        }
        continuation?.resume(throwing: BackupError.accountRefused(code: code))
      } else if statusCode == 409 {
        // Task 1599's original rationale for this branch (bare 409 on this
        // route meaning ONLY `account_mismatch`) is no longer exactly true
        // post-1605 — see the branch above. But `didReceive` capture is
        // best-effort (the buffer above can be empty if the body arrived in
        // a way this delegate missed, or was capped away by a pathological
        // response), so a 409 whose body did NOT resolve to one of the
        // task-1605 refusal codes still falls through to the ORIGINAL
        // assumption here — every other confirmed cause of a 409 on this
        // exact route remains `account_mismatch` (task 1554's
        // `check_expected_user`), and treating an unrecognised 409 as a
        // generic retryable failure instead would let a genuinely
        // mismatched session keep retrying under the wrong account's belief
        // until dead-letter, which is worse.
        handleConfirmedAccountMismatch()
        runBackgroundCompletionWrite("markChunkFailed") { [weak self] in
          guard let self, self.admitsChunkCallback(ticket, "markChunkFailed") else { return }
          self.markChunkFailed(
            assetId: chunk.localAssetId,
            chunkIndex: chunk.chunkIndex,
            uploadSessionId: chunk.uploadSessionId,
            error: "account mismatch (409)"
          )
        }
        continuation?.resume(throwing: BackupError.accountMismatchConfirmed)
      } else {
        // 408 = server fail-fast `storage.upload_stalled` (idle body — the
        // 0-byte-stall symptom). Surface it as a distinct error so the asset
        // path re-stages + requeues fast instead of climbing toward retry-10.
        let uploadError: Error = statusCode == 408
          ? BackupError.uploadStalled(chunk.chunkIndex)
          : BackupError.httpStatus(statusCode,
              responseBody.flatMap { AccountRefusalDetection.isObjectBudgetExceeded(statusCode: statusCode, body: $0) ? String(data: $0, encoding: .utf8) : nil }
                ?? "Chunk upload failed")
        runBackgroundCompletionWrite("markChunkFailed") { [weak self] in
          guard let self, self.admitsChunkCallback(ticket, "markChunkFailed") else { return }
          self.markChunkFailed(
            assetId: chunk.localAssetId,
            chunkIndex: chunk.chunkIndex,
            uploadSessionId: chunk.uploadSessionId,
            error: statusCode == 408 ? "storage.upload_stalled (408)" : "HTTP \(statusCode)"
          )
        }
        continuation?.resume(throwing: uploadError)
      }
      return
    }

    // Handle background upload completion for tasks tracked in uploadTaskMap
    guard let localAssetId = uploadTaskMap[task.taskIdentifier] else { return }
    uploadTaskMap.removeValue(forKey: task.taskIdentifier)

    runBackgroundCompletionWrite("markUploadOutcome") { [weak self] in
      guard let self, self.db != nil else { return }
      if let error = error {
        self.markFailed(assetId: localAssetId, error: error.localizedDescription)
      } else {
        let statusCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(statusCode) {
          // Background chunk upload succeeded — handled by the await in uploadChunk
        } else {
          self.markFailed(assetId: localAssetId, error: "HTTP \(statusCode)")
        }
      }
      DispatchQueue.main.async {
        self.updateBackupStatusSurfaces()
      }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    // Apple requires the completion handler to be called on the main queue. It was stashed by
    // `stashBackgroundSessionCompletionHandler` (static), see "Background URLSession relaunch
    // events" above.
    DispatchQueue.main.async { [weak self] in
      // LD-0002 (#262 review 2): iOS may suspend the app as soon as this handler is called. The
      // completions before it may have run on the open path (a background relaunch starts with
      // the gate open until the launch seed closes it), so quiesce first when no assertion holds
      // background time: the handler call is the last step.
      if let self, !self.executionGate.canStartSQLiteWork {
        self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "url-session-events-finished")
      }
      Self.takeBackgroundSessionCompletionHandler()?()
    }
  }
}
