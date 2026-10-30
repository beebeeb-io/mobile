import FileProvider
import Foundation
import UniformTypeIdentifiers

/// Result of refreshing a File Provider container. Initial empty-cache
/// enumeration uses this to distinguish a genuinely empty folder from a
/// provider that cannot authenticate or reach the server.
enum FileProviderRefreshOutcome {
  case success
  case notAuthenticated
  case serverUnreachable

  var fileProviderError: Error {
    switch self {
    case .success:
      return NSFileProviderError(.cannotSynchronize)
    case .notAuthenticated:
      return NSFileProviderError(.notAuthenticated)
    case .serverUnreachable:
      return NSFileProviderError(.serverUnreachable)
    }
  }
}

/// Synchronizes the local SQLite cache with the server.
///
/// Calls that already have cached rows can treat failures as best-effort.
/// Initial empty-cache enumeration must inspect the returned outcome so Files
/// does not cache an empty provider when auth or network refresh failed.
enum SyncEngine {
  /// Refresh the children of `containerId` from the API and signal the system
  /// when changes land.
  @discardableResult
  static func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    let parentId: String? = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId

    // Task 1593 round 7 (C1) — read BEFORE the network fetch below, which
    // can take an arbitrary amount of time. If a sign-out purge starts
    // while this call is in flight, the main app process bumps this SAME
    // cache database's `PRAGMA user_version` (round 8/R2 — see
    // `CacheManager.replaceChildren`'s doc comment for why this moved out
    // of App Group UserDefaults); the write at the bottom of this function
    // re-checks it under a real cross-process lock immediately before
    // committing and refuses to land if it has changed, so a fetch that
    // started against the outgoing account can't reinsert its decrypted
    // names after the purge's sweep.
    let epochAtStart = CacheManager.shared.currentPurgeEpoch()

    let entries: [ApiClient.FileEntryDto]
    do {
      entries = try await ApiClient.shared.listFiles(parentId: parentId)
    } catch {
      NSLog("[Beebeeb] refreshContainer(\(containerId)) failed: \(error)")
      return mapRefreshError(error)
    }

    // Prefer extension-local decryption so iOS Files can open any folder even
    // when the main app has not pre-warmed that directory's shared cache. This
    // uses the extension Secure Enclave key only, so it does not trigger Face ID
    // from the extension process.
    let masterKeyHandle: MasterKeyHandle?
    do {
      masterKeyHandle = try CryptoBridge.loadMasterKeyHandle()
    } catch {
      // Task 1722 (G3): `error` is a sanitised reason (a step and a status).
      masterKeyHandle = nil
      NSLog("[Beebeeb] refreshContainer(\(containerId)) key unavailable: \(error)")
    }
    let cached = CacheManager.shared.children(parent: parentId)
    let cachedById = Dictionary(uniqueKeysWithValues: cached.map { ($0.id, $0) })

    // Task 1722 (d): without the key, a listing with names only the key can
    // read is refused rather than written with placeholder names. Files then
    // shows "Authentication Required" with "Open Beebeeb" and retries once
    // the app resolves the error; nothing is cached for this folder until
    // then. Names the app already decrypted, and legacy plaintext names,
    // still refresh without the key.
    if masterKeyHandle == nil,
       entries.contains(where: { needsKeyForName($0, prior: cachedById[$0.id]) }) {
      NSLog("[Beebeeb] refreshContainer(\(containerId)) refused: names need the vault key")
      return .notAuthenticated
    }

    var rowsToUpsert: [CachedItem] = []

    for dto in entries {
      let prior = cachedById[dto.id]
      let effectiveParentId = dto.parent_id ?? parentId
      let decrypted = decryptName(
        dto: dto,
        masterKeyHandle: masterKeyHandle,
        fallback: prior?.nameDecrypted
      )

      let item = CachedItem(
        id: dto.id,
        parentId: effectiveParentId,
        nameEncrypted: dto.name_encrypted,
        nameDecrypted: decrypted.name,
        mimeType: dto.mime_type ?? decrypted.mimeType,
        sizeBytes: dto.size_bytes,
        isFolder: dto.is_folder,
        isPinned: prior?.isPinned ?? false,
        hasThumbnail: false,
        thumbnailData: prior?.thumbnailData,
        thumbnailNonce: prior?.thumbnailNonce,
        createdAt: dto.created_at,
        updatedAt: dto.updated_at,
        syncAnchor: bumpAnchor(prior?.syncAnchor),
        isMaterialized: prior?.isMaterialized ?? false,
        nameConvention: FileProviderCacheSchema.nameConvention(
          previous: prior?.nameConvention,
          previousNameEncrypted: prior?.nameEncrypted,
          newNameEncrypted: dto.name_encrypted ?? "",
          batch: decrypted.convention
        ),
        contentConvention: prior?.contentConvention,
        contentVersionId: prior?.contentVersionId
      )
      rowsToUpsert.append(item)
    }

    let committed = CacheManager.shared.replaceChildren(
      parent: parentId, with: rowsToUpsert, expectedEpoch: epochAtStart
    )
    guard committed else {
      // Task 1593 round 7 (C1) — a sign-out purge ran while this fetch was
      // in flight. Discard the response instead of writing decrypted names
      // for an account that is (or is about to be) signed out; the next
      // enumeration after a fresh sign-in re-fetches this container anyway.
      NSLog("[Beebeeb] refreshContainer(\(containerId)) discarded — purge epoch changed during fetch")
      return .serverUnreachable
    }
    CacheManager.shared.setSyncState(
      key: "container.\(containerId).anchor",
      value: String(Date().timeIntervalSince1970)
    )

    // Tell the system both the opened container and the working set changed.
    // Signaling only .workingSet leaves newly opened subfolders stuck on the
    // empty cached listing even after the API refresh has inserted children.
    let itemIdentifier: NSFileProviderItemIdentifier = (containerId == BeebeebConstants.rootContainerIdentifier)
      ? .rootContainer
      : NSFileProviderItemIdentifier(containerId)
    guard let manager = NSFileProviderManager(for: BeebeebConstants.fileProviderDomain) else {
      NSLog("[Beebeeb] signalEnumerator(\(containerId)) failed: File Provider manager unavailable")
      return .success
    }
    manager.signalEnumerator(for: itemIdentifier) { error in
      if let error { NSLog("[Beebeeb] signalEnumerator(\(containerId)) failed: \(error)") }
    }
    manager.signalEnumerator(for: .workingSet) { error in
      if let error { NSLog("[Beebeeb] signalEnumerator workingSet failed: \(error)") }
    }
    return .success
  }

  // MARK: - Materialized folders (task 1722 round 4, review round 2 minor 6)

  /// A materialized folder whose cached listing is older than this is refreshed when the working
  /// set is enumerated. Five minutes: often enough that a web-side change shows up on the next
  /// app foreground, rarely enough that a working set signal cannot loop the server.
  static let materializedRefreshInterval: TimeInterval = 300
  /// At most this many folders per pass (the most stale first), one at a time.
  static let materializedRefreshLimit = 8

  private static let materializedRefreshLock = NSLock()
  private static var materializedRefreshRunning = false
  /// A trigger that arrived while a pass was running: one more pass runs after it, so no
  /// working set signal is lost.
  private static var materializedRefreshRequested = false
  /// Per extension process: when each folder was last tried, so a folder that keeps failing
  /// (no key yet, offline) is not retried on every working set signal.
  private static var materializedRefreshAttempts: [String: TimeInterval] = [:]

  /// Refreshes materialized folders whose listing is stale, oldest first. Each refresh that
  /// lands writes the cache and signals the working set, so Files gets the change (the system
  /// never lists a materialized folder again). One pass at a time; returns the folders it
  /// refreshed.
  @discardableResult
  static func refreshMaterializedContainers(now: Date = Date()) async -> [String] {
    guard var attempts = beginMaterializedRefreshPass() else { return [] }
    var refreshed: [String] = []
    var roundStart = now
    while true {
      refreshed += await refreshDueMaterializedContainers(now: roundStart, attempts: attempts)
      guard let next = endMaterializedRefreshPassOrContinue() else { break }
      attempts = next
      roundStart = Date()
    }
    return refreshed
  }

  private static func refreshDueMaterializedContainers(now: Date, attempts: [String: TimeInterval]) async -> [String] {
    let nowSeconds = now.timeIntervalSince1970
    func lastSeen(_ id: String) -> TimeInterval {
      let listed = CacheManager.shared.syncState(key: "container.\(id).anchor").flatMap(Double.init) ?? 0
      return max(listed, attempts[id] ?? 0)
    }
    let due = CacheManager.shared.materializedContainerIds()
      .filter { $0 != BeebeebConstants.rootContainerIdentifier }
      .map { (id: $0, seen: lastSeen($0)) }
      .filter { nowSeconds - $0.seen >= materializedRefreshInterval }
      .sorted { $0.seen < $1.seen }
      .prefix(materializedRefreshLimit)

    var refreshed: [String] = []
    for folder in due {
      if Task.isCancelled { break }
      recordMaterializedRefreshAttempt(folder.id, at: nowSeconds)
      let outcome = await refreshContainer(containerId: folder.id)
      NSLog("[Beebeeb] Files materialized folder refresh \(folder.id): \(outcome)")
      refreshed.append(folder.id)
    }
    return refreshed
  }

  /// nil when a pass is already running (it then runs once more when done); otherwise the
  /// attempt times, and the pass is marked running.
  private static func beginMaterializedRefreshPass() -> [String: TimeInterval]? {
    materializedRefreshLock.lock()
    defer { materializedRefreshLock.unlock() }
    guard !materializedRefreshRunning else {
      materializedRefreshRequested = true
      return nil
    }
    materializedRefreshRunning = true
    return materializedRefreshAttempts
  }

  /// Ends the pass, or, when a trigger arrived meanwhile, keeps it running for one more round
  /// and returns the attempt times for it.
  private static func endMaterializedRefreshPassOrContinue() -> [String: TimeInterval]? {
    materializedRefreshLock.lock()
    defer { materializedRefreshLock.unlock() }
    if materializedRefreshRequested {
      materializedRefreshRequested = false
      return materializedRefreshAttempts
    }
    materializedRefreshRunning = false
    return nil
  }

  private static func recordMaterializedRefreshAttempt(_ id: String, at seconds: TimeInterval) {
    materializedRefreshLock.lock()
    materializedRefreshAttempts[id] = seconds
    materializedRefreshLock.unlock()
  }

  private static func mapRefreshError(_ error: Error) -> FileProviderRefreshOutcome {
    if let apiError = error as? ApiError {
      switch apiError {
      case .notAuthenticated, .accountMismatch:
        return .notAuthenticated
      case .invalidResponse, .statusCode:
        return .serverUnreachable
      }
    }
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain {
      return .serverUnreachable
    }
    if nsError.domain == NSFileProviderErrorDomain, nsError.code == NSFileProviderError.notAuthenticated.rawValue {
      return .notAuthenticated
    }
    return .serverUnreachable
  }

  /// True when this entry's name is an encrypted envelope and no decrypted
  /// name for it is cached yet, so only the vault key can produce a name.
  private static func needsKeyForName(_ dto: ApiClient.FileEntryDto, prior: CachedItem?) -> Bool {
    guard let raw = dto.name_encrypted, raw.hasPrefix("{") else { return false }
    return (prior?.nameDecrypted ?? "").isEmpty
  }

  private static func bumpAnchor(_ prior: Int64?) -> Int64 {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    return max(prior ?? 0, now)
  }

  private static func decryptName(
    dto: ApiClient.FileEntryDto,
    masterKeyHandle: MasterKeyHandle?,
    fallback: String?
  ) -> (name: String?, mimeType: String?, convention: String?) {
    guard let raw = dto.name_encrypted, !raw.isEmpty else {
      return (fallback, nil, nil)
    }
    if !raw.hasPrefix("{") {
      return (raw, nil, nil)
    }
    guard let masterKeyHandle else {
      return (fallback, nil, nil)
    }
    // SF-0002 M2a run 3: an owned row goes through the owner name resolver,
    // which also reports the exact id convention (upper_repair is read-only).
    do {
      let resolved = try CryptoBridge.resolveOwnerNameWithMime(
        masterKeyHandle: masterKeyHandle,
        fileId: dto.id,
        nameEncrypted: raw
      )
      return (resolved.name, resolved.mimeType, resolved.convention)
    } catch {
      // A foreign/shared row or a legacy envelope: fall back to the file key.
    }
    do {
      let decrypted = try CryptoBridge.decryptNameWithMime(
        masterKeyHandle: masterKeyHandle,
        fileId: dto.id,
        nameEncrypted: raw
      )
      return (decrypted.name, decrypted.mimeType, nil)
    } catch {
      NSLog("[Beebeeb] decrypt filename failed for item \(dto.id): \(error)")
      return (fallback, nil, nil)
    }
  }
}

/// Task 1722 round 4 (review round 2, minor 6): keeps the cache's list of materialized folders
/// (`CacheManager.materializedContainerIds`) equal to the system's own materialized set, as
/// Apple asks of a replicated extension: on materializedItemsDidChange, "call
/// -enumeratorForMaterializedItems ... Use the identifiers of items or changes you receive to
/// note the materialization status in your database" (NSFileProviderReplicatedExtension.h).
/// Also run once per extension process, so a phone upgraded from a build without it (TestFlight
/// 236 left folders materialized that no list here knows about) learns them on the first launch.
/// Work is scheduled, not done in the callback ("set a flag and perform any resulting work as a
/// timed task").
final class MaterializedSetTracker {
  static let shared = MaterializedSetTracker()

  private let lock = NSLock()
  private var scheduled = false

  func scheduleSync(after delay: TimeInterval = 1) {
    lock.lock()
    if scheduled {
      lock.unlock()
      return
    }
    scheduled = true
    lock.unlock()
    Task.detached(priority: .utility) {
      if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
      self.clearScheduled()
      await self.syncNow()
    }
  }

  private func clearScheduled() {
    lock.lock()
    scheduled = false
    lock.unlock()
  }

  /// Reads the system's materialized set and stores its folders. Signals the working set when
  /// the stored set changed (a newly materialized folder's children join it). Returns whether
  /// it changed; a failed enumeration, or a purge that ran meanwhile, changes nothing.
  @discardableResult
  func syncNow() async -> Bool {
    guard let manager = NSFileProviderManager(for: BeebeebConstants.fileProviderDomain) else { return false }
    let epoch = CacheManager.shared.currentPurgeEpoch()
    let enumerator = manager.enumeratorForMaterializedItems()
    let items = await MaterializedItemsCollector.collect(from: enumerator)
    enumerator.invalidate()
    guard let items else {
      NSLog("[Beebeeb] Files materialized set: enumeration failed, kept the stored set")
      return false
    }
    var folders = Set<String>()
    for item in items {
      let identifier = item.itemIdentifier
      if identifier == .rootContainer || identifier == .workingSet || identifier == .trashContainer { continue }
      let isFolder = (item.contentType?.conforms(to: .folder) ?? false)
        || (CacheManager.shared.item(id: identifier.rawValue)?.isFolder ?? false)
      if isFolder { folders.insert(identifier.rawValue) }
    }
    guard let changed = CacheManager.shared.replaceMaterializedContainers(folders, expectedEpoch: epoch) else { return false }
    NSLog("[Beebeeb] Files materialized set: %ld folder(s), changed=%d", folders.count, changed ? 1 : 0)
    if changed {
      manager.signalEnumerator(for: .workingSet) { error in
        if let error { NSLog("[Beebeeb] signalEnumerator workingSet failed: \(error)") }
      }
    }
    return changed
  }
}

/// Collects every item of an enumerator, page by page. nil when the enumeration fails or the
/// whole collection takes longer than `timeout`.
final class MaterializedItemsCollector: NSObject, NSFileProviderEnumerationObserver {
  private let lock = NSLock()
  private var items: [NSFileProviderItem] = []
  private var continuation: CheckedContinuation<NSFileProviderPage?, Error>?
  private var timedOut = false

  static func collect(from enumerator: NSFileProviderEnumerator, timeout: TimeInterval = 30) async -> [NSFileProviderItem]? {
    let collector = MaterializedItemsCollector()
    // One deadline for the whole collection: it fails the page in flight, if any, and every
    // page after it. A late timer after a finished collection finds nothing to resume.
    let deadline = Task.detached {
      try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
      collector.expire()
    }
    defer { deadline.cancel() }
    // Apple: "pass the result of [NSData new] as the starting page".
    var page = NSFileProviderPage(Data())
    for _ in 0..<1_000 {
      do {
        let next: NSFileProviderPage? = try await withCheckedThrowingContinuation { continuation in
          guard collector.begin(continuation) else { return }
          enumerator.enumerateItems(for: collector, startingAt: page)
        }
        guard let next else { return collector.collected }
        page = next
      } catch {
        return nil
      }
    }
    return collector.collected
  }

  private var collected: [NSFileProviderItem] {
    lock.lock()
    defer { lock.unlock() }
    return items
  }

  /// false (and the continuation already failed) once the deadline has passed.
  private func begin(_ continuation: CheckedContinuation<NSFileProviderPage?, Error>) -> Bool {
    lock.lock()
    if timedOut {
      lock.unlock()
      continuation.resume(throwing: CocoaError(.userCancelled))
      return false
    }
    self.continuation = continuation
    lock.unlock()
    return true
  }

  private func expire() {
    lock.lock()
    timedOut = true
    lock.unlock()
    finish(.failure(CocoaError(.userCancelled)))
  }

  /// Resumes the current page's continuation once; a late callback or the timeout after that is ignored.
  private func finish(_ result: Result<NSFileProviderPage?, Error>) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(with: result)
  }

  func didEnumerate(_ updatedItems: [NSFileProviderItem]) {
    lock.lock()
    items += updatedItems
    lock.unlock()
  }

  func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
    finish(.success(nextPage))
  }

  func finishEnumeratingWithError(_ error: Error) {
    finish(.failure(error))
  }
}
