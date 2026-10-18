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
        // AFTER the server map (the rebuild is decided on "nothing uploaded
        // yet"): uploads the server's map did not have at the last sign-out.
        guard let kept = steps.applyKept() else { return .deferred(.applyKeptFailed) }
        return .ready(rebuilt: true, promoted: promoted, keptApplied: kept)
      }
    }
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
  /// device id arrives from JS; the next batch checks again).
  static func backoff(for reason: DeferReason, consecutiveFailures: Int) -> TimeInterval? {
    switch reason {
    case .noDeviceId, .accountChanged:
      return nil
    case .fetchFailed:
      return fetchFailureBackoff
    case .checkFailed, .applyMapFailed, .applyKeptFailed:
      return databaseFailureBackoff(consecutiveFailures: consecutiveFailures)
    }
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
