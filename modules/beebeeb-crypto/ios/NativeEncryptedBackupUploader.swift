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

  init(session: URLSession = .shared) {
    self.session = session
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
        let masterKey = try BeebeebCryptoBridge.requireMasterKey()
        let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
        let metadataPlain = try self.metadataJSON(fileName: fileName, mimeType: mimeType)
        let encryptedMetadata = try fileKey.encryptMetadata(metadata: metadataPlain)
        let nameEncrypted = try self.encryptedPayloadJSON(encryptedMetadata)
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

  private func metadataJSON(fileName: String, mimeType: String) throws -> String {
    let metadata: [String: Any] = ["name": fileName, "mime_type": mimeType]
    guard JSONSerialization.isValidJSONObject(metadata),
          let data = try? JSONSerialization.data(withJSONObject: metadata, options: []),
          let json = String(data: data, encoding: .utf8) else {
      throw NativeEncryptedBackupUploadError.jsonEncoding
    }
    return json
  }

  private func encryptedPayloadJSON(_ encrypted: EncryptedData) throws -> String {
    let payload: [String: Any] = [
      "cipher_suite": encrypted.cipherSuite,
      "nonce": encrypted.nonce.map(Int.init),
      "ciphertext": encrypted.ciphertext.map(Int.init),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let json = String(data: data, encoding: .utf8) else {
      throw NativeEncryptedBackupUploadError.jsonEncoding
    }
    return json
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

    let body: [String: Any] = [
      "file_id": fileId,
      "name_encrypted": nameEncrypted,
      "parent_id": parentFolderId as Any? ?? NSNull(),
      "mime_type": mimeType,
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
