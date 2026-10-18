import Foundation

/// Task 1667 round 10 (review of mobile#182 at 060bfeb0, finding 1 + 3).
///
/// Before ANY pending camera-roll row starts a new upload, the batch asks the
/// server whether this device already backed that photo up, and skips it if
/// so. This is the dedupe guarantee. The manifest rebuild
/// (`ManifestRebuildGate`) is only a fast path: it is applied once per
/// account and only to the rows present at that moment, so rows inserted
/// later (videos switched on, a wider album selection, Limited -> Full
/// photo access, an observer insert that races the full scan) were uploaded
/// again although the server's per-device map already had them.
///
/// Steps, in this order (each failure DEFERS the whole batch; nothing is
/// uploaded on a failure):
///   1. `POST /api/v1/files/photo-backup/check` with the batch's fresh rows
///      (up to 500 identifiers per call): the identifiers already backed up
///      on this device (`X-Beebeeb-Device-Id`).
///   2. For the hits only: their server file ids, from
///      `GET /photo-backup/identifiers` (cached per account; `/check` does not
///      return file ids). A hit the map no longer has lost its association
///      between the two calls (file deleted): it is uploaded.
///   3. For those file ids: is the file still LIVE (not in the Trash)?
///      Neither `/check` nor `/identifiers` filters trashed files (server
///      `photo_backup_state` rows cascade only on a permanent delete), so a
///      photo whose only server copy sits in the Trash would otherwise count
///      as backed up until the 30-day purge. The live set comes from
///      `GET /api/v1/files/index` (non-trashed files only; hash-revalidated,
///      `LiveFileIndexCache`). A hit whose file is not live is uploaded.
///   4. Live hits become `uploaded` with their server file id, in one fenced
///      write. Every live hit is left out of this batch's uploads, promoted or
///      not (a row the promote could not change is retried next batch, never
///      uploaded while the server has it).
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
    /// `GET /photo-backup/identifiers` failed for the hits.
    case mapFailed = "map_failed"
    /// `GET /files/index` failed: hits cannot be told apart from trashed files.
    case liveIndexFailed = "live_index_failed"
    /// The account changed while the server was asked.
    case accountChanged = "account_changed"
    /// The promotion could not be written (writer lock, no handle, fenced).
    case applyFailed = "apply_failed"
  }

  enum Outcome: Equatable {
    /// Upload every candidate EXCEPT `skip` (the live hits). `promoted` are
    /// the rows now `uploaded`; `notLive` the hits whose server file is
    /// trashed or gone (they upload).
    case proceed(skip: Set<String>, promoted: Set<String>, notLive: Set<String>)
    case deferred(DeferReason)

    static let uploadAll = Outcome.proceed(skip: [], promoted: [], notLive: [])
  }

  struct Steps {
    let hasDeviceId: () -> Bool
    /// One `/check` call (<= 500 identifiers): the identifiers the server
    /// already has for this device. Throws on any failure.
    let check: ([String]) async throws -> Set<String>
    /// local identifier -> server file id, covering at least the given hits
    /// when the server still maps them. Throws on any failure.
    let identifierMap: (Set<String>) async throws -> [String: String]
    /// The ids of every file the account has that is not in the Trash.
    let liveFileIds: () async throws -> Set<String>
    let isStillCurrent: () -> Bool
    /// Promote local identifier -> file id to `uploaded`; the identifiers
    /// actually promoted, nil unless every update committed.
    let promote: ([String: String]) -> Set<String>?
  }

  static func run(candidates: [String], steps: Steps) async -> Outcome {
    var seen = Set<String>()
    let ids = candidates.filter { !$0.isEmpty && seen.insert($0).inserted }
    guard !ids.isEmpty else { return .uploadAll }
    guard steps.hasDeviceId() else { return .deferred(.noDeviceId) }

    var hits = Set<String>()
    var start = 0
    while start < ids.count {
      let chunk = Array(ids[start..<min(start + maxIdentifiersPerCheck, ids.count)])
      start += maxIdentifiersPerCheck
      do {
        hits.formUnion(try await steps.check(chunk))
      } catch {
        return .deferred(.checkFailed)
      }
    }
    guard !hits.isEmpty else { return .uploadAll }

    let map: [String: String]
    do {
      map = try await steps.identifierMap(hits)
    } catch {
      return .deferred(.mapFailed)
    }
    var mapped: [String: String] = [:]
    for hit in hits {
      if let fileId = map[hit], !fileId.isEmpty { mapped[hit] = fileId }
    }
    guard !mapped.isEmpty else { return .uploadAll }

    let live: Set<String>
    do {
      live = try await steps.liveFileIds()
    } catch {
      return .deferred(.liveIndexFailed)
    }
    let liveHits = mapped.filter { live.contains($0.value.lowercased()) }
    let notLive = Set(mapped.keys).subtracting(liveHits.keys)
    guard !liveHits.isEmpty else { return .proceed(skip: [], promoted: [], notLive: notLive) }

    guard steps.isStillCurrent() else { return .deferred(.accountChanged) }
    guard let promoted = steps.promote(liveHits) else { return .deferred(.applyFailed) }
    return .proceed(skip: Set(liveHits.keys), promoted: promoted, notLive: notLive)
  }

  /// The rebuild's trash filter (review finding 2): the entries of the
  /// server's identifier map whose file is still out of the Trash. The map
  /// itself does not filter trashed files. An empty map needs no liveness
  /// read; a failed read throws (the rebuild gate defers on it).
  static func liveOnly(
    _ map: [String: String], liveFileIds: () async throws -> Set<String>
  ) async throws -> [String: String] {
    guard !map.isEmpty else { return map }
    let live = try await liveFileIds()
    return map.filter { live.contains($0.value.lowercased()) }
  }

  /// How long uploads stay paused after `reason` (nil: the next batch asks
  /// again; the device id arrives from JS, an account change ends the batch).
  static func backoff(for reason: DeferReason, consecutiveFailures: Int) -> TimeInterval? {
    switch reason {
    case .noDeviceId, .accountChanged:
      return nil
    case .checkFailed, .mapFailed, .liveIndexFailed:
      return ManifestRebuildGate.fetchFailureBackoff
    case .applyFailed:
      return ManifestRebuildGate.databaseFailureBackoff(consecutiveFailures: consecutiveFailures)
    }
  }
}

/// Task 1667 round 10: the account's non-trashed file ids, revalidated with
/// `GET /files/index?hash=` on every use. The server answers
/// `{"changed": false}` (no file list) when the hash is still current, so an
/// unchanged vault costs one small request; any trash, restore, upload or
/// delete changes the hash and returns the full list. Never served stale:
/// a `changed: false` answer is accepted only for the exact hash cached for
/// the same account.
struct LiveFileIndexCache {
  private(set) var accountId: String?
  private(set) var hash: String?
  private(set) var ids: Set<String> = []

  /// The hash to send for `accountId` (nil: ask for the full list).
  func knownHash(for accountId: String) -> String? {
    self.accountId == accountId ? hash : nil
  }

  /// Applies the server's answer; returns the live ids, or throws when the
  /// answer cannot be used (a `changed: false` for a hash this cache does not
  /// hold for that account).
  mutating func accept(_ index: PhotoBackupServerResponses.FileIndex, accountId: String) throws -> Set<String> {
    if let fresh = index.ids {
      self.accountId = accountId
      hash = index.hash
      ids = fresh
      return fresh
    }
    guard self.accountId == accountId, let hash, hash == index.hash else {
      throw PhotoBackupServerResponses.UnexpectedResponse(statusCode: 200, reason: "files/index unchanged for an unknown hash")
    }
    return ids
  }

  mutating func clear() {
    accountId = nil
    hash = nil
    ids = []
  }
}

/// Task 1667 round 10: the server's per-device identifier map (local
/// identifier -> file id), kept per account and device so a batch whose hits
/// are all known needs no `GET /identifiers`. Entries are added by this
/// device's own marks (`record`); a hit it does not know triggers a fresh GET.
/// A stale entry can only point at an older file of the same photo, and that
/// file is checked for liveness before anything is promoted.
struct IdentifierMapCache {
  private(set) var key: String?
  private(set) var map: [String: String] = [:]

  private static func key(_ accountId: String, _ deviceId: String) -> String { accountId + "\u{1F}" + deviceId }

  /// The cached map when it covers every hit for this account and device.
  func covering(_ hits: Set<String>, accountId: String, deviceId: String) -> [String: String]? {
    guard key == Self.key(accountId, deviceId), hits.allSatisfy({ map[$0] != nil }) else { return nil }
    return map
  }

  mutating func store(_ fresh: [String: String], accountId: String, deviceId: String) {
    key = Self.key(accountId, deviceId)
    map = fresh
  }

  /// A completed mark of this device for this account.
  mutating func record(local: String, fileId: String, accountId: String, deviceId: String) {
    guard key == Self.key(accountId, deviceId) else { return }
    map[local] = fileId
  }

  mutating func clear() {
    key = nil
    map = [:]
  }
}
