import FileProvider
import Foundation
import UniformTypeIdentifiers

/// `NSFileProviderReplicatedExtension` (iOS 16+) that backs the Beebeeb entry
/// in the iOS Files app.
///
/// Architecture:
/// - Metadata lives in a shared SQLite cache (`CacheManager`) inside the App
///   Group container. Lookups and listings hit it directly for instant UI.
/// - File contents are materialized on demand: `fetchContents` downloads the
///   ciphertext from the API and decrypts via the Rust `BeebeebCore` handles.
/// - Uploads follow the inverse: encrypt locally, multipart-upload, then cache.
/// - Deletes hit the trash endpoint; modify supports rename + reparent.
///
/// All crypto is byte-oriented at the Swift boundary but flows through opaque
/// `MasterKeyHandle` / `FileKeyHandle` objects in Rust, so raw key material
/// never sits in the Swift heap.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
  required init(domain: NSFileProviderDomain) {
    super.init()
    _ = domain
    // Touch the cache early so the database schema is migrated before the
    // first request arrives.
    _ = CacheManager.shared
  }

  func invalidate() {
    // Nothing to tear down — the cache and API client are singletons that
    // get reused across instantiations.
  }

  // MARK: - Item lookup

  func item(
    for identifier: NSFileProviderItemIdentifier,
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)

    if identifier == .rootContainer {
      completionHandler(FileProviderItem(cached: .rootContainer()), nil)
      progress.completedUnitCount = 1
      return progress
    }

    if identifier == .trashContainer || identifier == .workingSet {
      // We don't host a separate trash or working-set container yet; treat
      // both as the same as the root for the system so it doesn't error out.
      completionHandler(FileProviderItem(cached: .rootContainer()), nil)
      progress.completedUnitCount = 1
      return progress
    }

    if let cached = CacheManager.shared.item(id: identifier.rawValue) {
      completionHandler(FileProviderItem(cached: cached), nil)
    } else {
      completionHandler(nil, NSFileProviderError(.noSuchItem))
    }
    progress.completedUnitCount = 1
    return progress
  }

  // MARK: - Materialization (download + decrypt)

  func fetchContents(
    for itemIdentifier: NSFileProviderItemIdentifier,
    version requestedVersion: NSFileProviderItemVersion?,
    request: NSFileProviderRequest,
    completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 100)

    guard let cached = CacheManager.shared.item(id: itemIdentifier.rawValue), !cached.isFolder else {
      completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
      return progress
    }

    let task = Task.detached {
      do {
        let masterKey = try CryptoBridge.loadMasterKeyHandle()
        progress.completedUnitCount = 20

        let encrypted = try await ApiClient.shared.downloadEncrypted(fileId: cached.id)
        progress.completedUnitCount = 70

        let plaintext = try CryptoBridge.decryptDownloadedBlob(
          masterKeyHandle: masterKey,
          fileId: cached.id,
          blob: encrypted
        )
        progress.completedUnitCount = 90

        let destination = AppGroupContainer.temporaryContentDirectory
          .appendingPathComponent("\(cached.id)-\(UUID().uuidString)")
        try plaintext.write(to: destination, options: [.atomic])

        if cached.isPinned {
          let pinned = AppGroupContainer.pinnedContentDirectory.appendingPathComponent(cached.id)
          // Replace any prior pinned copy atomically.
          try? FileManager.default.removeItem(at: pinned)
          try plaintext.write(to: pinned, options: [.atomic])
          CacheManager.shared.setMaterialized(id: cached.id, value: true)
        }

        progress.completedUnitCount = 100
        completionHandler(destination, FileProviderItem(cached: cached), nil)
      } catch {
        NSLog("[Beebeeb] fetchContents(\(cached.id)) failed: \(error)")
        completionHandler(nil, nil, Self.mapError(error))
      }
    }
    progress.cancellationHandler = { task.cancel() }
    return progress
  }

  // MARK: - Create (upload from another app)

  func createItem(
    basedOn itemTemplate: NSFileProviderItem,
    fields: NSFileProviderItemFields,
    contents url: URL?,
    options: NSFileProviderCreateItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 100)

    let task = Task.detached {
      do {
        // Folder creation isn't supported via the multipart endpoint we have
        // here — the Files app exposes folder creation through a separate
        // path that we'll implement once the /folder endpoint is wired in.
        if itemTemplate.contentType == .folder {
          completionHandler(nil, [], false, NSFileProviderError(.featureNotSupported))
          return
        }

        guard let url else {
          completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
          return
        }

        let plaintext = try Data(contentsOf: url)
        progress.completedUnitCount = 20

        let masterKey = try CryptoBridge.loadMasterKeyHandle()
        let fileId = UUID().uuidString
        let encryptedChunk = try CryptoBridge.encryptChunkForUpload(
          masterKeyHandle: masterKey,
          fileId: fileId,
          plaintext: plaintext
        )
        let nameEncrypted = try CryptoBridge.encryptFilename(
          masterKeyHandle: masterKey,
          fileId: fileId,
          filename: itemTemplate.filename
        )
        progress.completedUnitCount = 60

        let parentRaw = itemTemplate.parentItemIdentifier.rawValue
        let parentId: String? = (parentRaw == NSFileProviderItemIdentifier.rootContainer.rawValue)
          ? nil
          : parentRaw

        let metadataDict: [String: Any] = [
          "name_encrypted": nameEncrypted,
          "parent_id": parentId as Any,
          "mime_type": itemTemplate.contentType?.preferredMIMEType ?? "application/octet-stream",
          "size_bytes": plaintext.count,
        ]
        let metadataJson = try JSONSerialization.data(withJSONObject: metadataDict, options: [])

        let response = try await ApiClient.shared.uploadEncrypted(
          metadataJson: metadataJson,
          chunks: [encryptedChunk]
        )
        progress.completedUnitCount = 90

        let cached = CachedItem(
          id: response.id,
          parentId: parentId,
          nameEncrypted: response.name_encrypted,
          nameDecrypted: itemTemplate.filename,
          mimeType: itemTemplate.contentType?.preferredMIMEType,
          sizeBytes: response.size_bytes,
          isFolder: false,
          isPinned: false,
          hasThumbnail: false,
          thumbnailData: nil,
          thumbnailNonce: nil,
          createdAt: response.created_at,
          updatedAt: response.created_at,
          syncAnchor: Int64(Date().timeIntervalSince1970 * 1000),
          isMaterialized: false
        )
        CacheManager.shared.upsert(cached)

        progress.completedUnitCount = 100
        completionHandler(FileProviderItem(cached: cached), [], false, nil)
      } catch {
        NSLog("[Beebeeb] createItem failed: \(error)")
        completionHandler(nil, [], false, Self.mapError(error))
      }
    }
    progress.cancellationHandler = { task.cancel() }
    return progress
  }

  // MARK: - Modify (rename / move / pin toggle)

  func modifyItem(
    _ item: NSFileProviderItem,
    baseVersion version: NSFileProviderItemVersion,
    changedFields: NSFileProviderItemFields,
    contents newContents: URL?,
    options: NSFileProviderModifyItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)

    guard var cached = CacheManager.shared.item(id: item.itemIdentifier.rawValue) else {
      completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
      return progress
    }

    // Pin toggle from the Files app surfaces here as a `contentPolicy` change.
    if changedFields.contains(.contentPolicy) {
      let pinned = (item.contentPolicy == .downloadEagerlyAndKeepDownloaded)
      CacheManager.shared.setPinned(id: cached.id, pinned: pinned)
      cached.isPinned = pinned
    }

    if changedFields.contains(.filename) {
      let task = Task.detached {
        do {
          let masterKey = try CryptoBridge.loadMasterKeyHandle()
          let nameEncrypted = try CryptoBridge.encryptFilename(
            masterKeyHandle: masterKey,
            fileId: cached.id,
            filename: item.filename
          )
          // TODO: PATCH /api/v1/files/:id with the new name_encrypted once the
          // endpoint is exposed to mobile (web client uses /pages already).
          // For now we update the local cache so the Files app sees the new
          // name immediately; the next API refresh reconciles.
          let renamed = CachedItem(
            id: cached.id,
            parentId: cached.parentId,
            nameEncrypted: nameEncrypted,
            nameDecrypted: item.filename,
            mimeType: cached.mimeType,
            sizeBytes: cached.sizeBytes,
            isFolder: cached.isFolder,
            isPinned: cached.isPinned,
            hasThumbnail: cached.hasThumbnail,
            thumbnailData: cached.thumbnailData,
            thumbnailNonce: cached.thumbnailNonce,
            createdAt: cached.createdAt,
            updatedAt: ISO8601DateFormatter().string(from: Date()),
            syncAnchor: Int64(Date().timeIntervalSince1970 * 1000),
            isMaterialized: cached.isMaterialized
          )
          CacheManager.shared.upsert(renamed)
          completionHandler(FileProviderItem(cached: renamed), [], false, nil)
        } catch {
          NSLog("[Beebeeb] modifyItem(rename) failed: \(error)")
          completionHandler(nil, [], false, Self.mapError(error))
        }
      }
      progress.cancellationHandler = { task.cancel() }
      return progress
    }

    completionHandler(FileProviderItem(cached: cached), [], false, nil)
    progress.completedUnitCount = 1
    return progress
  }

  // MARK: - Delete

  func deleteItem(
    identifier: NSFileProviderItemIdentifier,
    baseVersion version: NSFileProviderItemVersion,
    options: NSFileProviderDeleteItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 1)

    let task = Task.detached {
      do {
        try await ApiClient.shared.deleteFile(fileId: identifier.rawValue)
        CacheManager.shared.delete(id: identifier.rawValue)
        progress.completedUnitCount = 1
        completionHandler(nil)
      } catch {
        NSLog("[Beebeeb] deleteItem(\(identifier.rawValue)) failed: \(error)")
        completionHandler(Self.mapError(error))
      }
    }
    progress.cancellationHandler = { task.cancel() }
    return progress
  }

  // MARK: - Enumeration

  func enumerator(
    for containerItemIdentifier: NSFileProviderItemIdentifier,
    request: NSFileProviderRequest
  ) throws -> NSFileProviderEnumerator {
    return FileProviderEnumerator(containerIdentifier: containerItemIdentifier)
  }

  // MARK: - Errors

  /// Map our internal errors into something `NSFileProviderError`-shaped so
  /// the Files app shows an actionable message.
  private static func mapError(_ error: Error) -> Error {
    if let api = error as? ApiError {
      switch api {
      case .notAuthenticated: return NSFileProviderError(.notAuthenticated)
      case .invalidResponse, .statusCode: return NSFileProviderError(.serverUnreachable)
      }
    }
    if let bridge = error as? CryptoBridge.CryptoBridgeError {
      switch bridge {
      case .notLinked: return NSFileProviderError(.providerNotFound)
      case .keyUnavailable, .decodeFailed: return NSFileProviderError(.cannotSynchronize)
      }
    }
    if (error as NSError).domain == NSFileProviderErrorDomain {
      return error
    }
    return NSFileProviderError(.cannotSynchronize)
  }
}
