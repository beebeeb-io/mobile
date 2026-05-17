import FileProvider
import Foundation

/// Synchronizes the local SQLite cache with the server.
///
/// All methods are best-effort — failures are logged via NSLog and the system
/// keeps showing whatever the cache already had. The Files app re-tries
/// enumeration on its own cadence.
enum SyncEngine {
  /// Refresh the children of `containerId` from the API and signal the system
  /// when changes land.
  static func refreshContainer(containerId: String) async {
    let parentId: String? = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId

    let entries: [ApiClient.FileEntryDto]
    do {
      entries = try await ApiClient.shared.listFiles(parentId: parentId)
    } catch {
      NSLog("[Beebeeb] refreshContainer(\(containerId)) failed: \(error)")
      return
    }

    // The main app pre-populates decrypted names via syncFileProviderCache().
    // We never load the master key here — that would trigger Face ID from
    // the extension process. If a name isn't decrypted yet, show the fallback
    // until the main app syncs it.
    let cached = CacheManager.shared.children(parent: parentId)
    let cachedById = Dictionary(uniqueKeysWithValues: cached.map { ($0.id, $0) })

    var rowsToUpsert: [CachedItem] = []

    for dto in entries {
      let prior = cachedById[dto.id]
      let nameDecrypted = prior?.nameDecrypted

      let item = CachedItem(
        id: dto.id,
        parentId: dto.parent_id,
        nameEncrypted: dto.name_encrypted,
        nameDecrypted: nameDecrypted,
        mimeType: dto.mime_type,
        sizeBytes: dto.size_bytes,
        isFolder: dto.is_folder,
        isPinned: prior?.isPinned ?? false,
        hasThumbnail: false,
        thumbnailData: prior?.thumbnailData,
        thumbnailNonce: prior?.thumbnailNonce,
        createdAt: dto.created_at,
        updatedAt: dto.updated_at,
        syncAnchor: bumpAnchor(prior?.syncAnchor),
        isMaterialized: prior?.isMaterialized ?? false
      )
      rowsToUpsert.append(item)
    }

    CacheManager.shared.upsert(rowsToUpsert)
    CacheManager.shared.setSyncState(
      key: "container.\(containerId).anchor",
      value: String(Date().timeIntervalSince1970)
    )

    // Tell the system the working set changed so it re-renders the Files UI.
    NSFileProviderManager.default.signalEnumerator(for: .workingSet) { error in
      if let error { NSLog("[Beebeeb] signalEnumerator workingSet failed: \(error)") }
    }
  }

  private static func bumpAnchor(_ prior: Int64?) -> Int64 {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    return max(prior ?? 0, now)
  }
}
