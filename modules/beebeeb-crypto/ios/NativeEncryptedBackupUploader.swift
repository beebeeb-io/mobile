import Foundation

enum NativeEncryptedBackupUploadError: LocalizedError {
  case invalidBaseURL
  case invalidResponse
  case missingParentFolder
  case httpStatus(Int, String)
  case jsonEncoding
  /// Task 1531 [P0]: the caller's `accountId` (the account these bytes were
  /// produced for) no longer matches `NativeBackupEngine.currentAccountId`
  /// (the account this device is currently authorized to upload for) — see
  /// the account-binding check in `performUpload`.
  case accountMismatch
  /// Task 1531 [P2-F] (round 5 delta security review): no in-process
  /// master-key cache was available and this uploader refused to fall back
  /// to a direct Keychain read (see `currentMasterKey()`) rather than risk
  /// an unprompted biometric sheet from a background/silent caller.
  case noCachedMasterKey

  var errorDescription: String? {
    switch self {
    case .invalidBaseURL:
      return "Invalid backup server URL"
    case .invalidResponse:
      return "Invalid backup upload response"
    case .missingParentFolder:
      return "Missing backup destination folder"
    case .httpStatus(let status, let body):
      return body.isEmpty ? "Backup upload failed with HTTP \(status)" : "Backup upload failed with HTTP \(status): \(body)"
    case .jsonEncoding:
      return "Could not encode backup upload request"
    case .accountMismatch:
      return "Backup upload refused: signed-in account changed"
    case .noCachedMasterKey:
      return "Backup upload refused: no unlocked master key available (open Beebeeb to continue)"
    }
  }
}

final class NativeEncryptedBackupUploader {
  static let shared = NativeEncryptedBackupUploader()

  /// Chunk-plan profile passed to `beebeeb-core`. The chunk size + count are
  /// derived in Rust from this profile + the plaintext size — never hardcoded
  /// here (the old 4 MiB constant is gone). Must be one of the core profiles:
  /// "desktop", "web", "mobile", "backup".
  private static let chunkProfile = "mobile"

  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
  }

  // Task 1531 [P0]: this class used to keep its OWN private `cachedMasterKey`
  // (loaded once, on first use, and never re-checked) alongside the app-wide
  // `BeebeebCryptoBridge` cache. `clearCachedKey()` existed to invalidate it
  // but had ZERO callers, so after an A→B account switch without an app
  // restart this second cache kept serving A's key to every subsequent
  // Contacts/Calendar/legacy-photo upload — B's contacts/calendar ended up
  // encrypted under A's master key and stored in B's account. There is now
  // exactly ONE master-key cache in this process: `BeebeebCryptoBridge`'s,
  // already invalidated on sign-out by `deleteKeyFromKeychain` and by
  // `releaseHandle` once no handles remain (BeebeebCryptoModule.swift). This
  // class reads it fresh — never caches its own copy — on every upload.
  //
  // Task 1531 [P2-F] (round 5 delta security review): NEVER fall through to
  // `BeebeebCryptoBridge.requireMasterKey()` here. That call reads the
  // Keychain directly and, per its own doc comment, "may trigger a
  // biometric/passcode prompt if SE access control requires it". This
  // uploader backs Contacts/Calendar (and legacy Photo) backup, which can
  // run from a `CNContactStoreDidChangeNotification`/`EKEventStoreChanged`
  // callback or a background task with no foreground UI context to receive
  // a Face ID sheet — surfacing one unprompted is exactly the "surprise
  // prompt" class of bug task 0556 fixed for keychain access-control
  // changes. Refuse instead. The in-process cache is populated whenever the
  // user unlocks in the foreground (`loadKeyFromKeychainAsHandle`/
  // `createMasterKeyHandle` in BeebeebCryptoModule.swift, and
  // `NativeBackupEngine.start()`), so a real foreground app session will
  // already have it warm; a cold cache means this call is refused, not
  // silently escalated to a prompt.
  private func currentMasterKey() throws -> MasterKeyHandle {
    guard let cached = BeebeebCryptoBridge.cachedMasterKeyIfAvailable() else {
      RuntimeTrace.event("backup.legacy_uploader.no_cached_master_key_refused")
      throw NativeEncryptedBackupUploadError.noCachedMasterKey
    }
    return cached
  }

  func upload(
    plaintext: Data,
    fileName: String,
    mimeType: String,
    parentFolderId: String?,
    authToken: String,
    serverBaseURL: String,
    /// Task 1531 [P0]: the account this plaintext was produced for (the
    /// caller's own signed-in account id, e.g. `ContactsBackupManager`'s
    /// `accountId`). Checked against `NativeBackupEngine.currentAccountId`
    /// — the single keychain-persisted source of truth for "which account
    /// is this device currently authorized to upload for" already used by
    /// the photo engine's own staged-asset binding — before the master key
    /// is touched, and again immediately before the upload is marked
    /// complete, so an account switch mid-upload is refused rather than
    /// silently completed under the wrong identity.
    accountId: String,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    guard let parentFolderId, !parentFolderId.isEmpty else {
      completion(.failure(NativeEncryptedBackupUploadError.missingParentFolder))
      return
    }

    DispatchQueue.global(qos: .utility).async {
      do {
        let serverFileId = try self.performUpload(
          plaintext: plaintext,
          fileName: fileName,
          mimeType: mimeType,
          parentFolderId: parentFolderId,
          authToken: authToken,
          serverBaseURL: serverBaseURL,
          accountId: accountId
        )
        completion(.success(serverFileId))
      } catch {
        completion(.failure(error))
      }
    }
  }

  /// Synchronous streaming upload, driven by the shared `beebeeb-core`
  /// `ChunkEncryptorHandle`. Runs on a utility background queue (see `upload`).
  ///
  /// The master key never leaves Rust/the keychain: the encryptor derives the
  /// per-file key in core from the borrowed `MasterKeyHandle`. The plaintext is
  /// sliced into core-planned chunks and each `nonce||ct||tag` frame is PUT
  /// directly — there is no whole-file ciphertext buffer and no hardcoded chunk
  /// size. `finish()` runs the core integrity guard before `upload/complete`.
  private func performUpload(
    plaintext: Data,
    fileName: String,
    mimeType: String,
    parentFolderId: String,
    authToken: String,
    serverBaseURL: String,
    accountId: String
  ) throws -> String {
    // Task 1531 [P0]: refuse BEFORE the master key is even loaded when this
    // plaintext's account is not the account this device is currently
    // authorized to upload for. A caller with no opinion (empty accountId)
    // is not "trust it" — it refuses exactly like a proven mismatch.
    try Self.requireAccountBinding(accountId)

    let fileId = UUID().uuidString.lowercased()
    let masterKey = try currentMasterKey()
    let nameEncrypted = try masterKey.encryptName(fileId: fileId, filename: fileName, mimeType: mimeType)

    let encryptor = try ChunkEncryptorHandle.forPush(
      masterKey: masterKey,
      fileId: fileId,
      fileSize: UInt64(plaintext.count),
      profile: Self.chunkProfile
    )
    let plan = try encryptor.chunkPlan()
    let chunkSize = Int(plan.chunkSizeBytes)
    let chunkCount = Int(plan.chunkCount)

    // 1. upload/init — wire contract preserved: size_bytes stays the PLAINTEXT
    //    byte count (the server recomputes the stored size from the chunks);
    //    chunk_count comes from the core plan.
    let serverFileId = try initUpload(
      fileId: fileId,
      nameEncrypted: nameEncrypted,
      parentFolderId: parentFolderId,
      mimeType: mimeType,
      plaintextSize: plaintext.count,
      chunkCount: chunkCount,
      authToken: authToken,
      serverBaseURL: serverBaseURL
    )

    // 2. Stream the chunks: slice into plan-sized pieces, encrypt each via the
    //    core push API, and PUT the returned frame. The loop emits exactly
    //    `chunkCount` chunks (an empty file → one empty chunk), which is what
    //    `finish()`'s integrity guard expects.
    for index in 0..<chunkCount {
      let start = index * chunkSize
      let end = min(start + chunkSize, plaintext.count)
      let slice = start < end ? plaintext.subdata(in: start..<end) : Data()
      let chunk = try encryptor.pushChunk(plaintext: slice)
      try putChunk(
        frame: chunk.data,
        index: Int(chunk.index),
        serverFileId: serverFileId,
        authToken: authToken,
        serverBaseURL: serverBaseURL
      )
    }

    // 3. Integrity guard (detects a source that shrank) BEFORE telling the
    //    server the upload is complete.
    _ = try encryptor.finish()

    // Task 1531 [P0]: re-check right before telling the server this upload
    // is done. The chunk loop above can take a while for a large export; if
    // the signed-in account changed mid-upload, the ciphertext was already
    // encrypted under the OLD account's key by this point — completing the
    // upload can't be undone by refusing later, so refuse HERE, before the
    // one irreversible step, rather than let a stale upload land.
    try Self.requireAccountBinding(accountId)

    // 4. upload/complete.
    try completeUpload(
      serverFileId: serverFileId,
      authToken: authToken,
      serverBaseURL: serverBaseURL
    )

    return serverFileId
  }

  /// Task 1531 [P0]: refuse unless `accountId` (the account this plaintext
  /// belongs to) is the account `NativeBackupEngine` currently believes this
  /// device is signed in as. A caller with an empty/unknown accountId is
  /// UNTRUSTED, not "no opinion" — it refuses exactly like a proven mismatch.
  private static func requireAccountBinding(_ accountId: String) throws {
    guard !accountId.isEmpty,
          let runningAccountId = NativeBackupEngine.shared.currentAccountId,
          runningAccountId == accountId
    else {
      RuntimeTrace.event("backup.legacy_uploader.account_mismatch_refused", [
        "callerAccount": accountId.isEmpty ? "(empty)" : accountId
      ])
      throw NativeEncryptedBackupUploadError.accountMismatch
    }
  }

  private func initUpload(
    fileId: String,
    nameEncrypted: String,
    parentFolderId: String,
    mimeType: String,
    plaintextSize: Int,
    chunkCount: Int,
    authToken: String,
    serverBaseURL: String
  ) throws -> String {
    guard let url = URL(string: "\(serverBaseURL)/api/v1/files/upload/init") else {
      throw NativeEncryptedBackupUploadError.invalidBaseURL
    }

    let isMediaFlag = isMedia(mimeType: mimeType)
    let body: [String: Any] = [
      "file_id": fileId,
      "name_encrypted": nameEncrypted,
      "parent_id": parentFolderId,
      "mime_type": NSNull(),
      "is_media": isMediaFlag,
      "size_bytes": plaintextSize,
      "chunk_count": chunkCount,
    ]
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body, options: []) else {
      throw NativeEncryptedBackupUploadError.jsonEncoding
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = bodyData

    let data = try sendSync(request)
    guard
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let serverFileId = object["file_id"] as? String,
      !serverFileId.isEmpty
    else {
      throw NativeEncryptedBackupUploadError.invalidResponse
    }
    return serverFileId
  }

  private func putChunk(
    frame: Data,
    index: Int,
    serverFileId: String,
    authToken: String,
    serverBaseURL: String
  ) throws {
    guard let url = URL(string: "\(serverBaseURL)/api/v1/files/\(serverFileId)/chunks/\(index)") else {
      throw NativeEncryptedBackupUploadError.invalidBaseURL
    }

    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.httpMethod = "PUT"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = frame

    _ = try sendSync(request)
  }

  private func completeUpload(
    serverFileId: String,
    authToken: String,
    serverBaseURL: String
  ) throws {
    guard let url = URL(string: "\(serverBaseURL)/api/v1/files/\(serverFileId)/upload/complete") else {
      throw NativeEncryptedBackupUploadError.invalidBaseURL
    }
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)

    _ = try sendSync(request)
  }

  /// Perform a request synchronously on the current (background) thread. The
  /// `URLSession` completion fires on the session's own delegate queue, so
  /// blocking here cannot deadlock the upload.
  private func sendSync(_ request: URLRequest) throws -> Data {
    let semaphore = DispatchSemaphore(value: 0)
    var outcome: Result<Data, Error> = .failure(NativeEncryptedBackupUploadError.invalidResponse)

    session.dataTask(with: request) { data, response, error in
      defer { semaphore.signal() }
      if let error {
        outcome = .failure(error)
        return
      }
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data ?? Data()
      guard (200..<300).contains(statusCode) else {
        outcome = .failure(NativeEncryptedBackupUploadError.httpStatus(statusCode, String(data: body, encoding: .utf8) ?? ""))
        return
      }
      outcome = .success(body)
    }.resume()

    semaphore.wait()
    return try outcome.get()
  }
}
