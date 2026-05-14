import Foundation

private let nativeBackupChunkSize = 4 * 1024 * 1024

enum NativeEncryptedBackupUploadError: LocalizedError {
  case invalidBaseURL
  case invalidResponse
  case httpStatus(Int, String)
  case jsonEncoding

  var errorDescription: String? {
    switch self {
    case .invalidBaseURL:
      return "Invalid backup server URL"
    case .invalidResponse:
      return "Invalid backup upload response"
    case .httpStatus(let status, let body):
      return body.isEmpty ? "Backup upload failed with HTTP \(status)" : "Backup upload failed with HTTP \(status): \(body)"
    case .jsonEncoding:
      return "Could not encode backup upload request"
    }
  }
}

final class NativeEncryptedBackupUploader {
  static let shared = NativeEncryptedBackupUploader()

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
    DispatchQueue.global(qos: .utility).async {
      do {
        let fileId = UUID().uuidString.lowercased()
        let masterKey = try self.getMasterKey()
        let nameEncrypted = try masterKey.encryptName(fileId: fileId, filename: fileName, mimeType: mimeType)
        let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
        let chunkCount = max(1, Int(ceil(Double(plaintext.count) / Double(nativeBackupChunkSize))))

        try self.initUpload(
          fileId: fileId,
          nameEncrypted: nameEncrypted,
          parentFolderId: parentFolderId,
          mimeType: mimeType,
          plaintextSize: plaintext.count,
          chunkCount: chunkCount,
          authToken: authToken,
          serverBaseURL: serverBaseURL
        ) { result in
          switch result {
          case .failure(let error):
            completion(.failure(error))
          case .success(let serverFileId):
            self.uploadChunk(
              index: 0,
              chunkCount: chunkCount,
              plaintext: plaintext,
              fileKey: fileKey,
              serverFileId: serverFileId,
              authToken: authToken,
              serverBaseURL: serverBaseURL
            ) { chunkResult in
              switch chunkResult {
              case .failure(let error):
                completion(.failure(error))
              case .success:
                self.completeUpload(
                  serverFileId: serverFileId,
                  authToken: authToken,
                  serverBaseURL: serverBaseURL
                ) { completeResult in
                  switch completeResult {
                  case .failure(let error):
                    completion(.failure(error))
                  case .success:
                    completion(.success(serverFileId))
                  }
                }
              }
            }
          }
        }
      } catch {
        completion(.failure(error))
      }
    }
  }

  private func initUpload(
    fileId: String,
    nameEncrypted: String,
    parentFolderId: String?,
    mimeType: String,
    plaintextSize: Int,
    chunkCount: Int,
    authToken: String,
    serverBaseURL: String,
    completion: @escaping (Result<String, Error>) -> Void
  ) throws {
    guard let url = URL(string: "\(serverBaseURL)/api/v1/files/upload/init") else {
      throw NativeEncryptedBackupUploadError.invalidBaseURL
    }

    let isMediaFlag = isMedia(mimeType: mimeType)
    let body: [String: Any] = [
      "file_id": fileId,
      "name_encrypted": nameEncrypted,
      "parent_id": parentFolderId as Any? ?? NSNull(),
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

    send(request) { result in
      switch result {
      case .failure(let error):
        completion(.failure(error))
      case .success(let data):
        guard
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let serverFileId = object["file_id"] as? String,
          !serverFileId.isEmpty
        else {
          completion(.failure(NativeEncryptedBackupUploadError.invalidResponse))
          return
        }
        completion(.success(serverFileId))
      }
    }
  }

  private func uploadChunk(
    index: Int,
    chunkCount: Int,
    plaintext: Data,
    fileKey: FileKeyHandle,
    serverFileId: String,
    authToken: String,
    serverBaseURL: String,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    guard index < chunkCount else {
      completion(.success(()))
      return
    }

    do {
      let start = index * nativeBackupChunkSize
      let end = min(start + nativeBackupChunkSize, plaintext.count)
      let chunkPlaintext = start < end ? plaintext.subdata(in: start..<end) : Data()
      let encrypted = try fileKey.encryptChunk(plaintext: chunkPlaintext)
      var body = Data()
      body.append(encrypted.nonce)
      body.append(encrypted.ciphertext)

      guard let url = URL(string: "\(serverBaseURL)/api/v1/files/\(serverFileId)/chunks/\(index)") else {
        completion(.failure(NativeEncryptedBackupUploadError.invalidBaseURL))
        return
      }

      var request = URLRequest(url: url)
      request.httpMethod = "PUT"
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
      request.httpBody = body

      send(request) { result in
        switch result {
        case .failure(let error):
          completion(.failure(error))
        case .success:
          self.uploadChunk(
            index: index + 1,
            chunkCount: chunkCount,
            plaintext: plaintext,
            fileKey: fileKey,
            serverFileId: serverFileId,
            authToken: authToken,
            serverBaseURL: serverBaseURL,
            completion: completion
          )
        }
      }
    } catch {
      completion(.failure(error))
    }
  }

  private func completeUpload(
    serverFileId: String,
    authToken: String,
    serverBaseURL: String,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    guard let url = URL(string: "\(serverBaseURL)/api/v1/files/\(serverFileId)/upload/complete") else {
      completion(.failure(NativeEncryptedBackupUploadError.invalidBaseURL))
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)

    send(request) { result in
      switch result {
      case .failure(let error):
        completion(.failure(error))
      case .success:
        completion(.success(()))
      }
    }
  }

  private func send(_ request: URLRequest, completion: @escaping (Result<Data, Error>) -> Void) {
    session.dataTask(with: request) { data, response, error in
      if let error {
        completion(.failure(error))
        return
      }
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data ?? Data()
      guard (200..<300).contains(statusCode) else {
        completion(.failure(NativeEncryptedBackupUploadError.httpStatus(statusCode, String(data: body, encoding: .utf8) ?? "")))
        return
      }
      completion(.success(body))
    }.resume()
  }
}
