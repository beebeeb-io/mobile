import FileProvider
import Foundation

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
