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
///   are recorded as covered (`ServerCheckCoverage`), so the next bulk pass
///   does not ask about them again.
/// - `run`: per batch, the fail-closed guard for EVERY fresh row of the batch
///   (round 12: covered or not, `batchCandidates`). Any failure defers the
///   WHOLE batch: nothing uploads.
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

  /// Round 12 (review item 1, duplicate upload): the identifiers the
  /// per-batch guard asks about: EVERY row of the batch that would start a new
  /// upload (no staged file), deduplicated. Deliberately no coverage input: a
  /// bulk answer is a snapshot, and both the row and the server can change
  /// after it. The JS reconcile re-queues an uploaded row (its forced
  /// `/files/index` read predates the upload), a file comes back out of the
  /// Trash, and in round 11 such a row skipped this check for up to 15 minutes
  /// and uploaded a second time. Staged rows resume an upload that passed this
  /// check before it was staged.
  static func batchCandidates(_ rows: [(id: String, staged: Bool)]) -> [String] {
    deduplicated(rows.filter { !$0.staged }.map(\.id))
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
  /// again; an account change ends the batch).
  ///
  /// Round 12 (review item 7): `noDeviceId` backs off like a failed fetch.
  /// Before, it had none, and a background task that ran before the first app
  /// open re-ran `processBatch` every 5 s without uploading. JS handing the id
  /// over (`setBackupDeviceId`, at every launch and at enable) ends that
  /// backoff at once (`NativeBackupEngine.backupDeviceId`).
  static func backoff(for reason: DeferReason, consecutiveFailures: Int) -> TimeInterval? {
    switch reason {
    case .accountChanged:
      return nil
    case .noDeviceId, .checkFailed, .serverLacksBackedUp:
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

  /// Round 12 (review item 2): the one identifier the capability probe sends.
  /// Not a PhotoKit local identifier (those are `UUID/L0/001`), so the server
  /// can only answer it "needs backup"; the probe reads only whether the
  /// answer carries `backed_up`, and promotes nothing. A non-empty list,
  /// because the route answers an empty one early, without `backed_up`
  /// (`photo_backup.rs` `check`: `if body.identifiers.is_empty()`).
  static let capabilityProbeIdentifier = "beebeeb.capability-probe"

  /// Round 12 (review item 2): the rebuild's map fetch while the process has
  /// seen a server without `backed_up` (task 2036). Before, the fetch threw
  /// at once and nothing else could clear the flag: every `/check` (bulk and
  /// per batch) runs after the rebuild gate, so a manifest that needs a
  /// rebuild deferred every 30 s until the app process died, even once 2036
  /// was deployed. Now, at most once per `BackedUpSupport.probeInterval`, ONE
  /// lightweight `/check` (`probe`) asks the server again; an answer with
  /// `backed_up` clears the flag (the probe's `check` step records it) and the
  /// map is fetched in the same pass. Otherwise it throws
  /// `ServerLacksBackedUp`, and the gate defers.
  static func rebuildFetch(
    lacksBackedUp: () -> Bool,
    takeProbeSlot: () -> Bool,
    probe: () async throws -> Void,
    fetch: () async throws -> [String: String]
  ) async throws -> [String: String] {
    if lacksBackedUp() {
      guard takeProbeSlot() else { throw PhotoBackupServerResponses.ServerLacksBackedUp() }
      try await probe()
      guard !lacksBackedUp() else { throw PhotoBackupServerResponses.ServerLacksBackedUp() }
    }
    return try await fetch()
  }
}

/// Task 1667 round 12 (review item 2): whether this process has seen a server
/// without `backed_up` (task 2036), and when the rebuild last probed it. Reset
/// at sign-out (`prepareForStoragePurge`): the next account starts from "not
/// seen". Before round 12 the flag was process-wide and survived sign-out and
/// account switches.
struct BackedUpSupport: Equatable {
  /// One probe per rebuild backoff period at most.
  static let probeInterval: TimeInterval = ManifestRebuildGate.fetchFailureBackoff

  private(set) var lacksBackedUp = false
  private(set) var lastProbeAt: Date?

  /// A `/check` answer: with `backed_up` (true) or without (false).
  mutating func note(supported: Bool) {
    lacksBackedUp = !supported
  }

  /// Takes the probe slot when one is due: the flag is set and no probe ran
  /// in the last `probeInterval` (or the clock went back).
  mutating func takeProbeSlot(now: Date) -> Bool {
    guard lacksBackedUp else { return false }
    if let last = lastProbeAt, now >= last, now.timeIntervalSince(last) < Self.probeInterval { return false }
    lastProbeAt = now
    return true
  }

  mutating func reset() {
    lacksBackedUp = false
    lastProbeAt = nil
  }
}

/// Task 1667 round 12 (review item 6, observability): why camera-roll uploads
/// are paused on the server check, for the progress dict
/// (`serverCheckPausedReason`, next to `manifestUnavailableReason`) and the
/// status surfaces, so Settings says that backup is paused and why. Before,
/// a deferral only set a backoff and a trace; Settings kept a frozen
/// progress line with no explanation.
struct ServerCheckPause: Equatable {
  enum Cause: String, Equatable {
    case serverLacksBackedUp = "server_lacks_backed_up"
    case checkFailed = "check_failed"
    case noDeviceId = "no_device_id"
  }

  static let serverLacksBackedUpMessage =
    "Backup paused: the server cannot yet confirm which photos this iPhone already backed up, so nothing uploads until it can. Retrying automatically."
  static let checkFailedMessage =
    "Backup paused: Beebeeb could not check with the server which photos are already backed up. Retrying automatically."
  static let noDeviceIdMessage =
    "Backup paused: this iPhone's backup ID is not available yet. Open Beebeeb to continue."

  private(set) var cause: Cause?

  /// The user-facing reason while paused; nil otherwise.
  var stopReason: String? {
    switch cause {
    case .serverLacksBackedUp?: return Self.serverLacksBackedUpMessage
    case .checkFailed?: return Self.checkFailedMessage
    case .noDeviceId?: return Self.noDeviceIdMessage
    case nil: return nil
    }
  }

  /// A deferred `/check` (per batch or bulk). Returns whether the reason
  /// changed. `accountChanged` and `applyFailed` (a local write) leave it.
  @discardableResult
  mutating func record(_ reason: PendingUploadServerCheck.DeferReason) -> Bool {
    switch reason {
    case .serverLacksBackedUp: return set(.serverLacksBackedUp)
    case .checkFailed: return set(.checkFailed)
    case .noDeviceId: return set(.noDeviceId)
    case .accountChanged, .applyFailed: return false
    }
  }

  /// A deferred rebuild: its map fetch failed (`lacksBackedUp`: because the
  /// server has no `backed_up`), or the device id is missing.
  @discardableResult
  mutating func recordRebuild(_ reason: ManifestRebuildGate.DeferReason, lacksBackedUp: Bool) -> Bool {
    switch reason {
    case .fetchFailed: return set(lacksBackedUp ? .serverLacksBackedUp : .checkFailed)
    case .noDeviceId: return set(.noDeviceId)
    case .checkFailed, .accountChanged, .applyMapFailed, .applyKeptFailed: return false
    }
  }

  /// The server answered (or nothing needed asking). Returns whether it was set.
  @discardableResult
  mutating func clear() -> Bool {
    set(nil)
  }

  private mutating func set(_ next: Cause?) -> Bool {
    guard cause != next else { return false }
    cause = next
    return true
  }
}

/// Task 1667 round 11 (review finding 9): the fresh pending rows a bulk
/// `/check` answered "needs backup" for, per account and write-fence
/// generation. Expires after `maxAge`, and is cleared at every stop and
/// sign-out (the engine) and whenever the account or the generation changes.
///
/// Round 12 (review item 1, duplicate upload): it only keeps the NEXT bulk
/// pass from asking about the same rows again (a rescan within the window).
/// The per-batch guard no longer reads it (`batchCandidates`): in round 11 a
/// covered row that uploaded and was re-queued by the JS reconcile, or whose
/// file was restored from the Trash, skipped the per-batch `/check` and
/// uploaded a second time.
struct ServerCheckCoverage: Equatable {
  static let maxAge: TimeInterval = 15 * 60

  private(set) var accountId: String?
  private(set) var generation: UInt64 = 0
  private(set) var checkedAt: Date?
  private(set) var ids: Set<String> = []

  /// The candidates NOT covered for this account and generation at `now`.
  /// Round 12: the bulk pass's filter only (never the per-batch guard's).
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
