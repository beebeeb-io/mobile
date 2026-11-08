import Foundation
import SQLite3

/// Task LD-0002 round 2 (TestFlight 258, `RUNNINGBOARD 0xdead10cc`): the main
/// app's connections to the File Provider cache database.
///
/// The cache lives in the app-group container. iOS kills an app that holds a
/// lock on a file in a shared container when it suspends it. On 2026-11-07
/// thread 14 was inside `sqlite3_step` under `syncFileProviderCache` (the
/// JS-called upsert into this database) with the app in the background, and
/// that write transaction held the file's lock. Round 1 (mobile#262) put the
/// camera-roll manifest and the thumbnail queue behind `BackupExecutionGate`;
/// this database was not behind it.
///
/// This is that same gate, not a second one. A `Section` is one connection's
/// lifetime in the main app: `enter()` asks the gate, `attach(_:)` publishes
/// the connection so an expiry can interrupt it, `finish(closing:)` withdraws
/// it, closes it and leaves. The quiesce (`BackupSQLiteQuiesce`, driven by
/// `NativeBackupEngine`) interrupts every attached section and waits for all of
/// them to finish before the background task ends.
///
/// The rule a section's owner keeps: before each statement of a loop, ask
/// `admits`. `sqlite3_interrupt` aborts the statement running when it lands
/// and is a no-op between statements, so a loop of short statements would
/// otherwise carry on past the quiesce until its COMMIT. When `admits` turns
/// false the transaction is rolled back and the call reports "not now".
///
/// The extension's own `CacheManager` (`targets/file-provider/`) runs in the
/// extension's process, which iOS suspends on its own schedule; this gate has
/// nothing to do with it.
public enum FileProviderCacheOutcome<Value> {
  case done(Value)
  /// The gate refused: no background time is left (or ended while the call
  /// ran and its transaction was rolled back). NOTHING was written. The caller
  /// must retry when the app is foreground again.
  case notNow
  /// The write failed with the gate open (busy past the timeout, a full disk, a corrupt file).
  /// The transaction was rolled back: NOTHING was written, and it is NOT a refusal to retry
  /// blindly. The bridge reports it so the caller never counts the write as landed.
  case failed
}

extension FileProviderCacheOutcome where Value == Int {
  /// What the JS bridge receives: `{status: "ok", count}` or
  /// `{status: "not_now"}` (`BeebeebCrypto.ts`, `FileProviderCacheWriteResult`).
  public var bridged: [String: Any] {
    switch self {
    case .done(let count): return ["status": "ok", "count": count]
    case .notNow: return ["status": "not_now"]
    case .failed: return ["status": "failed"]
    }
  }
}

/// The C progress callback of every cache connection: non-zero aborts the
/// running statement while the gate refuses (see `SQLiteStatementGate`).
private let fileProviderCacheProgress: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = { context in
  SQLiteStatementGate.shouldAbort(context: context)
}

/// LD-0002 round 2 (review of #273): SQLite's own busy wait (`sqlite3_busy_timeout`)
/// sleeps in a loop that never looks at `sqlite3_interrupt` or the progress handler,
/// so a connection waiting for the extension's lock could outlive the quiesce wait,
/// take the lock after background time ended, and be suspended holding it. This
/// handler asks the gate on every retry and gives up (SQLITE_BUSY) the moment it has
/// closed.
private final class BusyWait {
  unowned let section: FileProviderCacheDB.Section
  let limitMilliseconds: Int32
  var startedAt = Date()
  init(section: FileProviderCacheDB.Section, limitMilliseconds: Int32) {
    self.section = section
    self.limitMilliseconds = limitMilliseconds
  }
}

private let fileProviderCacheBusy: @convention(c) (UnsafeMutableRawPointer?, Int32) -> Int32 = { context, attempt in
  guard let context else { return 0 }
  let wait = Unmanaged<BusyWait>.fromOpaque(context).takeUnretainedValue()
  if attempt == 0 { wait.startedAt = Date() }
  guard wait.section.admits else { return 0 }
  if Date().timeIntervalSince(wait.startedAt) * 1000 >= Double(wait.limitMilliseconds) { return 0 }
  usleep(2_000)
  return 1
}

public final class FileProviderCacheDB: SQLiteResetScope {
  public final class Section: SQLiteResetSection {
    private unowned let owner: FileProviderCacheDB
    private let closuresAtEnter: UInt64
    /// A section that resets the cache (the sign-out purge). One the gate stopped before
    /// it finished leaves the reset OWED: the old account's rows are still on disk.
    public var isReset = false
    private let target = SQLiteInterruptTarget { sqlite3_interrupt($0) }
    fileprivate var busyWait: AnyObject?

    fileprivate init(owner: FileProviderCacheDB, closuresAtEnter: UInt64) {
      self.owner = owner
      self.closuresAtEnter = closuresAtEnter
    }

    /// True while background time has not ended since `enter()`. A gate that
    /// closed and reopened since (an app switch) stays false for this
    /// section: a statement may have been aborted in between, and the section
    /// would not know which.
    public var admits: Bool {
      owner.gate.isOpen(since: closuresAtEnter)
    }

    /// Call right after the connection opened.
    public func attach(_ db: OpaquePointer) {
      sqlite3_progress_handler(db, SQLiteStatementGate.progressOps, fileProviderCacheProgress, owner.statements.progressContext)
      target.publish(db)
    }

    /// Replaces `sqlite3_busy_timeout`: waits for another process's lock for at
    /// most `milliseconds`, and not at all once the gate has closed.
    public func setBusyTimeout(_ db: OpaquePointer, milliseconds: Int32) {
      let wait = BusyWait(section: self, limitMilliseconds: milliseconds)
      busyWait = wait
      sqlite3_busy_handler(db, fileProviderCacheBusy, Unmanaged.passUnretained(wait).toOpaque())
    }

    /// Withdraws the connection BEFORE closing it (an interrupt in flight
    /// holds the target's lock, so the close waits for it), closes it, and
    /// leaves the section. A nil `db` (the open failed) only leaves.
    public func finish(closing db: OpaquePointer?) {
      target.withdraw()
      if let db { sqlite3_close(db) }
      // A reset that the gate closed on was rolled back (or never finished): it is owed.
      // (At worst a reset that had just completed is run once more: a cache, repopulated.)
      if isReset && !admits { owner.markResetOwed() }
      owner.leave(self)
    }

    fileprivate func interrupt() {
      target.interrupt()
    }
  }

  private let gate: BackupExecutionGate
  private let statements: SQLiteStatementGate
  private let condition = NSCondition()
  private var inFlight: [ObjectIdentifier: Section] = [:]
  private let owedStateLock = NSLock()
  private let settleLock = NSLock()
  private var owedInMemory = false
  private var realFailures = 0
  private let owedStore: (get: () -> Bool, set: (Bool) -> Void)?

  /// The gate is fed the app's state by `BackupGateLifecycle` (seeded at launch, no
  /// engine needed) and, once built, by `NativeBackupEngine`.
  /// `owedStore` persists "a reset of the cache is still owed" across launches
  /// (production: a key in the app-group defaults); nil keeps it in memory.
  public init(
    gate: BackupExecutionGate,
    owedStore: (get: () -> Bool, set: (Bool) -> Void)? = nil
  ) {
    self.gate = gate
    self.statements = SQLiteStatementGate(gate: gate)
    self.owedStore = owedStore
  }

  /// Asks the gate for a connection's worth of SQLite work. nil = "not now":
  /// open nothing, run nothing.
  public func enter() -> Section? {
    // The gate is asked INSIDE the lock `waitForQuiet` takes. A quiesce closes
    // the gate first and then takes this lock; so an `enter` is either before
    // that wait (its section is registered and awaited) or after it (the gate
    // is already closed and it is refused). Never between.
    condition.lock()
    defer { condition.unlock() }
    // Open and the closure count in ONE locked step: a closure landing between two
    // reads would record the post-close count against a pre-close "open".
    let state = gate.openState()
    guard state.open else { return nil }
    let section = Section(owner: self, closuresAtEnter: state.closures)
    inFlight[ObjectIdentifier(section)] = section
    return section
  }

  // `SQLiteResetScope`: `PlaintextStorageProtection.purgeAll` resets this same
  // file in place on sign-out, inside the same gate.
  public func begin() -> SQLiteResetSection? {
    guard let section = enter() else {
      // A reset the gate refused is still owed: the old account's rows are on disk.
      markResetOwed()
      return nil
    }
    section.isReset = true
    return section
  }

  // MARK: - A refused reset is a debt

  /// True while a reset of the cache (sign-out) was refused and has not run since.
  public var resetOwed: Bool {
    owedStateLock.lock()
    defer { owedStateLock.unlock() }
    // Both: with no usable store (the app-group defaults unavailable) the in-memory debt still counts.
    return owedInMemory || owedStore?.get() == true
  }

  public func markResetOwed() {
    owedStateLock.lock()
    owedInMemory = true
    owedStore?.set(true)
    owedStateLock.unlock()
  }

  /// Runs `reset` first when one is owed, BEFORE any caller writes the next
  /// account's names; clears the debt only when it returned true. True = nothing
  /// owed or paid. Retries are serialized; `reset` may itself call `markResetOwed`.
  @discardableResult
  public func settleOwedReset(maxFailures: Int = 3, _ reset: () -> Bool, escalate: () -> Void = {}) -> Bool {
    settleLock.lock()
    defer { settleLock.unlock() }
    guard resetOwed else { return true }
    let closuresBefore = gate.closures
    if !reset() {
      // A refusal is the gate's business and costs nothing: it is closed now, or it closed (and
      // may have reopened) while the reset ran. A real failure with the gate open (a full disk, a
      // corrupt file, no container) is counted: at `maxFailures` it ESCALATES, once. The cache file
      // is never unlinked here: the extension holds its connection open for the life of its process
      // and never reopens it, so a deleted file leaves the old rows visible to Files for good.
      // The debt stays owed.
      if gateRefuses || gate.closures != closuresBefore { return false }
      realFailures += 1
      if realFailures == maxFailures { escalate() }
      return false
    }
    realFailures = 0
    owedStateLock.lock()
    owedInMemory = false
    owedStore?.set(false)
    owedStateLock.unlock()
    return true
  }

  /// The gate refuses new connections right now (used to tell a refusal from a failure).
  public var gateRefuses: Bool {
    !gate.canStartSQLiteWork
  }

  /// How many times the gate has closed so far. A caller that wants to know whether it closed DURING
  /// its work compares this with the value it read at the start: the current state alone misses a
  /// closure that has already reopened.
  public var gateClosures: UInt64 {
    gate.closures
  }

  fileprivate func leave(_ section: Section) {
    condition.lock()
    inFlight[ObjectIdentifier(section)] = nil
    condition.broadcast()
    condition.unlock()
  }

  /// Aborts the statement running on every attached connection. Safe from any
  /// thread.
  public func interruptInFlightStatements() {
    condition.lock()
    let sections = Array(inFlight.values)
    condition.unlock()
    for section in sections { section.interrupt() }
  }

  /// True once every section that entered has finished (its connection is
  /// closed), within `timeout`. Never call it from inside a section.
  public func waitForQuiet(timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(max(0, timeout))
    condition.lock()
    defer { condition.unlock() }
    while !inFlight.isEmpty {
      if !condition.wait(until: deadline) { return inFlight.isEmpty }
    }
    return true
  }

  public var sectionsInFlight: Int {
    condition.lock()
    defer { condition.unlock() }
    return inFlight.count
  }
}

// MARK: - The JS-called upsert

public struct FileProviderCacheSyncResult {
  public let count: Int
  /// Real parent ids whose listing changed. The root container is `touchesRoot`.
  public let touchedParentIdentifiers: Set<String>
  public let touchesRoot: Bool
  /// A prune pass ran over a touched parent (an emptied folder has count 0
  /// and still needs Files.app to re-enumerate).
  public let didPrune: Bool
}

public enum FileProviderCacheSync {
  /// The body of `syncFileProviderCache` after the connection is open and
  /// prepared (protected, `secure_delete` on, schema ensured). One
  /// transaction: every upsert and the prune pass, or none of them.
  ///
  /// LD-0002 round 2: `section.admits` is asked before every statement. When it
  /// turns false, or a step comes back `SQLITE_INTERRUPT` (an expiry landed on
  /// it), the transaction is rolled back and the call answers `.notNow`; no
  /// statement and no write transaction is left on the connection.
  public static func apply(
    db: OpaquePointer,
    section: FileProviderCacheDB.Section,
    entries: [[String: Any]],
    prune shouldPrune: Bool,
    pruneParents: [Any]?
  ) -> FileProviderCacheOutcome<FileProviderCacheSyncResult> {
    func abandon() -> FileProviderCacheOutcome<FileProviderCacheSyncResult> {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return .notNow
    }
    func fail() -> FileProviderCacheOutcome<FileProviderCacheSyncResult> {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return .failed
    }

    let upsertSql = """
    INSERT INTO file_cache(
      id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
      is_folder, is_pinned, has_thumbnail, created_at, updated_at, sync_anchor, is_materialized
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      name_encrypted = excluded.name_encrypted,
      name_decrypted = COALESCE(excluded.name_decrypted, file_cache.name_decrypted),
      display_name = CASE
        WHEN file_cache.parent_id IS NOT excluded.parent_id
          OR (excluded.name_decrypted IS NOT NULL AND file_cache.name_decrypted IS NOT excluded.name_decrypted)
        THEN NULL ELSE file_cache.display_name END,
      display_name_source_name = CASE
        WHEN file_cache.parent_id IS NOT excluded.parent_id
          OR (excluded.name_decrypted IS NOT NULL AND file_cache.name_decrypted IS NOT excluded.name_decrypted)
        THEN NULL ELSE file_cache.display_name_source_name END,
      display_name_source_parent = CASE
        WHEN file_cache.parent_id IS NOT excluded.parent_id
          OR (excluded.name_decrypted IS NOT NULL AND file_cache.name_decrypted IS NOT excluded.name_decrypted)
        THEN NULL ELSE file_cache.display_name_source_parent END,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      is_folder = excluded.is_folder,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      sync_anchor = excluded.sync_anchor;
    """

    guard section.admits else { return .notNow }
    // A BEGIN that fails (busy, aborted) must stop the work: every statement after
    // it would autocommit one by one and a later rollback would undo nothing.
    guard sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK else { return .notNow }
    var count = 0
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    var touchedParentIdentifiers = Set<String>()
    var touchesRoot = false
    // Per-parent COMPLETE child-id sets, keyed by the SQLite parent_id value
    // (the real parent string, or nil -> the root sentinel below). Only used
    // when `shouldPrune` is true. Mirrors CacheManager._deleteChildren's
    // (parent, keepingIds) contract: we keep exactly the ids the caller sent
    // for that parent and delete every other row under it.
    let rootParentSentinel = "\u{0}__bb_root__"
    var childIdsByParent: [String: Set<String>] = [:]

    // Seed prune targets that may contribute NO entries. The JS write-through
    // passes `pruneParents` for every affected parent — including folders that
    // became EMPTY (last live child trashed/deleted remotely) and remotely
    // trashed FOLDERs whose descendant rows must be cleared. Those parents
    // would never appear in the per-entry derivation below (no rows to upsert),
    // so without seeding their prune DELETE never runs and Files.app keeps the
    // vanished rows. Seeding an empty keep-set here means the prune pass deletes
    // EVERY surviving row under them and re-enumerates. A `nil`/NSNull element
    // is the root container (matching the per-entry null-parent handling). Only
    // honoured when pruning — a partial push never names pruneParents.
    if shouldPrune, let pruneParents {
      for raw in pruneParents {
        if let parentId = raw as? String {
          if childIdsByParent[parentId] == nil { childIdsByParent[parentId] = [] }
          touchedParentIdentifiers.insert(parentId)
        } else {
          // nil / NSNull -> root container.
          if childIdsByParent[rootParentSentinel] == nil { childIdsByParent[rootParentSentinel] = [] }
          touchesRoot = true
        }
      }
    }

    for entry in entries {
      guard section.admits else { return abandon() }
      guard let id = entry["id"] as? String else { continue }
      var stmt: OpaquePointer?
      guard sqlite3_prepare_v2(db, upsertSql, -1, &stmt, nil) == SQLITE_OK else {
        sqlite3_finalize(stmt)
        return section.admits ? fail() : abandon()
      }
      defer { sqlite3_finalize(stmt) }

      sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, transient)
      if let parentId = entry["parent_id"] as? String {
        sqlite3_bind_text(stmt, 2, (parentId as NSString).utf8String, -1, transient)
        touchedParentIdentifiers.insert(parentId)
        childIdsByParent[parentId, default: []].insert(id)
      } else { sqlite3_bind_null(stmt, 2) }
      if entry["parent_id"] == nil || entry["parent_id"] is NSNull {
        touchesRoot = true
        childIdsByParent[rootParentSentinel, default: []].insert(id)
      }
      if let nameEnc = entry["name_encrypted"] as? String {
        sqlite3_bind_text(stmt, 3, (nameEnc as NSString).utf8String, -1, transient)
      } else { sqlite3_bind_null(stmt, 3) }
      if let nameDec = entry["name_decrypted"] as? String, !nameDec.isEmpty {
        sqlite3_bind_text(stmt, 4, (nameDec as NSString).utf8String, -1, transient)
      } else { sqlite3_bind_null(stmt, 4) }
      if let mime = entry["mime_type"] as? String {
        sqlite3_bind_text(stmt, 5, (mime as NSString).utf8String, -1, transient)
      } else { sqlite3_bind_null(stmt, 5) }
      sqlite3_bind_int64(stmt, 6, fileProviderCacheSizeBytes(entry["size_bytes"]))
      sqlite3_bind_int(stmt, 7, (entry["is_folder"] as? Bool ?? false) ? 1 : 0)
      if let createdAt = entry["created_at"] as? String {
        sqlite3_bind_text(stmt, 8, (createdAt as NSString).utf8String, -1, transient)
      } else { sqlite3_bind_null(stmt, 8) }
      if let updatedAt = entry["updated_at"] as? String {
        sqlite3_bind_text(stmt, 9, (updatedAt as NSString).utf8String, -1, transient)
      } else { sqlite3_bind_null(stmt, 9) }
      sqlite3_bind_int64(stmt, 10, now)

      let rc = sqlite3_step(stmt)
      if rc == SQLITE_DONE {
        count += 1
      } else if rc == SQLITE_INTERRUPT || !section.admits {
        return abandon()
      } else {
        // A step that fails with the gate open fails the transaction: skipping it would answer ok for
        // an entry that was never written, and the caller would count it as landed.
        return fail()
      }
    }

    // Prune stale rows. For each parent the caller supplied a COMPLETE child
    // set for, delete file_cache rows under that parent whose id is NOT in
    // the incoming set — mirroring CacheManager._deleteChildren(parent:
    // keepingIds:). This is what makes a remote trash/delete disappear from
    // Files.app without the user re-opening the folder. Guarded by
    // `shouldPrune` so partial single-folder pushes never delete siblings.
    if shouldPrune {
      for (parentKey, keepIds) in childIdsByParent {
        guard section.admits else { return abandon() }
        let isRoot = parentKey == rootParentSentinel
        var deleteSql: String
        if isRoot {
          deleteSql = "DELETE FROM file_cache WHERE parent_id IS NULL"
        } else {
          deleteSql = "DELETE FROM file_cache WHERE parent_id = ?"
        }
        if !keepIds.isEmpty {
          let placeholders = Array(repeating: "?", count: keepIds.count).joined(separator: ",")
          deleteSql += " AND id NOT IN (\(placeholders))"
        }

        var delStmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, deleteSql, -1, &delStmt, nil) == SQLITE_OK else {
          sqlite3_finalize(delStmt)
          return section.admits ? fail() : abandon()
        }
        defer { sqlite3_finalize(delStmt) }

        var index: Int32 = 1
        if !isRoot {
          sqlite3_bind_text(delStmt, index, (parentKey as NSString).utf8String, -1, transient)
          index += 1
        }
        // Sorted for deterministic binding order (matches CacheManager).
        for keepId in keepIds.sorted() {
          sqlite3_bind_text(delStmt, index, (keepId as NSString).utf8String, -1, transient)
          index += 1
        }
        let rc = sqlite3_step(delStmt)
        if rc == SQLITE_INTERRUPT || (rc != SQLITE_DONE && !section.admits) {
          return abandon()
        }
        if rc != SQLITE_DONE { return fail() }
      }
    }

    guard section.admits else { return abandon() }
    // A COMMIT that does not land (busy past the timeout, an interrupt) is not a
    // write: roll back and say so, instead of answering a count that was never
    // stored.
    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else { return abandon() }

    let didPrune = shouldPrune && (!touchedParentIdentifiers.isEmpty || touchesRoot)
    return .done(FileProviderCacheSyncResult(
      count: count,
      touchedParentIdentifiers: touchedParentIdentifiers,
      touchesRoot: touchesRoot,
      didPrune: didPrune
    ))
  }
}

/// A `size_bytes` the JS bridge hands over (Int, Int64, Double, NSNumber) as a
/// non-negative Int64; anything unsafe is 0.
func fileProviderCacheSizeBytes(_ raw: Any?) -> Int64 {
  func nonNegative(_ value: Int64) -> Int64 { value < 0 ? 0 : value }
  if let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
    return 0
  }

  switch raw {
  case is Bool:
    return 0
  case let value as Int:
    return nonNegative(Int64(value))
  case let value as Int64:
    return nonNegative(value)
  case let value as Double:
    return fileProviderCacheFloatingSizeBytes(value)
  case let value as Float:
    return fileProviderCacheFloatingSizeBytes(Double(value))
  case let value as NSNumber:
    return fileProviderCacheFloatingSizeBytes(value.doubleValue)
  default:
    return 0
  }
}

func fileProviderCacheFloatingSizeBytes(_ value: Double) -> Int64 {
  guard value.isFinite,
        value >= 0,
        value < Double(Int64.max),
        value.rounded(.towardZero) == value else { return 0 }
  return Int64(value)
}
