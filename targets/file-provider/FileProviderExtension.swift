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
/// - Uploads stream through the v2 chunked-upload endpoints: encrypt one
///   chunk at a time, PUT it, finalize, then update the cache. Per-chunk
///   I/O keeps memory under the extension's 50 MB jetsam budget.
/// - Deletes hit the trash endpoint; modify supports rename + reparent.
///
/// All crypto is byte-oriented at the Swift boundary but flows through opaque
/// `MasterKeyHandle` / `FileKeyHandle` objects in Rust, so raw key material
/// never sits in the Swift heap.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
  /// Cached master key handle — loaded once per extension lifecycle to avoid
  /// repeated Secure Enclave access (which can trigger Face ID).
  private var cachedMasterKey: MasterKeyHandle?

  required init(domain: NSFileProviderDomain) {
    super.init()
    _ = domain
    _ = CacheManager.shared
  }

  /// Returns the cached master key, loading from Keychain only once per
  /// extension lifecycle. Subsequent calls reuse the in-memory handle.
  private func masterKey() throws -> MasterKeyHandle {
    if let key = cachedMasterKey { return key }
    let key = try CryptoBridge.loadMasterKeyHandle()
    cachedMasterKey = key
    return key
  }

  func invalidate() {
    cachedMasterKey = nil
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
        let masterKey = try self.masterKey()
        progress.completedUnitCount = 20

        let encrypted = try await ApiClient.shared.downloadEncrypted(fileId: cached.id)
        progress.completedUnitCount = 70

        let plaintext = try CryptoBridge.decryptDownloadedFile(
          masterKeyHandle: masterKey,
          fileId: cached.id,
          encryptedFile: encrypted,
          plaintextSize: cached.sizeBytes
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
        // Folder creation isn't supported by the v2 upload endpoint — the
        // Files app exposes folder creation through a separate path that
        // we'll implement once the /folder endpoint is wired in.
        if itemTemplate.contentType == .folder {
          completionHandler(nil, [], false, NSError(domain: NSFileProviderErrorDomain, code: NSFileProviderError.noSuchItem.rawValue))
          return
        }

        guard let url else {
          completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
          return
        }

        let masterKey = try self.masterKey()
        let fileId = UUID().uuidString
        let nameEncrypted = try CryptoBridge.encryptFilename(
          masterKeyHandle: masterKey,
          fileId: fileId,
          filename: itemTemplate.filename
        )
        progress.completedUnitCount = 10

        let parentRaw = itemTemplate.parentItemIdentifier.rawValue
        let parentId: String? = (parentRaw == NSFileProviderItemIdentifier.rootContainer.rawValue)
          ? nil
          : parentRaw
        let mimeType = itemTemplate.contentType?.preferredMIMEType

        let response = try await Self.streamUpload(
          sourceUrl: url,
          fileId: fileId,
          nameEncrypted: nameEncrypted,
          mimeType: mimeType,
          parentId: parentId,
          isMedia: Self.isMediaContent(itemTemplate.contentType),
          masterKey: masterKey,
          progress: progress,
          progressBase: 10,
          progressSpan: 80
        )
        progress.completedUnitCount = 90

        let cached = CachedItem(
          id: response.id,
          parentId: parentId,
          nameEncrypted: response.name_encrypted,
          nameDecrypted: itemTemplate.filename,
          mimeType: mimeType,
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

  // MARK: - Modify (rename / move / content update)

  func modifyItem(
    _ item: NSFileProviderItem,
    baseVersion version: NSFileProviderItemVersion,
    changedFields: NSFileProviderItemFields,
    contents newContents: URL?,
    options: NSFileProviderModifyItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    let progress = Progress(totalUnitCount: 100)

    guard var cached = CacheManager.shared.item(id: item.itemIdentifier.rawValue) else {
      completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
      return progress
    }

    // Note: contentPolicy (downloadEagerlyAndKeepDownloaded) is macOS-only.
    // On iOS, pinning is managed through our app's UI, not the Files app.

    let task = Task.detached {
      do {
        let masterKey = try self.masterKey()
        progress.completedUnitCount = 15

        var nextName = cached.nameDecrypted
        var nextNameEncrypted = cached.nameEncrypted
        var nextParentId = cached.parentId
        var nextSizeBytes = cached.sizeBytes
        var nextUpdatedAt = ISO8601DateFormatter().string(from: Date())

        if changedFields.contains(.filename) {
          nextName = item.filename
          nextNameEncrypted = try CryptoBridge.encryptFilename(
            masterKeyHandle: masterKey,
            fileId: cached.id,
            filename: item.filename
          )
        }
        if changedFields.contains(.parentItemIdentifier) {
          let parentRaw = item.parentItemIdentifier.rawValue
          nextParentId = (parentRaw == NSFileProviderItemIdentifier.rootContainer.rawValue)
            ? nil
            : parentRaw
        }
        progress.completedUnitCount = 30

        if changedFields.contains(.contents), let newContents {
          let mimeType = item.contentType?.preferredMIMEType ?? cached.mimeType
          // The v2 init endpoint requires an encrypted file name. If the
          // cached row lacks one (legacy plaintext-named files), encrypt
          // the current name on the fly using the existing file id.
          let nameForUpload: String
          if let existing = nextNameEncrypted {
            nameForUpload = existing
          } else {
            nameForUpload = try CryptoBridge.encryptFilename(
              masterKeyHandle: masterKey,
              fileId: cached.id,
              filename: item.filename
            )
            nextNameEncrypted = nameForUpload
          }
          let response = try await Self.streamUpload(
            sourceUrl: newContents,
            fileId: cached.id,
            nameEncrypted: nameForUpload,
            mimeType: mimeType,
            parentId: nextParentId,
            isMedia: Self.isMediaContent(item.contentType),
            masterKey: masterKey,
            progress: progress,
            progressBase: 30,
            progressSpan: 50
          )
          nextSizeBytes = response.size_bytes
          nextNameEncrypted = response.name_encrypted ?? nextNameEncrypted
          nextUpdatedAt = response.updated_at ?? response.created_at ?? nextUpdatedAt
          progress.completedUnitCount = 80
        }

        if changedFields.contains(.filename) || changedFields.contains(.parentItemIdentifier) {
          let patched = try await ApiClient.shared.patchFile(
            fileId: cached.id,
            nameEncrypted: nextNameEncrypted,
            parentId: nextParentId
          )
          nextNameEncrypted = patched.name_encrypted ?? nextNameEncrypted
          nextParentId = patched.parent_id
          nextUpdatedAt = patched.updated_at ?? nextUpdatedAt
        }

        let updated = CachedItem(
          id: cached.id,
          parentId: nextParentId,
          nameEncrypted: nextNameEncrypted,
          nameDecrypted: nextName,
          mimeType: item.contentType?.preferredMIMEType ?? cached.mimeType,
          sizeBytes: nextSizeBytes,
          isFolder: cached.isFolder,
          isPinned: cached.isPinned,
          hasThumbnail: cached.hasThumbnail,
          thumbnailData: cached.thumbnailData,
          thumbnailNonce: cached.thumbnailNonce,
          createdAt: cached.createdAt,
          updatedAt: nextUpdatedAt,
          syncAnchor: Int64(Date().timeIntervalSince1970 * 1000),
          isMaterialized: changedFields.contains(.contents) ? false : cached.isMaterialized
        )
        CacheManager.shared.upsert(updated)
        progress.completedUnitCount = 100
        completionHandler(FileProviderItem(cached: updated), [], false, nil)
      } catch {
        NSLog("[Beebeeb] modifyItem failed: \(error)")
        completionHandler(nil, [], false, Self.mapError(error))
      }
    }
    progress.cancellationHandler = { task.cancel() }
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

  // MARK: - Streaming upload

  /// Plaintext chunk size used for File Provider uploads. iOS gives File
  /// Provider extensions ~50 MB of resident memory; 1 MB plaintext keeps the
  /// per-chunk allocation (plaintext + AES-GCM ciphertext + URLSession copy)
  /// well under that even with autorelease drift.
  private static let uploadChunkSizeBytes = 1 * 1024 * 1024

  /// Streams a plaintext file to the v2 chunked-upload endpoints. Reads one
  /// chunk at a time via `FileHandle`, encrypts via `CryptoBridge`, and PUTs
  /// it to the server. No full-file `Data` buffer ever exists in the
  /// extension's heap — the only steady-state allocation is the per-chunk
  /// plaintext/ciphertext pair (~2 MB combined).
  ///
  /// `progressBase` + `progressSpan` are written into `progress` as upload
  /// advances; callers pick the slice so init/finalize remain visible in the
  /// Files app progress indicator.
  private static func streamUpload(
    sourceUrl: URL,
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    parentId: String?,
    isMedia: Bool,
    masterKey: MasterKeyHandle,
    progress: Progress,
    progressBase: Int64,
    progressSpan: Int64
  ) async throws -> ApiClient.UploadResponseDto {
    let attrs = try FileManager.default.attributesOfItem(atPath: sourceUrl.path)
    let fileSize = (attrs[.size] as? NSNumber)?.int64Value ?? 0
    guard fileSize > 0 else {
      throw NSFileProviderError(.noSuchItem)
    }

    let chunkSize = Self.uploadChunkSizeBytes
    let chunkCount = max(1, Int((fileSize + Int64(chunkSize) - 1) / Int64(chunkSize)))

    let session = try await ApiClient.shared.initUploadV2(
      fileId: fileId,
      nameEncrypted: nameEncrypted,
      fileSizeBytes: fileSize,
      mimeType: mimeType,
      parentId: parentId,
      isMedia: isMedia,
      chunkSizeBytes: chunkSize,
      chunkCount: chunkCount
    )

    let handle = try FileHandle(forReadingFrom: sourceUrl)
    defer { try? handle.close() }

    var bytesRead: Int64 = 0
    for index in 0..<chunkCount {
      try Task.checkCancellation()

      var plaintextLen = 0
      var encrypted = Data()
      try autoreleasepool { () throws -> Void in
        let plaintext = try handle.read(upToCount: chunkSize) ?? Data()
        plaintextLen = plaintext.count
        if plaintextLen == 0 { return }
        encrypted = try CryptoBridge.encryptChunkForUpload(
          masterKeyHandle: masterKey,
          fileId: fileId,
          plaintext: plaintext
        )
      }

      // File shrank under us between attributesOfItem and read — abort
      // rather than upload a short version that won't decrypt.
      guard plaintextLen > 0 else {
        throw NSFileProviderError(.serverUnreachable)
      }

      try await ApiClient.shared.uploadChunkV2(
        uploadSessionId: session.upload_session_id,
        index: index,
        encryptedChunk: encrypted
      )

      bytesRead += Int64(plaintextLen)
      let advance = progressSpan * bytesRead / fileSize
      progress.completedUnitCount = progressBase + min(progressSpan, advance)
    }

    try Task.checkCancellation()
    return try await ApiClient.shared.completeUploadV2(uploadSessionId: session.upload_session_id)
  }

  /// True when iOS would classify `type` as photo/video content. Used to set
  /// the v2 `is_media` flag so server-side photo grids include the upload.
  private static func isMediaContent(_ type: UTType?) -> Bool {
    guard let type else { return false }
    return type.conforms(to: .image) || type.conforms(to: .audiovisualContent)
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
      case .keyUnavailable, .decodeFailed: return NSFileProviderError(.cannotSynchronize)
      }
    }
    if (error as NSError).domain == NSFileProviderErrorDomain {
      return error
    }
    return NSFileProviderError(.cannotSynchronize)
  }
}
