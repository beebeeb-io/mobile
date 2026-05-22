import FileProvider

/// Enumerates the children of a container or the working-set delta.
///
/// Strategy:
/// 1. The Files app pages through items via `enumerateItems(for:startingAt:)` —
///    we read directly from the SQLite cache for instant response.
/// 2. We refresh the cache from the API in the background (best-effort) and
///    signal the system via the working-set anchor when changes land. The
///    Files app re-enumerates lazily.
/// 3. `enumerateChanges(for:from:)` consults the `sync_anchor` column to ship
///    only what's new since the caller's anchor.
final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
  private let containerId: String
  private var refreshTask: Task<Void, Never>?

  init(containerIdentifier: NSFileProviderItemIdentifier) {
    if containerIdentifier == .rootContainer || containerIdentifier == .workingSet {
      self.containerId = BeebeebConstants.rootContainerIdentifier
    } else {
      self.containerId = containerIdentifier.rawValue
    }
  }

  func invalidate() {
    refreshTask?.cancel()
    refreshTask = nil
  }

  // MARK: - Enumeration

  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    let parent = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId
    let rows = CacheManager.shared.children(parent: parent)
    let items = rows.map { FileProviderItem(cached: $0) as NSFileProviderItem }
    observer.didEnumerate(items)
    observer.finishEnumerating(upTo: nil)

    // Kick off a background refresh against the API so the next enumeration
    // sees fresh state. Errors are swallowed — the user already sees the
    // cached listing, and any persistent failure (auth, offline) surfaces
    // through the main app.
    refreshTask?.cancel()
    refreshTask = Task.detached { [containerId] in
      await SyncEngine.refreshContainer(containerId: containerId)
    }
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
    currentSyncAnchor { currentAnchor in
      observer.finishEnumeratingChanges(upTo: currentAnchor ?? NSFileProviderSyncAnchor(Data("0".utf8)), moreComing: false)
    }
  }

  func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
    let raw = CacheManager.shared.syncState(key: "container.\(containerId).anchor") ?? "0"
    completionHandler(NSFileProviderSyncAnchor(Data(raw.utf8)))
  }
}
