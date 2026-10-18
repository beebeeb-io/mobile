import Foundation

/// Task 1667 round 10 (review of mobile#182 at 060bfeb0, finding 1 + 3),
/// reworked in round 11 (review of de23774e, findings 2 and 9; server task
/// 2036).
///
/// Before ANY pending camera-roll row starts a new upload, the server is
/// asked whether this device already backed that photo up, and the row is
/// skipped if so. This is the dedupe guarantee. The manifest rebuild
/// (`ManifestRebuildGate`) is only a fast path: it is applied once per
/// account and only to the rows present at that moment, so rows inserted
/// later (videos switched on, a wider album selection, Limited -> Full
/// photo access, an observer insert that races the full scan) were uploaded
/// again although the server's per-device map already had them.
///
/// The contract (server task 2036, `photo_backup.rs` `check`):
/// `POST /api/v1/files/photo-backup/check` excludes files in the Trash and
/// returns `backed_up: [{local_identifier, file_id}]`. A row is promoted to
/// `uploaded` ONLY when it is in `backed_up`, with that file id. A server
/// without the field fails closed: nothing is promoted and nothing of that
/// batch uploads (`serverLacksBackedUp`, fetch backoff, logged once per
/// process). Round 10's client-side liveness read (`GET /api/v1/files/index`
/// plus the identifiers map per hit) is gone: native code never reads the
/// file index (mobile CLAUDE.md, task 1959).
///
/// Two passes use the same steps:
/// - `bulk`: before the drain selects upload rows, ALL fresh pending rows
///   (no staged file) not covered yet, in chunks of 500 (the route's cap),
///   once per drain start and again whenever rows were inserted. Hits are
///   promoted chunk by chunk; the rows the server answered "needs backup"
///   are recorded as covered (`ServerCheckCoverage`).
/// - `run`: per batch, the fail-closed guard for the batch's fresh rows
///   that no bulk pass covered (inserted since, or the bulk pass failed).
///   Any failure defers the WHOLE batch: nothing uploads.
///
/// Pure (no URLSession, no SQLite, no PhotoKit), so
/// `scripts/swift-tests/pending-upload-server-check-test.swift` drives it with
/// the real HTTP client and a real SQLite manifest.
enum PendingUploadServerCheck {
  /// The server route's own cap (`photo_backup.rs` `check`: "at most 500").
  static let maxIdentifiersPerCheck = 500

  enum DeferReason: String, Equatable {
    /// The canonical device id has not reached native yet.
    case noDeviceId = "no_device_id"
    /// `POST /photo-backup/check` failed (network, non-2xx, bad body).
    case checkFailed = "check_failed"
    /// The server answered `/check` without `backed_up` (no task 2036): it
    /// cannot tell a trashed backup from a live one, so nothing is promoted
    /// and nothing uploads.
    case serverLacksBackedUp = "server_lacks_backed_up"
    /// The account changed while the server was asked.
    case accountChanged = "account_changed"
    /// The promotion could not be written (writer lock, no handle, fenced).
    case applyFailed = "apply_failed"
  }

  enum Outcome: Equatable {
    /// Upload every candidate EXCEPT `skip` (the server's hits). `promoted`
    /// are the rows now `uploaded`; `checked` the identifiers sent to /check.
    case proceed(skip: Set<String>, promoted: Set<String>, checked: Set<String>)
    case deferred(DeferReason)

    static let uploadAll = Outcome.proceed(skip: [], promoted: [], checked: [])
  }

  struct Steps {
    let hasDeviceId: () -> Bool
    /// One `/check` call (<= 500 identifiers): the identifiers the server
    /// already has for this device, out of the Trash, with their file ids.
    /// Throws on any failure (`ServerLacksBackedUp` without task 2036).
    let check: ([String]) async throws -> [String: String]
    let isStillCurrent: () -> Bool
    /// Promote local identifier -> file id to `uploaded`; the identifiers
    /// actually promoted, nil unless every update committed.
    let promote: ([String: String]) -> Set<String>?
  }

  static func deduplicated(_ candidates: [String]) -> [String] {
    var seen = Set<String>()
    return candidates.filter { !$0.isEmpty && seen.insert($0).inserted }
  }

  static func chunks(_ ids: [String]) -> [[String]] {
    stride(from: 0, to: ids.count, by: maxIdentifiersPerCheck).map {
      Array(ids[$0..<min($0 + maxIdentifiersPerCheck, ids.count)])
    }
  }

  private static func reason(for error: Error) -> DeferReason {
    error is PhotoBackupServerResponses.ServerLacksBackedUp ? .serverLacksBackedUp : .checkFailed
  }

  /// The per-batch guard. Asks about every candidate (chunked at 500), then
  /// promotes the hits in one write. Any failure: `.deferred`, nothing
  /// promoted, nothing uploads.
  static func run(candidates: [String], steps: Steps) async -> Outcome {
    let ids = deduplicated(candidates)
    guard !ids.isEmpty else { return .uploadAll }
    guard steps.hasDeviceId() else { return .deferred(.noDeviceId) }

    var hits: [String: String] = [:]
    for chunk in chunks(ids) {
      do {
        hits.merge(try await steps.check(chunk)) { _, new in new }
      } catch {
        return .deferred(reason(for: error))
      }
    }
    let checked = Set(ids)
    guard !hits.isEmpty else { return .proceed(skip: [], promoted: [], checked: checked) }
    guard steps.isStillCurrent() else { return .deferred(.accountChanged) }
    guard let promoted = steps.promote(hits) else { return .deferred(.applyFailed) }
    return .proceed(skip: Set(hits.keys), promoted: promoted, checked: checked)
  }

  struct BulkOutcome: Equatable {
    /// Rows promoted to `uploaded` (the server's hits).
    var promoted: Set<String> = []
    /// Rows the server answered "needs backup" for: covered, the per-batch
    /// check may skip them.
    var needsBackup: Set<String> = []
    /// `/check` requests sent.
    var requests = 0
    /// Why the pass stopped early (the rest is left to the per-batch guard).
    var stopped: DeferReason?
  }

  /// The bulk pass (review finding 9). Chunk by chunk: ask, promote the
  /// chunk's hits, record its "needs backup" rows. Stops at the first failure
  /// (or when `shouldContinue` turns false) and reports what it finished;
  /// nothing of an unfinished chunk is promoted or covered.
  static func bulk(
    candidates: [String], steps: Steps, shouldContinue: () -> Bool = { true }
  ) async -> BulkOutcome {
    var out = BulkOutcome()
    let ids = deduplicated(candidates)
    guard !ids.isEmpty else { return out }
    guard steps.hasDeviceId() else {
      out.stopped = .noDeviceId
      return out
    }
    for chunk in chunks(ids) {
      guard shouldContinue() else { break }
      let hits: [String: String]
      do {
        out.requests += 1
        hits = try await steps.check(chunk)
      } catch {
        out.stopped = reason(for: error)
        return out
      }
      if !hits.isEmpty {
        guard steps.isStillCurrent() else {
          out.stopped = .accountChanged
          return out
        }
        guard let promoted = steps.promote(hits) else {
          out.stopped = .applyFailed
          return out
        }
        out.promoted.formUnion(promoted)
      }
      out.needsBackup.formUnion(Set(chunk).subtracting(hits.keys))
    }
    return out
  }

  /// How long uploads stay paused after `reason` (nil: the next batch asks
  /// again; the device id arrives from JS, an account change ends the batch).
  static func backoff(for reason: DeferReason, consecutiveFailures: Int) -> TimeInterval? {
    switch reason {
    case .noDeviceId, .accountChanged:
      return nil
    case .checkFailed, .serverLacksBackedUp:
      return ManifestRebuildGate.fetchFailureBackoff
    case .applyFailed:
      return ManifestRebuildGate.databaseFailureBackoff(consecutiveFailures: consecutiveFailures)
    }
  }

  /// "server lacks backed_up (task 2036)" is logged once per process, not
  /// once per deferred batch.
  final class OnceNotice {
    private let lock = NSLock()
    private var fired = false

    /// True the first time only.
    func shouldFire() -> Bool {
      lock.lock(); defer { lock.unlock() }
      if fired { return false }
      fired = true
      return true
    }
  }

  static let serverLacksBackedUpNotice = OnceNotice()
  static let serverLacksBackedUpMessage = "server lacks backed_up (task 2036)"
}

/// Task 1667 round 11 (review finding 9): the fresh pending rows a bulk
/// `/check` answered "needs backup" for, per account and write-fence
/// generation. The per-batch guard skips these; any other fresh row (inserted
/// since, or left by a bulk pass that failed) is checked per batch. Expires
/// after `maxAge` so a long drain asks again, and is cleared at every stop and
/// sign-out (the engine) and whenever the account or the generation changes.
struct ServerCheckCoverage: Equatable {
  static let maxAge: TimeInterval = 15 * 60

  private(set) var accountId: String?
  private(set) var generation: UInt64 = 0
  private(set) var checkedAt: Date?
  private(set) var ids: Set<String> = []

  /// The candidates NOT covered for this account and generation at `now`.
  func uncovered(_ candidates: [String], accountId: String, generation: UInt64, now: Date) -> [String] {
    guard self.accountId == accountId, self.generation == generation, let checkedAt,
          now.timeIntervalSince(checkedAt) < Self.maxAge, now >= checkedAt else { return candidates }
    return candidates.filter { !ids.contains($0) }
  }

  /// A bulk pass answered "needs backup" for `needsBackup`.
  mutating func record(_ needsBackup: Set<String>, accountId: String, generation: UInt64, now: Date) {
    let expired = checkedAt.map { now.timeIntervalSince($0) >= Self.maxAge || now < $0 } ?? true
    if self.accountId != accountId || self.generation != generation || expired {
      ids = []
      checkedAt = now
    }
    self.accountId = accountId
    self.generation = generation
    // The window runs from the OLDEST answer it holds.
    ids.formUnion(needsBackup)
  }

  mutating func clear() {
    accountId = nil
    generation = 0
    checkedAt = nil
    ids = []
  }
}
