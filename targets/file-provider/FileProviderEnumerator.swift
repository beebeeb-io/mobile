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

protocol FileProviderContainerRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome
  /// Task 1722 round 4: refreshes materialized folders whose cached listing is stale.
  func refreshMaterializedContainers() async
}

struct SyncEngineContainerRefresher: FileProviderContainerRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    await SyncEngine.refreshContainer(containerId: containerId)
  }
  func refreshMaterializedContainers() async {
    _ = await SyncEngine.refreshMaterializedContainers()
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

  func invalidate() {
    refreshTask?.cancel()
    refreshTask = nil
  }

  // MARK: - Enumeration

  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    let parent = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId
    let rows = cache.children(parent: parent)
    NSLog("[Beebeeb] Files enumerateItems cached=%ld", rows.count)
    let hasCachedListing = cache.syncState(key: "container.\(containerId).anchor") != nil
    if rows.isEmpty && hasCachedListing {
      let delivered = deliveredRows(ownRows: rows)
      recordDeliveredAnchor(rows: delivered)
      observer.didEnumerate(delivered.map { FileProviderItem(cached: $0) as NSFileProviderItem })
      observer.finishEnumerating(upTo: nil)
      noteListedFolder()

      refreshTask?.cancel()
      refreshTask = Task.detached { [containerId, refresher] in
        _ = await refresher.refreshContainer(containerId: containerId)
      }
      startMaterializedRefresh()
      return
    }

    if rows.isEmpty {
      refreshTask?.cancel()
      refreshTask = Task { [containerId, cache, refresher] in
        let outcome = await refresher.refreshContainer(containerId: containerId)
        guard !Task.isCancelled else { return }
        switch outcome {
        case .success:
          let refreshedRows = self.deliveredRows(ownRows: cache.children(parent: parent))
          guard !Task.isCancelled else { return }
          let refreshedItems = refreshedRows.map { FileProviderItem(cached: $0) as NSFileProviderItem }
          self.recordDeliveredAnchor(rows: refreshedRows)
          observer.didEnumerate(refreshedItems)
          observer.finishEnumerating(upTo: nil)
          self.noteListedFolder()
        case .notAuthenticated, .serverUnreachable:
          observer.finishEnumeratingWithError(outcome.fileProviderError)
        }
      }
      return
    }

    let delivered = deliveredRows(ownRows: rows)
    let items = delivered.map { FileProviderItem(cached: $0) as NSFileProviderItem }
    recordDeliveredAnchor(rows: delivered)
    observer.didEnumerate(items)
    observer.finishEnumerating(upTo: nil)
    noteListedFolder()

    // Kick off a background refresh against the API so the next enumeration
    // sees fresh state. Errors are swallowed — the user already sees the
    // cached listing, and any persistent failure (auth, offline) surfaces
    // through the main app.
    refreshTask?.cancel()
    refreshTask = Task.detached { [containerId, refresher] in
      _ = await refresher.refreshContainer(containerId: containerId)
    }
    startMaterializedRefresh()
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
    startMaterializedRefresh()
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

  /// What this enumerator vends: a folder's own children, or for the working set the root's
  /// children plus the children of every folder the system has materialized (task 1722 round 4).
  private func deliveredRows(ownRows: [CachedItem]) -> [CachedItem] {
    guard isWorkingSet else { return ownRows }
    var rows = ownRows
    var seen = Set(ownRows.map(\.id))
    for folder in cache.materializedContainerIds() where folder != BeebeebConstants.rootContainerIdentifier {
      for row in cache.children(parent: folder) where seen.insert(row.id).inserted {
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
    guard !isWorkingSet, containerId != BeebeebConstants.rootContainerIdentifier else { return }
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
    return snapshotAnchor(rows: deliveredRows(ownRows: cache.children(parent: parent)))
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
