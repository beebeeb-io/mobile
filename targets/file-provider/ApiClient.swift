import Foundation

/// Minimal Beebeeb API client used inside the File Provider extension.
///
/// Reads the session token + base URL from the App Group `UserDefaults` (the
/// main app mirrors them after sign-in). Talks to the same endpoints as the
/// web client — see `repos/server/CLAUDE.md` for the schema.
final class ApiClient {
  static let shared = ApiClient()

  private let session: URLSession
  private let defaults: UserDefaults?

  private init() {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 60
    cfg.timeoutIntervalForResource = 600
    cfg.httpMaximumConnectionsPerHost = 4
    self.session = URLSession(configuration: cfg)
    self.defaults = UserDefaults(suiteName: BeebeebConstants.appGroup)
  }

  // MARK: - Configuration

  var baseUrl: URL {
    let raw = defaults?.string(forKey: BeebeebConstants.userDefaultsApiBaseUrlKey)
      ?? BeebeebConstants.defaultApiBaseUrl
    return URL(string: raw)!
  }

  var sessionToken: String? {
    defaults?.string(forKey: BeebeebConstants.userDefaultsSessionTokenKey)
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
    var components = URLComponents(url: baseUrl.appendingPathComponent("/api/v1/files"), resolvingAgainstBaseURL: false)!
    if let parentId {
      components.queryItems = [URLQueryItem(name: "parent_id", value: parentId)]
    }
    let request = try authedRequest(url: components.url!, method: "GET")
    let (data, response) = try await session.data(for: request)
    try validate(response)
    return try JSONDecoder().decode(ListResponse.self, from: data).files
  }

  /// Download the encrypted chunk stream for a file.
  func downloadEncrypted(fileId: String) async throws -> DownloadedEncryptedFile {
    let url = baseUrl.appendingPathComponent("/api/v1/files/\(fileId)/download")
    let request = try authedRequest(url: url, method: "GET")
    let (data, response) = try await session.data(for: request)
    try validate(response)
    let http = response as? HTTPURLResponse
    let chunkCount = Int(http?.value(forHTTPHeaderField: "X-Chunk-Count") ?? "1") ?? 1
    let chunkSize = Int(http?.value(forHTTPHeaderField: "X-Chunk-Size") ?? "") ?? defaultPlaintextChunkSize
    return DownloadedEncryptedFile(
      data: data,
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
    chunkCount: Int
  ) async throws -> UploadV2InitResponse {
    var request = try authedRequest(
      url: baseUrl.appendingPathComponent("/api/v1/uploads/init"),
      method: "POST"
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
    try validate(response)
    return try JSONDecoder().decode(UploadV2InitResponse.self, from: data)
  }

  /// Upload one encrypted chunk for a v2 session. Body is raw
  /// `nonce || ciphertext || tag` bytes (12 + N + 16 for AES-256-GCM).
  func uploadChunkV2(uploadSessionId: String, index: Int, encryptedChunk: Data) async throws {
    let url = baseUrl.appendingPathComponent("/api/v1/uploads/\(uploadSessionId)/chunks/\(index)")
    var request = try authedRequest(url: url, method: "PUT")
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.httpBody = encryptedChunk

    let (_, response) = try await session.data(for: request)
    try validate(response)
  }

  /// Finalize a v2 chunked upload. Server verifies all chunks are present,
  /// updates the file row, and returns the canonical file metadata.
  func completeUploadV2(uploadSessionId: String) async throws -> UploadResponseDto {
    let url = baseUrl.appendingPathComponent("/api/v1/uploads/\(uploadSessionId)/complete")
    var request = try authedRequest(url: url, method: "POST")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)

    let (data, response) = try await session.data(for: request)
    try validate(response)
    return try JSONDecoder().decode(UploadResponseDto.self, from: data)
  }

  /// Patch encrypted metadata for a file. The server route accepts rename and
  /// move in the same request, which matches iOS Files edit semantics.
  func patchFile(fileId: String, nameEncrypted: String? = nil, parentId: String? = nil) async throws -> FileEntryDto {
    let url = baseUrl.appendingPathComponent("/api/v1/files/\(fileId)")
    var request = try authedRequest(url: url, method: "PATCH")
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
    try validate(response)
    return try JSONDecoder().decode(FileEntryDto.self, from: data)
  }

  /// Soft-delete (trash) a file.
  func deleteFile(fileId: String) async throws {
    let request = try authedRequest(
      url: baseUrl.appendingPathComponent("/api/v1/files/\(fileId)"),
      method: "DELETE"
    )
    let (_, response) = try await session.data(for: request)
    try validate(response)
  }

  // MARK: - Helpers

  private func authedRequest(url: URL, method: String) throws -> URLRequest {
    guard let token = sessionToken else { throw ApiError.notAuthenticated }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return request
  }

  private func validate(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse else { throw ApiError.invalidResponse }
    if http.statusCode == 401 { throw ApiError.notAuthenticated }
    if !(200..<300).contains(http.statusCode) {
      throw ApiError.statusCode(http.statusCode)
    }
  }

}

enum ApiError: Error {
  case notAuthenticated
  case invalidResponse
  case statusCode(Int)
}

struct DownloadedEncryptedFile {
  let data: Data
  let chunkCount: Int
  let chunkSize: Int
}

let defaultPlaintextChunkSize = 4 * 1024 * 1024
