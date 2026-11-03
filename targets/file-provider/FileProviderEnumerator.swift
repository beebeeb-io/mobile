import CryptoKit
import FileProvider
import Foundation

protocol FileProviderCacheReading {
  func children(parent: String?) -> [CachedItem]
  func syncState(key: String) -> String?
  /// Task 1722 round 4: folders the system has materialized (listed); their children belong in
  /// the working set.
  func materializedContainerIds() -> [String]
  /// Task 1722 round 4: a folder the system just listed.
  @discardableResult
  func noteContainerMaterialized(_ containerId: String) -> Bool
}

extension CacheManager: FileProviderCacheReading {}

/// Looks a row up by id. Kept apart from `FileProviderCacheReading` so a test double of that
/// protocol stays valid; the working set uses it to skip folders that are no longer cached.
protocol FileProviderItemLookup {
  func item(id: String) -> CachedItem?
}

extension CacheManager: FileProviderItemLookup {}

protocol FileProviderContainerRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome
  /// Task 1722 round 4: refreshes materialized folders whose cached listing is stale.
  func refreshMaterializedContainers() async
}

private protocol FileProviderChangeRefreshing {
  func refreshContainerForChanges(containerId: String) async -> FileProviderRefreshOutcome
}

struct SyncEngineContainerRefresher: FileProviderContainerRefreshing, FileProviderChangeRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    await SyncEngine.refreshContainer(containerId: containerId)
  }
  func refreshMaterializedContainers() async {
    _ = await SyncEngine.refreshMaterializedContainers()
  }
  func refreshContainerForChanges(containerId: String) async -> FileProviderRefreshOutcome {
    await SyncEngine.refreshContainer(
      containerId: containerId,
      signalSystem: false,
      retryWhenSuperseded: true
    )
  }
}

/// Enumerates the children of a container or the working-set delta.
///
/// Strategy:
/// 1. The Files app pages through items via `enumerateItems(for:startingAt:)` —
///    we read directly from the SQLite cache for instant response.
/// 2. We refresh the cache from the API in the background (best-effort) and
///    signal the system via the working-set anchor when changes land. The
///    Files app re-enumerates lazily.
/// 3. Snapshot anchors cover both app and extension cache writers. Without a
///    deletion journal, a changed snapshot requests a full listing rebuild;
///    unchanged snapshots finish without restarting enumeration.
/// 4. Task 1722 round 4 (review round 2, minor 6): the WORKING SET is the root's
///    children plus the children of every folder the system has materialized.
///    In the replicated model iOS never lists a materialized folder again and
///    ignores signals for any container but the working set, so a change in a
///    folder Files already listed (a web-side rename, a TestFlight 236 placeholder
///    name the extension can now decrypt) reaches Files only through the working
///    set. Apple: "Once this has been called, the directory and its children
///    should be included in the working set" (NSFileProviderReplicatedExtension.h).
final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
  private let containerId: String
  private let isWorkingSet: Bool
  private let cache: FileProviderCacheReading
  private let refresher: FileProviderContainerRefreshing
  private var refreshTask: Task<Void, Never>?
  private let anchorLock = NSLock()
  private var deliveredAnchor: NSFileProviderSyncAnchor?

  convenience init(containerIdentifier: NSFileProviderItemIdentifier) {
    self.init(
      containerIdentifier: containerIdentifier,
      cache: CacheManager.shared,
      refresher: SyncEngineContainerRefresher()
    )
  }

  init(
    containerIdentifier: NSFileProviderItemIdentifier,
    cache: FileProviderCacheReading,
    refresher: FileProviderContainerRefreshing
  ) {
    if containerIdentifier == .rootContainer || containerIdentifier == .workingSet {
      self.containerId = BeebeebConstants.rootContainerIdentifier
    } else {
      self.containerId = containerIdentifier.rawValue
    }
    self.isWorkingSet = containerIdentifier == .workingSet
    self.cache = cache
    self.refresher = refresher
  }

  /// Only the first-load refresh (empty cache, observer still waiting) is cancelled here; a
  /// background refresh of an already delivered listing keeps running (see `startBackgroundRefresh`).
  func invalidate() {
    refreshTask?.cancel()
    refreshTask = nil
  }

  // MARK: - Enumeration

  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    let parent = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId
    let rows = visibleChildren(parent: parent)
    NSLog("[Beebeeb] Files enumerateItems cached=%ld", rows.count)
    let hasCachedListing = cache.syncState(key: "container.\(containerId).anchor") != nil
    if rows.isEmpty && hasCachedListing {
      let delivered = deliveredRows(ownRows: rows)
      recordDeliveredAnchor(rows: delivered)
      observer.didEnumerate(deliveredItems(delivered))
      observer.finishEnumerating(upTo: nil)
      noteListedFolder()

      startBackgroundRefresh()
      startMaterializedRefresh()
      return
    }

    if rows.isEmpty {
      refreshTask?.cancel()
      refreshTask = Task { [containerId, refresher] in
        let outcome = await refresher.refreshContainer(containerId: containerId)
        guard !Task.isCancelled else { return }
        switch outcome {
        case .success:
          let refreshedRows = self.deliveredRows(ownRows: self.visibleChildren(parent: parent))
          guard !Task.isCancelled else { return }
          let refreshedItems = self.deliveredItems(refreshedRows)
          self.recordDeliveredAnchor(rows: refreshedRows)
          observer.didEnumerate(refreshedItems)
          observer.finishEnumerating(upTo: nil)
          self.noteListedFolder()
        case .notAuthenticated:
          FileProviderAuthRequirement.record()
          if self.isWorkingSet {
            // The working set is not a place the user opens: an authentication error here is
            // what leaves the sync-problem badge on the whole location, with no folder to show
            // "Open Beebeeb" in. It delivers nothing and finishes; the recovery signals it and
            // the folders the user opens report the error themselves.
            observer.didEnumerate([])
            observer.finishEnumerating(upTo: nil)
          } else {
            observer.finishEnumeratingWithError(outcome.fileProviderError)
          }
        case .serverUnreachable:
          observer.finishEnumeratingWithError(outcome.fileProviderError)
        case .insufficientQuota, .noSuchItem, .cannotSynchronize:
          observer.finishEnumeratingWithError(outcome.fileProviderError)
        }
      }
      return
    }

    let delivered = deliveredRows(ownRows: rows)
    let items = deliveredItems(delivered)
    recordDeliveredAnchor(rows: delivered)
    observer.didEnumerate(items)
    observer.finishEnumerating(upTo: nil)
    noteListedFolder()

    // Kick off a background refresh against the API so the next enumeration
    // sees fresh state. Errors are swallowed — the user already sees the
    // cached listing, and any persistent failure (auth, offline) surfaces
    // through the main app.
    startBackgroundRefresh()
    startMaterializedRefresh()
  }

  // MARK: - Background refresh

  private static let refreshLock = NSLock()
  private struct RefreshEntry {
    var activeToken: UUID
    var activeTask: Task<FileProviderRefreshOutcome, Never>
    var queuedToken: UUID?
    var queuedTask: Task<FileProviderRefreshOutcome, Never>?
  }
  private static var refreshes: [String: RefreshEntry] = [:]

  /// Refreshes the container after its cached listing was delivered. iOS invalidates an
  /// enumerator right after `enumerateItems`, so this must not hang off `refreshTask`: that
  /// cancelled every refresh (NSURLError -999) and rows deleted elsewhere were never pruned.
  /// Coalesced per container across both item and change enumerations: one pass in flight, and
  /// a request that arrives meanwhile queues exactly one more pass. Keeping both entry points on
  /// this coordinator prevents their independently-started generations from discarding the pass
  /// whose observer is responsible for reporting the new snapshot.
  /// The sign-out and purge-epoch guards live in `SyncEngine.refreshContainer`.
  private func startBackgroundRefresh() {
    let id = containerId
    let shared = Self.coordinatedRefresh(containerId: id, refresher: refresher, forChanges: false)
    Task.detached {
      _ = await shared.1.value
      Self.finishRefresh(containerId: id, token: shared.0)
    }
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
    if containerId == BeebeebConstants.trashContainerIdentifier {
      let shared = Self.coordinatedRefresh(containerId: containerId, refresher: refresher, forChanges: true)
      Task.detached { [self] in
        let outcome = await shared.1.value
        Self.finishRefresh(containerId: containerId, token: shared.0)
        guard outcome == .success else {
          observer.finishEnumeratingWithError(outcome.fileProviderError)
          return
        }
        finishCachedChanges(for: observer, from: anchor)
      }
      return
    }
    startMaterializedRefresh()
    finishCachedChanges(for: observer, from: anchor)
  }

  private func finishCachedChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
    let current = snapshotAnchor()
    guard anchor == current else {
      // Both processes mutate this cache, and deletions are not journaled.
      // Never claim an empty delta for a stale snapshot: ask Files to rebuild
      // from enumerateItems so additions, removals and moves are all reflected.
      NSLog("[Beebeeb] Files enumerateChanges rebuilding changed cache snapshot")
      observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
      return
    }
    observer.finishEnumeratingChanges(upTo: current, moreComing: false)
  }

  /// App signals can arrive in a burst. There is one active listing and at most one queued
  /// listing; calls covered by the queued pass share it. A request arriving while a listing is
  /// active is therefore covered by a pass that starts later, so a permanent-delete signal can
  /// never be answered only from a response captured before deletion.
  private static func coordinatedRefresh(
    containerId: String,
    refresher: FileProviderContainerRefreshing,
    forChanges: Bool
  ) -> (UUID, Task<FileProviderRefreshOutcome, Never>) {
    refreshLock.lock()
    if var existing = refreshes[containerId] {
      if let token = existing.queuedToken, let task = existing.queuedTask {
        refreshLock.unlock()
        return (token, task)
      }

      let token = UUID()
      let preceding = existing.activeTask
      // The gate makes the queue entry visible before its task can promote itself.
      let installed = DispatchSemaphore(value: 0)
      let task = Task.detached {
        _ = await preceding.value
        installed.wait()
        Self.promoteQueuedRefresh(containerId: containerId, token: token)
        return await Self.performRefresh(containerId: containerId, refresher: refresher, forChanges: forChanges)
      }
      existing.queuedToken = token
      existing.queuedTask = task
      refreshes[containerId] = existing
      installed.signal()
      refreshLock.unlock()
      return (token, task)
    }

    let token = UUID()
    let task = Task.detached {
      await Self.performRefresh(containerId: containerId, refresher: refresher, forChanges: forChanges)
    }
    refreshes[containerId] = RefreshEntry(
      activeToken: token,
      activeTask: task,
      queuedToken: nil,
      queuedTask: nil
    )
    refreshLock.unlock()
    return (token, task)
  }

  private static func performRefresh(
    containerId: String,
    refresher: FileProviderContainerRefreshing,
    forChanges: Bool
  ) async -> FileProviderRefreshOutcome {
    if forChanges, let changeRefresher = refresher as? FileProviderChangeRefreshing {
      return await changeRefresher.refreshContainerForChanges(containerId: containerId)
    }
    return await refresher.refreshContainer(containerId: containerId)
  }

  private static func promoteQueuedRefresh(containerId: String, token: UUID) {
    refreshLock.lock()
    defer { refreshLock.unlock() }
    guard var entry = refreshes[containerId],
          entry.queuedToken == token,
          let task = entry.queuedTask else { return }
    entry.activeToken = token
    entry.activeTask = task
    entry.queuedToken = nil
    entry.queuedTask = nil
    refreshes[containerId] = entry
  }

  private static func finishRefresh(containerId: String, token: UUID) {
    refreshLock.lock()
    if let entry = refreshes[containerId],
       entry.activeToken == token,
       entry.queuedToken == nil {
      refreshes[containerId] = nil
    }
    refreshLock.unlock()
  }

  /// The items for `rows` (the Trash folder is added to the root and working set).
  private func deliveredItems(_ rows: [CachedItem]) -> [NSFileProviderItem] {
    rows.map { FileProviderItem(cached: $0) as NSFileProviderItem }
  }

  /// A folder's cached children without the internal backup manifest (`isHiddenBackupManifest`).
  private func visibleChildren(parent: String?) -> [CachedItem] {
    cache.children(parent: parent).filter { !$0.isHiddenBackupManifest }
  }

  /// What this enumerator vends: a folder's own children, or for the working set the root's
  /// children plus the children of every folder the system has materialized (task 1722 round 4).
  private func deliveredRows(ownRows: [CachedItem]) -> [CachedItem] {
    // The internal backup manifest is never listed: the shared hide rule for it applies to the
    // rows assembled here.
    var rows = ownRows
    // The read-only Trash folder itself (never its contents) is part of the location's top level
    // and the working set. Existing installs may never enumerate the root again, so a working-set
    // rebuild must continue to publish the synthetic folder.
    if containerId == BeebeebConstants.rootContainerIdentifier { rows.append(.trashContainer()) }
    guard isWorkingSet else { return rows }
    var seen = Set(rows.map(\.id))
    let lookup = cache as? FileProviderItemLookup
    for folder in cache.materializedContainerIds() where folder != BeebeebConstants.rootContainerIdentifier {
      // Trash contents stay in their own read-only place, never in the working set.
      if FilesTrash.isTrashNamespace(folder) { continue }
      // A folder that has left the cache (trashed or deleted elsewhere) takes its children with
      // it: pruning a listing removes the folder's row, not the rows below it.
      if let lookup, lookup.item(id: folder) == nil { continue }
      for row in visibleChildren(parent: folder) where seen.insert(row.id).inserted {
        rows.append(row)
      }
    }
    return rows
  }

  /// Task 1722 round 4: materialized folders are never listed again, so the working set is where
  /// their stale listings get refreshed (rate limited in SyncEngine); a refresh that lands writes
  /// the cache and signals the working set. Its own task, not `refreshTask`: `invalidate()` must
  /// not cancel a pass half way.
  private func startMaterializedRefresh() {
    guard isWorkingSet else { return }
    Task.detached { [refresher] in await refresher.refreshMaterializedContainers() }
  }

  /// Task 1722 round 4: a folder the system has just listed is materialized from now on, so its
  /// children join the working set even before materializedItemsDidChange reports it.
  private func noteListedFolder() {
    guard !isWorkingSet, containerId != BeebeebConstants.rootContainerIdentifier,
          !FilesTrash.isTrashNamespace(containerId) else { return }
    cache.noteContainerMaterialized(containerId)
  }

  func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
    anchorLock.lock()
    let delivered = deliveredAnchor
    anchorLock.unlock()
    completionHandler(delivered ?? snapshotAnchor())
  }

  private func snapshotAnchor() -> NSFileProviderSyncAnchor {
    let parent = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId
    return snapshotAnchor(rows: deliveredRows(ownRows: visibleChildren(parent: parent)))
  }

  private func recordDeliveredAnchor(rows: [CachedItem]) {
    let anchor = snapshotAnchor(rows: rows)
    anchorLock.lock()
    deliveredAnchor = anchor
    anchorLock.unlock()
  }

  private func snapshotAnchor(rows: [CachedItem]) -> NSFileProviderSyncAnchor {
    let items = rows.map(FileProviderItem.init(cached:))
      .sorted { $0.itemIdentifier.rawValue < $1.itemIdentifier.rawValue }
    var hash = SHA256()
    // Task 1722 review M4: v2 leaves out the content type. The two cache
    // writers disagree on mime_type (the app writes the server's, often null;
    // the extension the decrypted one), so the same item flipped between
    // public.data, public.plain-text and net.daringfireball.markdown, and
    // every flip forced "a very expensive scan of all the items known by the
    // system" (NSFileProviderReplicatedExtension.h). The item versions do not
    // include the MIME type either.
    hash.update(data: Data("beebeeb.files.snapshot.v2".utf8))
    for item in items {
      let fields = [
        Data(item.itemIdentifier.rawValue.utf8),
        Data(item.parentItemIdentifier.rawValue.utf8),
        Data(item.filename.utf8),
        item.itemVersion.contentVersion,
        item.itemVersion.metadataVersion,
      ]
      for field in fields {
        var size = UInt64(field.count).bigEndian
        withUnsafeBytes(of: &size) { hash.update(data: Data($0)) }
        hash.update(data: field)
      }
    }
    // Only the digest is returned to the system; names/version payloads stay
    // inside the already protected metadata cache and this extension process.
    return NSFileProviderSyncAnchor(Data(hash.finalize()))
  }

}
