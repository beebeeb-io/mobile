import Foundation

/// Minimal Beebeeb API client used inside the File Provider extension.
///
/// Reads the session token + base URL from the App Group `UserDefaults` (the
/// main app mirrors them after sign-in). Talks to the same endpoints as the
/// web client — see `repos/server/CLAUDE.md` for the schema.
final class ApiClient {
  static let shared = ApiClient()

  private let session: URLSession

  init(session: URLSession? = nil) {
    let cfg = URLSessionConfiguration.default
    // Task 1962 round 4 (Bug 6c): extension sessions keep no response cache.
    cfg.urlCache = nil
    cfg.timeoutIntervalForRequest = 60
    cfg.timeoutIntervalForResource = 600
    cfg.httpMaximumConnectionsPerHost = 4
    self.session = session ?? URLSession(configuration: cfg)
    // App Group UserDefaults handle is no longer needed — session token
    // and baseUrl moved to the shared Keychain (task 0447).
  }

  // MARK: - Configuration

  var baseUrl: URL {
    // Session base URL moved from App Group UserDefaults to the shared
    // Keychain (`BeebeebKeychainCore`) in task 0447 so it doesn't leak
    // into unencrypted device backups. `loadString` migrates the legacy
    // UserDefaults entry into the keychain on first read and only
    // clears the legacy entry on `errSecSuccess`, so existing installs
    // upgrade transparently. Falls back to the production default when
    // the keychain slot is empty.
    let raw = BeebeebKeychainCore.loadString(key: BeebeebConstants.userDefaultsApiBaseUrlKey)
      ?? BeebeebConstants.defaultApiBaseUrl
    return URL(string: raw)!
  }

  var sessionToken: String? {
    // Same migration as `baseUrl` — see the comment above.
    BeebeebKeychainCore.loadString(key: BeebeebConstants.userDefaultsSessionTokenKey)
  }

  // MARK: - DTOs

  struct FileEntryDto: Decodable {
    let id: String
    let parent_id: String?
    let name_encrypted: String?
    let name_nonce: String?
    let mime_type: String?
    let size_bytes: Int
    let is_folder: Bool
    let chunk_count: Int
    let created_at: String?
    let updated_at: String?
  }

  struct ListResponse: Decodable {
    let files: [FileEntryDto]
    let next_cursor: String?
  }

  struct UploadResponseDto: Decodable {
    let id: String
    let name_encrypted: String?
    let size_bytes: Int
    let chunk_count: Int
    let created_at: String?
    let updated_at: String?
  }

  struct UploadV2InitResponse: Decodable {
    let file_id: String
    let upload_session_id: String
    let chunk_size_bytes: Int
    let chunk_count: Int
  }

  // MARK: - Endpoints

  /// List the children of `parentId`. Pass `nil` for the root.
  func listFiles(parentId: String?) async throws -> [FileEntryDto] {
    var entries: [FileEntryDto] = []
    var cursor: String?
    var seenCursors = Set<String>()
    repeat {
      try Task.checkCancellation()
      var components = URLComponents(url: baseUrl.appendingPathComponent("/api/v1/files"), resolvingAgainstBaseURL: false)!
      var query: [URLQueryItem] = []
      if let parentId { query.append(URLQueryItem(name: "parent_id", value: parentId)) }
      if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
      components.queryItems = query.isEmpty ? nil : query
      let request = try authedRequest(url: components.url!, method: "GET")
      let (data, response) = try await session.data(for: request)
      try validate(response, data)
      let page = try JSONDecoder().decode(ListResponse.self, from: data)
      entries.append(contentsOf: page.files)
      cursor = page.next_cursor
      if let cursor, !seenCursors.insert(cursor).inserted {
        // Never publish a partial listing to replaceChildren's prune.
        throw ApiError.invalidResponse
      }
    } while cursor != nil
    return entries
  }

  /// Download the encrypted chunk stream for a file into a temporary file.
  ///
  /// Task 1722 (G5): the ciphertext goes to disk, not into one `Data`, so a
  /// large file (the 59.8 MB DNG) never needs its full size in memory; the
  /// caller decrypts it chunk by chunk. The file holds ciphertext only and
  /// the caller deletes it (`DownloadedEncryptedFile.url`) when done.
  /// SF-0002 M2a run 3: ONE bounded read of chunk 0, used to classify an owned
  /// content version before a Files-app edit. A declared/actual length over
  /// `maxBytes` reports `tooLarge` without keeping the body.
  func firstChunk(fileId: String, maxBytes: Int) async throws -> (status: Int, body: Data, tooLarge: Bool) {
    let url = baseUrl.appendingPathComponent("/api/v1/files/\(fileId)/chunks/0")
    var request = try authedRequest(url: url, method: "GET")
    request.setValue("bytes=0-\(maxBytes)", forHTTPHeaderField: "Range")
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if data.count > maxBytes { return (status, Data(), true) }
    return (status, data, false)
  }

  func downloadEncrypted(fileId: String) async throws -> DownloadedEncryptedFile {
    let url = baseUrl.appendingPathComponent("/api/v1/files/\(fileId)/download")
    let request = try authedRequest(url: url, method: "GET")
    let (location, response) = try await session.download(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      // An error body is a small JSON document; read it for the 409
      // account-mismatch check, then drop the file.
      let body = (try? Data(contentsOf: location)) ?? Data()
      try? FileManager.default.removeItem(at: location)
      try validate(response, body)
      throw ApiError.invalidResponse
    }
    let chunkCount = Int(http.value(forHTTPHeaderField: "X-Chunk-Count") ?? "1") ?? 1
    let chunkSize = Int(http.value(forHTTPHeaderField: "X-Chunk-Size") ?? "") ?? defaultPlaintextChunkSize
    return DownloadedEncryptedFile(
      url: location,
      chunkCount: max(1, chunkCount),
      chunkSize: max(1, chunkSize)
    )
  }

  /// Open a v2 chunked-upload session. Returns the assigned `file_id` and
  /// `upload_session_id`; the client then PUTs each encrypted chunk to
  /// `/api/v1/uploads/{session_id}/chunks/{index}` and finalizes with
  /// `completeUploadV2`.
  ///
  /// The v2 path is the only upload route used from the File Provider, because
  /// the legacy `/api/v1/files/upload` endpoint requires building the entire
  /// multipart body in memory — which OOM-kills the extension on files larger
  /// than ~30 MB (iOS gives File Provider extensions a 50 MB resident budget).
  func initUploadV2(
    fileId: String,
    nameEncrypted: String,
    fileSizeBytes: Int64,
    mimeType: String?,
    parentId: String?,
    isMedia: Bool,
    chunkSizeBytes: Int,
    chunkCount: Int,
    expectedUser: String?
  ) async throws -> UploadV2InitResponse {
    var request = try authedRequest(
      url: baseUrl.appendingPathComponent("/api/v1/uploads/init"),
      method: "POST",
      expectedUser: expectedUser
    )
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    var body: [String: Any] = [
      "file_id": fileId.lowercased(),
      "file_name": nameEncrypted,
      "file_size_bytes": fileSizeBytes,
      "is_media": isMedia,
      "profile": "mobile",
      "chunk_size_bytes": chunkSizeBytes,
      "chunk_count": chunkCount,
    ]
    body["mime_type"] = mimeType ?? NSNull()
    body["parent_id"] = parentId ?? NSNull()
    request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

    let (data, response) = try await session.data(for: request)
    try validate(response, data)
    return try JSONDecoder().decode(UploadV2InitResponse.self, from: data)
  }

  /// Upload one encrypted chunk for a v2 session. Body is raw
  /// `nonce || ciphertext || tag` bytes (12 + N + 16 for AES-256-GCM).
  func uploadChunkV2(uploadSessionId: String, index: Int, encryptedChunk: Data, expectedUser: String?) async throws {
    let url = baseUrl.appendingPathComponent("/api/v1/uploads/\(uploadSessionId)/chunks/\(index)")
    var request = try authedRequest(url: url, method: "PUT", expectedUser: expectedUser)
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.httpBody = encryptedChunk

    let (data, response) = try await session.data(for: request)
    try validate(response, data)
  }

  /// Finalize a v2 chunked upload. Server verifies all chunks are present,
  /// updates the file row, and returns the canonical file metadata.
  func completeUploadV2(uploadSessionId: String, expectedUser: String?) async throws -> UploadResponseDto {
    let url = baseUrl.appendingPathComponent("/api/v1/uploads/\(uploadSessionId)/complete")
    var request = try authedRequest(url: url, method: "POST", expectedUser: expectedUser)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)

    let (data, response) = try await session.data(for: request)
    try validate(response, data)
    return try JSONDecoder().decode(UploadResponseDto.self, from: data)
  }

  /// Patch encrypted metadata for a file. The server route accepts rename and
  /// move in the same request, which matches iOS Files edit semantics.
  func patchFile(fileId: String, nameEncrypted: String? = nil, parentId: String? = nil, expectedUser: String?) async throws -> FileEntryDto {
    let url = baseUrl.appendingPathComponent("/api/v1/files/\(fileId)")
    var request = try authedRequest(url: url, method: "PATCH", expectedUser: expectedUser)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    var body: [String: Any] = [:]
    if let nameEncrypted { body["name_encrypted"] = nameEncrypted }
    if let parentId {
      body["parent_id"] = parentId
    } else {
      body["parent_id"] = NSNull()
    }
    request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

    let (data, response) = try await session.data(for: request)
    try validate(response, data)
    return try JSONDecoder().decode(FileEntryDto.self, from: data)
  }

  /// Soft-delete (trash) a file.
  func deleteFile(fileId: String, expectedUser: String?) async throws {
    let request = try authedRequest(
      url: baseUrl.appendingPathComponent("/api/v1/files/\(fileId)"),
      method: "DELETE",
      expectedUser: expectedUser
    )
    let (data, response) = try await session.data(for: request)
    try validate(response, data)
  }

  // MARK: - Helpers

  /// Task 1594 round 4 (Codex P1, FileProviderExtension.swift:73): `expectedUser`
  /// carries the CACHED master key's proven owner (`CryptoBridge.currentKeyOwner()`
  /// / `FileProviderExtension.masterKey()`) onto every MUTATING request, exactly
  /// like the main app's `X-Beebeeb-Expected-User` (`expected-user.ts`). Even
  /// with the round-3 (T4) cache-identity fix, an account switch can still land
  /// between `masterKey()` returning A's handle and this request actually
  /// reaching the network — `authedRequest`'s own session-token read is
  /// independent and always current. The header lets the SERVER (which knows
  /// the session's real account) refuse with 409 `account_mismatch` when the
  /// two disagree, closing that window server-side rather than trusting the
  /// extension process to never race itself. `nil` (no verified owner yet, or
  /// a read-only request) omits the header — unchanged, pre-1594 behaviour.
  private func authedRequest(url: URL, method: String, expectedUser: String? = nil) throws -> URLRequest {
    guard let token = sessionToken else { throw ApiError.notAuthenticated }
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let expectedUser, !expectedUser.isEmpty {
      request.setValue(expectedUser, forHTTPHeaderField: "X-Beebeeb-Expected-User")
    }
    return request
  }

  private func validate(_ response: URLResponse, _ data: Data) throws {
    guard let http = response as? HTTPURLResponse else { throw ApiError.invalidResponse }
    if http.statusCode == 401 { throw ApiError.notAuthenticated }
    if http.statusCode == 409, AccountMismatchDetection.isAccountMismatch(data) {
      // Server-side auth.rs `check_expected_user` (task 1554): the session's
      // real account doesn't match the `X-Beebeeb-Expected-User` we sent —
      // the extension's cached key belongs to a DIFFERENT account than the
      // one the request actually authenticated as. Never fall through to the
      // generic `.statusCode(409)` branch for this — the caller must treat it
      // as a clean, non-retryable ownership failure (`mapError`), not a
      // transient conflict worth retrying with the same stale key.
      throw ApiError.accountMismatch
    }
    if !(200..<300).contains(http.statusCode) {
      throw ApiError.statusCode(http.statusCode)
    }
  }

}

enum ApiError: Error {
  case notAuthenticated
  case invalidResponse
  case statusCode(Int)
  /// Task 1594 round 4: 409 `account_mismatch` — the session's account
  /// doesn't match the `X-Beebeeb-Expected-User` header this request sent.
  case accountMismatch
}

struct DownloadedEncryptedFile {
  /// `nonce || ciphertext || tag` frames on disk (task 1722 G5). Ciphertext
  /// only; whoever downloaded it deletes it.
  let url: URL
  let chunkCount: Int
  let chunkSize: Int
}

let defaultPlaintextChunkSize = 4 * 1024 * 1024
