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
  /// Task 1594 round 2 (F3): the owner record value that was current when
  /// `cachedMasterKey` was loaded — checked on every access so a handle
  /// cached under one account is dropped the moment the shared owner record
  /// changes (a sign-out, a leftover-key purge, or a different account
  /// signing in), rather than surviving for this extension process's entire
  /// lifetime, which is not bounded to one sign-in.
  private var cachedForOwner: String?
  /// Task 1594 round 3 (Codex T4): the signed-in user value that was current
  /// at the same moment. `mirrorSessionToAppGroup` (main app) clears+rewrites
  /// this the INSTANT the session token changes — ahead of the owner record,
  /// which only updates once the main app's ownership precheck/verify
  /// round-trip finishes. Comparing the owner alone left a window where a
  /// session already changed (A → B) but the (still-A) owner record hadn't
  /// been purged yet: this fast path matched on owner and returned A's
  /// cached handle for a request Files.app was now making on B's behalf.
  /// Keying the cache on BOTH values closes that window — either changing
  /// invalidates it and forces a fresh `ownershipVerified()` round-trip.
  private var cachedForSignedInUser: String?

  required init(domain: NSFileProviderDomain) {
    super.init()
    _ = domain
    _ = CacheManager.shared
  }

  /// Task 1594 round 4 (Codex P1, FileProviderExtension.swift:73): `masterKey()`
  /// carries the owner ALONGSIDE the handle, so every caller that goes on to
  /// make a mutating API request has it in hand to attach as
  /// `X-Beebeeb-Expected-User` — the point of caching a handle at all is to
  /// avoid re-deriving ownership per call, so the owner it was validated
  /// against must travel with it, not be re-read (and potentially
  /// out-of-date by then) at the call site.
  struct OwnedMasterKey {
    let handle: MasterKeyHandle
    let owner: String
  }

  /// Returns the cached master key + its proven owner, loading (and
  /// re-verifying ownership) only when nothing is cached yet or the owner
  /// record OR the signed-in user has changed since the cached handle was
  /// loaded.
  private func masterKey() throws -> OwnedMasterKey {
    let owner = CryptoBridge.currentKeyOwner()
    let signedInUser = CryptoBridge.currentSignedInUser()
    if let key = cachedMasterKey, let cachedOwner = cachedForOwner, CachedHandleIdentity.isStillValid(
      cachedOwner: cachedForOwner,
      cachedSignedInUser: cachedForSignedInUser,
      currentOwner: owner,
      currentSignedInUser: signedInUser
    ) {
      return OwnedMasterKey(handle: key, owner: cachedOwner)
    }
    cachedMasterKey = nil
    cachedForOwner = nil
    cachedForSignedInUser = nil
    // Re-verifies ownership internally (throws `.ownerUnverified` on
    // mismatch/missing) — never trust `owner`/`signedInUser` alone, either
    // could itself be nil.
    let key = try CryptoBridge.loadMasterKeyHandle()
    guard let owner, !owner.isEmpty else {
      // Unreachable in practice — `loadMasterKeyHandle()` only succeeds when
      // `ownershipVerified()` already required a non-nil, matching owner —
      // but a value this fix attaches to every server mutation is never
      // trusted on an internal invariant alone.
      throw CryptoBridge.CryptoBridgeError.ownerUnverified
    }
    cachedMasterKey = key
    cachedForOwner = owner
    cachedForSignedInUser = signedInUser
    return OwnedMasterKey(handle: key, owner: owner)
  }

  func invalidate() {
    cachedMasterKey = nil
    cachedForOwner = nil
    cachedForSignedInUser = nil
  }

  /// Task 1594 round 4: on a 409 `account_mismatch` (the server refusing this
  /// exact request because its `X-Beebeeb-Expected-User` didn't match the
  /// session), drop the cached handle immediately rather than waiting for the
  /// next owner/signed-in-user comparison in `masterKey()` — the mismatch was
  /// just independently confirmed server-side, so the next call re-verifies
  /// from scratch instead of risking one more request on what is now known to
  /// be a stale handle.
  private func invalidateCacheOnAccountMismatch(_ error: Error) {
    if case ApiError.accountMismatch = error {
      invalidate()
    }
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

    // Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoN, P1) — captured
    // synchronously, before `Task.detached` spawns, same capture-at-entry
    // discipline round 10 applied to createItem/modifyItem/deleteItem.
    // Removing the File Provider domain during a forced sign-out does NOT
    // cancel this already-running detached task — `progress
    // .cancellationHandler` only fires if the SYSTEM explicitly cancels this
    // `Progress`, which a sign-out purge never does — so an in-flight
    // download+decrypt could otherwise still land its plaintext writes into
    // `temp`/`pinned` well after `PlaintextStorageProtection.purgeAll()` has
    // already deleted those very directories for this sign-out.
    let epochAtStart = CacheManager.shared.currentPurgeEpoch()

    let task = Task.detached {
      do {
        let masterKey = try self.masterKey().handle
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

        // Task 1593 round 11 — re-check right after the (slow, unbounded)
        // network + decrypt span and BEFORE the first plaintext write. A
        // purge landing anywhere during that span must not let a decrypted
        // temp copy reach disk at all.
        guard CacheManager.shared.purgeEpochUnchanged(since: epochAtStart) else {
          NSLog("[Beebeeb] fetchContents(\(cached.id)) aborted: purge epoch changed before write")
          completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
          return
        }

        let destination = AppGroupContainer.temporaryContentDirectory
          .appendingPathComponent("\(cached.id)-\(UUID().uuidString)")
        try plaintext.write(to: destination, options: [.atomic])

        // Task 1593 round 11 — re-check again immediately after the write:
        // the write itself takes real (if usually short) wall time, and a
        // purge landing DURING it would otherwise leave this fresh temp copy
        // on disk even though the check just above passed. Delete the
        // partial output rather than hand it back to the system.
        guard CacheManager.shared.purgeEpochUnchanged(since: epochAtStart) else {
          try? FileManager.default.removeItem(at: destination)
          NSLog("[Beebeeb] fetchContents(\(cached.id)) aborted: purge epoch changed during write")
          completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
          return
        }

        if cached.isPinned {
          let pinned = AppGroupContainer.pinnedContentDirectory.appendingPathComponent(cached.id)
          // Replace any prior pinned copy atomically.
          try? FileManager.default.removeItem(at: pinned)
          try plaintext.write(to: pinned, options: [.atomic])

          // Task 1593 round 11 — this is a SECOND, later write of the same
          // plaintext bytes into a second, independently-purged directory;
          // the two checks above only cover the `temp` write, not this one.
          guard CacheManager.shared.purgeEpochUnchanged(since: epochAtStart) else {
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.removeItem(at: pinned)
            NSLog("[Beebeeb] fetchContents(\(cached.id)) aborted: purge epoch changed during pinned write")
            completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
            return
          }
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

    // Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhDqK) — captured
    // synchronously, before `Task.detached` spawns at all, for the same
    // uniform capture-at-entry discipline as `modifyItem`/`deleteItem`
    // below. This path creates a brand-new row rather than restoring a
    // previously-read one, so it is not the exact stale-metadata
    // restoration Codex's finding described, but judging every operation
    // against the epoch that was current at the moment the Files app
    // handed it to us — not whatever epoch happens to be current whenever
    // the scheduler gets around to running the detached task body — is the
    // same discipline applied uniformly, and closes the window between
    // task-spawn and the previous (later, in-task) capture point.
    let epochAtStart = CacheManager.shared.currentPurgeEpoch()

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

        let owned = try self.masterKey()
        let masterKey = owned.handle
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

        // Task 1593 round 8 (R3) — `epochAtStart` (captured synchronously
        // above, before this task ever spawned — round 10) gates the cache
        // write below against the unbounded-duration network upload that
        // follows: if a sign-out purge lands while this upload is in
        // flight, the epoch gate refuses to insert this file's decrypted
        // name for an account that has (or is about to have) signed out.

        let response = try await Self.streamUpload(
          sourceUrl: url,
          fileId: fileId,
          nameEncrypted: nameEncrypted,
          mimeType: mimeType,
          parentId: parentId,
          isMedia: Self.isMediaContent(itemTemplate.contentType),
          masterKey: masterKey,
          expectedUser: owned.owner,
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
        if !CacheManager.shared.upsert(cached, expectedEpoch: epochAtStart) {
          // Task 1593 round 8 (R3) — the upload itself already succeeded
          // server-side; only the LOCAL cache write is skipped when a
          // sign-out purge raced it. Still hand back the in-memory item —
          // it never touches the DB — so the Files app sees a consistent
          // result for the operation it actually asked for.
          NSLog("[Beebeeb] createItem cache write discarded — purge epoch changed during upload")
        }

        progress.completedUnitCount = 100
        completionHandler(FileProviderItem(cached: cached), [], false, nil)
      } catch {
        NSLog("[Beebeeb] createItem failed: \(error)")
        self.invalidateCacheOnAccountMismatch(error)
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

    // Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhDqK, P1) —
    // captured synchronously, in the same synchronous scope as (and
    // immediately before) the `cached` read below, before `Task.detached`
    // ever spawns. The previous capture point was INSIDE the detached
    // task — on the cooperative pool, at some later, unpredictable time —
    // so if a sign-out purge landed in the gap between reading `cached`
    // (with its still-current, pre-purge `nameDecrypted`) and the task
    // actually running, that later capture observed the FRESH, post-purge
    // epoch, matched it to itself, and the gated `upsert` below happily
    // "succeeded" at reinserting the stale `cached.nameDecrypted` after the
    // sweep had already run. Capturing here means an operation accepted
    // before the purge is judged against the epoch that was current when
    // ITS stale metadata was read, not against whatever epoch happens to
    // be current whenever the scheduler gets around to it.
    let epochAtStart = CacheManager.shared.currentPurgeEpoch()

    guard var cached = CacheManager.shared.item(id: item.itemIdentifier.rawValue) else {
      completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
      return progress
    }

    // Note: contentPolicy (downloadEagerlyAndKeepDownloaded) is macOS-only.
    // On iOS, pinning is managed through our app's UI, not the Files app.

    let task = Task.detached {
      do {
        // `epochAtStart` (see above) gates the cache write below against
        // both network calls that can follow (`streamUpload` for a content
        // change, `patchFile` for a rename/move), each of unbounded
        // duration. See `CacheManager.upsert(_:expectedEpoch:)`'s doc
        // comment.
        let owned = try self.masterKey()
        let masterKey = owned.handle
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
            expectedUser: owned.owner,
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
            parentId: nextParentId,
            expectedUser: owned.owner
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
        if !CacheManager.shared.upsert(updated, expectedEpoch: epochAtStart) {
          // Task 1593 round 8 (R3) — see the matching note in createItem
          // above: the server-side change already succeeded, only the
          // local cache write is skipped.
          NSLog("[Beebeeb] modifyItem cache write discarded — purge epoch changed during the operation")
        }
        progress.completedUnitCount = 100
        completionHandler(FileProviderItem(cached: updated), [], false, nil)
      } catch {
        NSLog("[Beebeeb] modifyItem failed: \(error)")
        self.invalidateCacheOnAccountMismatch(error)
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

    // Task 1593 round 10 — captured synchronously before `Task.detached`
    // spawns, for the same uniform capture-at-entry discipline as
    // createItem/modifyItem above. This path never reads a `cached` row
    // (only `identifier.rawValue`), and deleting an id the purge has
    // already removed is a harmless no-op either way, but keeping the
    // capture point identical across all three writers makes "every
    // extension write path captures its epoch before Task.detached" one
    // single, uniformly-testable invariant instead of an exception here.
    let epochAtStart = CacheManager.shared.currentPurgeEpoch()

    // Task 1594 round 4: delete performs no crypto (no key load needed), but
    // still carries whatever owner the shared keychain currently records —
    // the same value `masterKey()` would validate against — so the server
    // can catch a mid-flight account switch here too. `nil` (no owner
    // recorded yet) simply omits the header, unchanged pre-1594 behaviour.
    let expectedUser = CryptoBridge.currentKeyOwner()

    let task = Task.detached {
      do {
        // Task 1593 round 8 (R3) — `epochAtStart` (captured above) gates
        // the cache row removal below against the network delete that
        // follows. See `CacheManager.upsert(_:expectedEpoch:)`'s doc
        // comment for the full epoch-gate rationale.
        try await ApiClient.shared.deleteFile(fileId: identifier.rawValue, expectedUser: expectedUser)
        if !CacheManager.shared.delete(id: identifier.rawValue, expectedEpoch: epochAtStart) {
          // The remote delete already succeeded; only the local cache row
          // removal is skipped when a sign-out purge raced it — harmless,
          // the purge's own reset (or the next sign-in's fresh fetch)
          // clears this row anyway.
          NSLog("[Beebeeb] deleteItem cache removal discarded — purge epoch changed during the operation")
        }
        progress.completedUnitCount = 1
        completionHandler(nil)
      } catch {
        NSLog("[Beebeeb] deleteItem(\(identifier.rawValue)) failed: \(error)")
        self.invalidateCacheOnAccountMismatch(error)
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
    expectedUser: String?,
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
      chunkCount: chunkCount,
      expectedUser: expectedUser
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
        encryptedChunk: encrypted,
        expectedUser: expectedUser
      )

      bytesRead += Int64(plaintextLen)
      let advance = progressSpan * bytesRead / fileSize
      progress.completedUnitCount = progressBase + min(progressSpan, advance)
    }

    try Task.checkCancellation()
    return try await ApiClient.shared.completeUploadV2(uploadSessionId: session.upload_session_id, expectedUser: expectedUser)
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
      // Task 1594 round 4 (Codex P1, FileProviderExtension.swift:73): the
      // server rejected this exact request because its account didn't match
      // `X-Beebeeb-Expected-User` — the extension's cached key belongs to a
      // DIFFERENT account than the session actually authenticated as, the
      // same failure class `.ownerUnverified` guards locally. A clean,
      // non-retryable "not authenticated" — never a generic sync error that
      // would invite Files.app to silently retry with the same stale key.
      case .accountMismatch: return NSFileProviderError(.notAuthenticated)
      }
    }
    if let bridge = error as? CryptoBridge.CryptoBridgeError {
      switch bridge {
      case .keyUnavailable, .decodeFailed: return NSFileProviderError(.cannotSynchronize)
      // Task 1594 round 2 (F3): the key exists but is not (yet, or no
      // longer) provably this account's — surface the same error Files.app
      // shows for "not authenticated", since using it would be exactly the
      // wrong-key bug this task exists to close.
      case .ownerUnverified: return NSFileProviderError(.notAuthenticated)
      }
    }
    if (error as NSError).domain == NSFileProviderErrorDomain {
      return error
    }
    return NSFileProviderError(.cannotSynchronize)
  }
}
