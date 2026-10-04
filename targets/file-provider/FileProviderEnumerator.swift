import CryptoKit
import FileProvider
import Foundation

protocol FileProviderCacheReading {
  func children(parent: String?) -> [CachedItem]
  func syncState(key: String) -> String?
}

extension CacheManager: FileProviderCacheReading {}

protocol FileProviderContainerRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome
}

struct SyncEngineContainerRefresher: FileProviderContainerRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    await SyncEngine.refreshContainer(containerId: containerId)
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
final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
  private let containerId: String
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
      recordDeliveredAnchor(rows: rows)
      observer.didEnumerate([])
      observer.finishEnumerating(upTo: nil)

      refreshTask?.cancel()
      refreshTask = Task.detached { [containerId, refresher] in
        _ = await refresher.refreshContainer(containerId: containerId)
      }
      return
    }

    if rows.isEmpty {
      refreshTask?.cancel()
      refreshTask = Task { [containerId, cache, refresher] in
        let outcome = await refresher.refreshContainer(containerId: containerId)
        guard !Task.isCancelled else { return }
        switch outcome {
        case .success:
          let refreshedRows = cache.children(parent: parent)
          guard !Task.isCancelled else { return }
          let refreshedItems = refreshedRows.map { FileProviderItem(cached: $0) as NSFileProviderItem }
          self.recordDeliveredAnchor(rows: refreshedRows)
          observer.didEnumerate(refreshedItems)
          observer.finishEnumerating(upTo: nil)
        case .notAuthenticated, .serverUnreachable:
          observer.finishEnumeratingWithError(outcome.fileProviderError)
        }
      }
      return
    }

    let items = rows.map { FileProviderItem(cached: $0) as NSFileProviderItem }
    recordDeliveredAnchor(rows: rows)
    observer.didEnumerate(items)
    observer.finishEnumerating(upTo: nil)

    // Kick off a background refresh against the API so the next enumeration
    // sees fresh state. Errors are swallowed — the user already sees the
    // cached listing, and any persistent failure (auth, offline) surfaces
    // through the main app.
    refreshTask?.cancel()
    refreshTask = Task.detached { [containerId, refresher] in
      _ = await refresher.refreshContainer(containerId: containerId)
    }
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
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

  func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
    anchorLock.lock()
    let delivered = deliveredAnchor
    anchorLock.unlock()
    completionHandler(delivered ?? snapshotAnchor())
  }

  private func snapshotAnchor() -> NSFileProviderSyncAnchor {
    let parent = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId
    return snapshotAnchor(rows: cache.children(parent: parent))
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
    hash.update(data: Data("beebeeb.files.snapshot.v1".utf8))
    for item in items {
      let fields = [
        Data(item.itemIdentifier.rawValue.utf8),
        Data(item.parentItemIdentifier.rawValue.utf8),
        Data(item.filename.utf8),
        Data(item.contentType.identifier.utf8),
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
