import Foundation

/// Task 1667 round 4 (Codex P1 "Fail closed when applying the server
/// identifier map").
///
/// Decides whether the camera-roll backup may upload for an account, given
/// the steps of the manifest rebuild path. `NativeBackupEngine
/// .ensureManifestReadyForUploads` supplies the steps (each database step
/// inside `dbQueue.sync`); this type owns only the ORDER and the rule:
///
///   claim + "needs a rebuild?"  ->  device id  ->  GET identifiers
///   ->  account still current  ->  apply the server map  ->  apply kept marks
///
/// Every step that fails (nil, a throw, false) DEFERS: no upload starts, and
/// the engine retries after a bounded backoff. A failure is never read as
/// "nothing there": before round 4 a failed `applyServerMap` returned 0, the
/// same value as "the server has none of these photos", the engine declared
/// the account ready, and the scan queued every photo already backed up.
///
/// Kept free of PhotoKit/UIKit/Expo so
/// `scripts/swift-tests/manifest-rebuild-gate-test.swift` drives it with
/// swiftc against a real SQLite file, with a second connection holding the
/// writer lock.
enum ManifestRebuildGate {
  enum DeferReason: String, Equatable {
    /// claim or the uploaded-row count could not run or commit.
    case checkFailed = "check_failed"
    /// The canonical device id has not reached native yet.
    case noDeviceId = "no_device_id"
    /// GET /photo-backup/identifiers failed (network, 5xx, bad body).
    case fetchFailed = "fetch_failed"
    /// The account changed while the map was being fetched.
    case accountChanged = "account_changed"
    /// The server map could not be written (writer lock, no handle, ...).
    case applyMapFailed = "apply_map_failed"
    /// The kept sign-out marks could not be read or written.
    case applyKeptFailed = "apply_kept_failed"
    /// Round 14: a kept in-flight upload could not be resolved because the
    /// server could not be asked (offline, 5xx, 429, an answer that is not
    /// the API's own). Round 15: server failures only.
    case resolveKeptFailed = "resolve_kept_failed"
    /// Round 15 (review item 6): a LOCAL failure of the resolution: the kept
    /// rows could not be read (a fenced load from a stale ticket, no handle)
    /// or the answer could not be written (busy). No request was made, so it
    /// takes the database backoff and shows no server pause.
    case resolveKeptStoreFailed = "resolve_kept_store_failed"
  }

  enum Outcome: Equatable {
    /// Uploads may start. `rebuilt` is true when the server map was applied
    /// in this call.
    case ready(rebuilt: Bool, promoted: Int, keptApplied: Int)
    case deferred(DeferReason)
  }

  struct Steps {
    /// Claim the manifest for the account, then: does it hold nothing this
    /// account uploaded? nil = could not tell (failure).
    let needsRebuild: () -> Bool?
    let hasDeviceId: () -> Bool
    /// The server's per-device map, local identifier -> file id. Throws on
    /// any failure; an empty map is a valid answer.
    let fetchMap: () async throws -> [String: String]
    let isStillCurrent: () -> Bool
    /// Rows promoted; nil unless every update committed.
    let applyMap: ([String: String]) -> Int?
    /// Kept sign-out marks promoted; nil when they could not be applied.
    let applyKept: () -> Int?
    /// Round 14 (review of mobile#182 at 18312919, the P1): resolves the
    /// account's kept in-flight uploads against the server
    /// (`KeptUploadResolution.run`) BEFORE the kept marks are applied, so a
    /// photo whose upload completed unrecorded is promoted instead of
    /// uploaded again. false = defer (no upload starts). The engine always
    /// passes it (wiring guard); the default serves tests of other steps.
    /// Round 15 (review item 6): a server failure and a local failure defer
    /// with different reasons (`KeptUploadResolution.Result`).
    var resolveKept: () async -> KeptUploadResolution.Result = { .resolved }
  }

  /// Round 15 (review item 6): the deferral reason for a resolution result;
  /// nil when it resolved.
  static func deferReason(_ result: KeptUploadResolution.Result) -> DeferReason? {
    switch result {
    case .resolved: return nil
    case .serverFailed: return .resolveKeptFailed
    case .storeFailed: return .resolveKeptStoreFailed
    }
  }

  /// `alreadyReady`: the account's manifest was checked against (or rebuilt
  /// from) the server map earlier in this process. Kept marks are still
  /// applied before every batch (rows the scan inserted since may match).
  static func run(alreadyReady: Bool, steps: Steps) async -> Outcome {
    if !alreadyReady {
      guard let needsRebuild = steps.needsRebuild() else { return .deferred(.checkFailed) }
      if needsRebuild {
        guard steps.hasDeviceId() else { return .deferred(.noDeviceId) }
        let map: [String: String]
        do {
          map = try await steps.fetchMap()
        } catch {
          return .deferred(.fetchFailed)
        }
        guard steps.isStillCurrent() else { return .deferred(.accountChanged) }
        guard let promoted = steps.applyMap(map) else { return .deferred(.applyMapFailed) }
        // Round 14: in-flight uploads kept at sign-out are resolved first.
        if let reason = deferReason(await steps.resolveKept()) { return .deferred(reason) }
        // AFTER the server map (the rebuild is decided on "nothing uploaded
        // yet"): uploads the server's map did not have at the last sign-out.
        guard let kept = steps.applyKept() else { return .deferred(.applyKeptFailed) }
        return .ready(rebuilt: true, promoted: promoted, keptApplied: kept)
      }
    }
    if let reason = deferReason(await steps.resolveKept()) { return .deferred(reason) }
    guard let kept = steps.applyKept() else { return .deferred(.applyKeptFailed) }
    return .ready(rebuilt: false, promoted: 0, keptApplied: kept)
  }

  /// Fixed wait after a failed server fetch (unchanged from round 1: one GET
  /// per 30 s at most while the server is unreachable).
  static let fetchFailureBackoff: TimeInterval = 30

  /// Bounded backoff after a failed DATABASE step on the rebuild path (a
  /// writer lock is usually gone within moments): 2, 4, 8, 16, then 30 s for
  /// every further consecutive failure. Never zero, never above 30 s.
  static func databaseFailureBackoff(consecutiveFailures: Int) -> TimeInterval {
    let n = min(max(consecutiveFailures, 1), 5)
    return min(30, TimeInterval(1 << n))
  }

  /// How long uploads stay paused after `reason`. nil = no backoff (the
  /// next batch checks again).
  ///
  /// Task 1667 round 12 (review item 7): `noDeviceId` backs off like a failed
  /// fetch instead of re-running every 5 s; JS handing the id over ends the
  /// backoff (`NativeBackupEngine.backupDeviceId`).
  static func backoff(for reason: DeferReason, consecutiveFailures: Int) -> TimeInterval? {
    switch reason {
    case .accountChanged:
      return nil
    case .noDeviceId, .fetchFailed, .resolveKeptFailed:
      return fetchFailureBackoff
    case .checkFailed, .applyMapFailed, .applyKeptFailed, .resolveKeptStoreFailed:
      return databaseFailureBackoff(consecutiveFailures: consecutiveFailures)
    }
  }

  /// Round 15 (review item 2): the backoff deadline after a deferral. A
  /// later deadline already set in this pass (a 429's `Retry-After`, set by
  /// `inspectExistingUpload`) is kept; the gate's own wait never shortens it.
  static func backoffDeadline(existing: Date?, now: Date, wait: TimeInterval) -> Date {
    let own = now.addingTimeInterval(wait)
    guard let existing, existing > own else { return own }
    return existing
  }
}

/// Task 1667 round 14 (review of mobile#182 at 18312919, the P1): at an
/// account's sign-in, its uploads that were in flight at its last sign-out
/// (`backup_pending_marks.needs_resolution = 1`) are resolved against the
/// server before any upload: `ask` is `GET /files/{id}` (complete when
/// `is_uploading` is false). Complete -> the row becomes an ordinary kept
/// mark, so `applyPendingMarks` promotes the photo to `uploaded` and the mark
/// catch-up records it on the server. Not complete (still uploading, or 404)
/// -> the row is dropped and the photo uploads as normal. A failed read, a
/// failed ask (offline, 5xx, 429, an answer that is not the API's own) or a
/// failed write defers the gate: no upload starts while one of these may be
/// complete. Only `accountId`'s rows are ever read (the engine's `load`).
///
/// Round 15 (review items 2, 3, 6): `ask` is true ONLY for the API's 2xx
/// with `is_uploading` false and the file not in the Trash
/// (`PhotoBackupServerResponses.existingUpload`); it throws for anything that
/// is not the API's answer. A failed ask is `serverFailed` (fetch backoff,
/// the "could not check" pause); a failed load or write is `storeFailed`
/// (database backoff, no pause).
enum KeptUploadResolution {
  enum Result: Equatable {
    case resolved
    /// The server could not be asked, or its answer was not the API's.
    case serverFailed
    /// The rows could not be read or the answer not written (no request).
    case storeFailed
  }

  static func run(
    load: () -> [BackupManifestStore.KeptInFlight]?,
    ask: (BackupManifestStore.KeptInFlight) async throws -> Bool,
    record: (BackupManifestStore.KeptInFlight, Bool) -> Bool
  ) async -> Result {
    guard let rows = load() else { return .storeFailed }
    for row in rows {
      let complete: Bool
      do {
        complete = try await ask(row)
      } catch {
        return .serverFailed
      }
      guard record(row, complete) else { return .storeFailed }
    }
    return .resolved
  }
}

/// Task 1667 round 10 (review of mobile#182 at 060bfeb0, finding 4): whether
/// a camera-roll insert into the manifest failed since the last FULL scan
/// inserted successfully. While set, the rebuild gate does not apply the
/// server map onto a manifest a scan could not fill.
///
/// Before round 10 the engine kept only the LAST insert's result, so a
/// successful one-photo insert from `photoLibraryDidChange` cleared the full
/// scan's failure, and the next gate rebuilt over a manifest missing the
/// full scan's rows. Now a failure of any insert is sticky, and only a
/// successful insert of a full scan (`scanPhotoLibraryForPendingUploads`,
/// every asset in the backup scope) clears it. Uploads no longer depend on
/// it for dedupe (`PendingUploadServerCheck` checks every batch); it keeps
/// the rebuild fast path from promoting a partial manifest.
struct ScanInsertHealth: Equatable {
  private(set) var failed = false

  enum Source: Equatable {
    /// The scan of the whole backup scope.
    case fullScan
    /// An incremental insert (`photoLibraryDidChange`).
    case incremental
  }

  mutating func record(inserted: Bool, source: Source) {
    if !inserted {
      failed = true
    } else if source == .fullScan {
      failed = false
    }
  }
}
