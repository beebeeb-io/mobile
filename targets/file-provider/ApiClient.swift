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

  /// Stream the encrypted blob for a file. The body is the raw concatenated
  /// chunk stream — for now we treat the whole download as one ciphertext
  /// blob; chunked downloads come later.
  func downloadEncrypted(fileId: String) async throws -> Data {
    let url = baseUrl.appendingPathComponent("/api/v1/files/\(fileId)/download")
    let request = try authedRequest(url: url, method: "GET")
    let (data, response) = try await session.data(for: request)
    try validate(response)
    return data
  }

  /// Upload an encrypted file. `metadataJson` follows the multipart upload
  /// schema documented in `repos/server/CLAUDE.md`. Each `chunks[i]` is
  /// AES-GCM ciphertext; nonces and the cipher suite live inside `metadataJson`.
  func uploadEncrypted(
    metadataJson: Data,
    chunks: [Data]
  ) async throws -> UploadResponseDto {
    let boundary = "beebeeb-fp-\(UUID().uuidString)"
    var request = try authedRequest(
      url: baseUrl.appendingPathComponent("/api/v1/files/upload"),
      method: "POST"
    )
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.httpBody = buildMultipartBody(
      boundary: boundary,
      metadataJson: metadataJson,
      chunks: chunks
    )

    let (data, response) = try await session.data(for: request)
    try validate(response)
    return try JSONDecoder().decode(UploadResponseDto.self, from: data)
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

  private func buildMultipartBody(
    boundary: String,
    metadataJson: Data,
    chunks: [Data]
  ) -> Data {
    var body = Data()
    let boundaryBytes = "--\(boundary)\r\n".data(using: .utf8)!
    let endBoundaryBytes = "--\(boundary)--\r\n".data(using: .utf8)!

    body.append(boundaryBytes)
    body.append("Content-Disposition: form-data; name=\"metadata\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: application/json\r\n\r\n".data(using: .utf8)!)
    body.append(metadataJson)
    body.append("\r\n".data(using: .utf8)!)

    for (index, chunk) in chunks.enumerated() {
      body.append(boundaryBytes)
      body.append(
        "Content-Disposition: form-data; name=\"chunk_\(index)\"; filename=\"chunk_\(index).bin\"\r\n"
          .data(using: .utf8)!
      )
      body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
      body.append(chunk)
      body.append("\r\n".data(using: .utf8)!)
    }

    body.append(endBoundaryBytes)
    return body
  }
}

enum ApiError: Error {
  case notAuthenticated
  case invalidResponse
  case statusCode(Int)
}
