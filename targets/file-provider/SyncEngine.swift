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

    // Prefer extension-local decryption so iOS Files can open any folder even
    // when the main app has not pre-warmed that directory's shared cache. This
    // uses the extension Secure Enclave key only, so it does not trigger Face ID
    // from the extension process.
    let masterKeyHandle = try? CryptoBridge.loadMasterKeyHandle()
    let cached = CacheManager.shared.children(parent: parentId)
    let cachedById = Dictionary(uniqueKeysWithValues: cached.map { ($0.id, $0) })

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
        isMaterialized: prior?.isMaterialized ?? false
      )
      rowsToUpsert.append(item)
    }

    CacheManager.shared.replaceChildren(parent: parentId, with: rowsToUpsert)
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
    NSFileProviderManager.default.signalEnumerator(for: itemIdentifier) { error in
      if let error { NSLog("[Beebeeb] signalEnumerator(\(containerId)) failed: \(error)") }
    }
    NSFileProviderManager.default.signalEnumerator(for: .workingSet) { error in
      if let error { NSLog("[Beebeeb] signalEnumerator workingSet failed: \(error)") }
    }
  }

  private static func bumpAnchor(_ prior: Int64?) -> Int64 {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    return max(prior ?? 0, now)
  }

  private static func decryptName(
    dto: ApiClient.FileEntryDto,
    masterKeyHandle: MasterKeyHandle?,
    fallback: String?
  ) -> (name: String?, mimeType: String?) {
    guard let raw = dto.name_encrypted, !raw.isEmpty else {
      return (fallback, nil)
    }
    if !raw.hasPrefix("{") {
      return (raw, nil)
    }
    guard let masterKeyHandle else {
      return (fallback, nil)
    }
    do {
      let decrypted = try CryptoBridge.decryptNameWithMime(
        masterKeyHandle: masterKeyHandle,
        fileId: dto.id,
        nameEncrypted: raw
      )
      return (decrypted.name, decrypted.mimeType)
    } catch {
      NSLog("[Beebeeb] decrypt filename failed for item \(dto.id): \(error)")
      return (fallback, nil)
    }
  }
}
