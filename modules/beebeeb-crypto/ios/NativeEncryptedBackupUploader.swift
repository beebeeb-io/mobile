import Foundation

enum NativeEncryptedBackupUploadError: LocalizedError {
  case invalidBaseURL
  case invalidResponse
  case missingParentFolder
  case httpStatus(Int, String)
  case jsonEncoding

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

  /// Cached master key handle — loaded once per batch to avoid repeated
  /// keychain access (and Face ID prompts when biometric policy is active).
  private var cachedMasterKey: MasterKeyHandle?
  private let keyLock = NSLock()

  init(session: URLSession = .shared) {
    self.session = session
  }

  /// Load the master key once and cache it for the duration of the batch.
  /// Thread-safe via keyLock.
  private func getMasterKey() throws -> MasterKeyHandle {
    keyLock.lock()
    defer { keyLock.unlock() }
    if let cached = cachedMasterKey { return cached }
    let key = try BeebeebCryptoBridge.requireMasterKey()
    cachedMasterKey = key
    return key
  }

  /// Clear the cached master key (e.g. on sign-out).
  func clearCachedKey() {
    keyLock.lock()
    defer { keyLock.unlock() }
    cachedMasterKey = nil
  }

  func upload(
    plaintext: Data,
    fileName: String,
    mimeType: String,
    parentFolderId: String?,
    authToken: String,
    serverBaseURL: String,
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
          serverBaseURL: serverBaseURL
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
    serverBaseURL: String
  ) throws -> String {
    let fileId = UUID().uuidString.lowercased()
    let masterKey = try getMasterKey()
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

    // 4. upload/complete.
    try completeUpload(
      serverFileId: serverFileId,
      authToken: authToken,
      serverBaseURL: serverBaseURL
    )

    return serverFileId
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
