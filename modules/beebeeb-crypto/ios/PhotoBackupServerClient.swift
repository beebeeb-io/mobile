import Foundation

/// Task 1667 round 10: the server reads the camera-roll dedupe needs, as one
/// small client so the engine and
/// `scripts/swift-tests/pending-upload-server-check-test.swift` send the SAME
/// requests (the test answers them from a URLProtocol stub). Every answer goes
/// through `PhotoBackupServerResponses`, which fails closed on anything it
/// cannot read.
///
/// - `check`: `POST /api/v1/files/photo-backup/check`, per device: the
///   backed-up identifiers WITH their file ids (`backed_up`, server task 2036).
/// - `identifierMap`: `GET /api/v1/files/photo-backup/identifiers`, per device.
///
/// Round 11 (review finding 2): no `GET /api/v1/files/index`. Native code
/// never reads the file index (mobile CLAUDE.md, task 1959: it walks the whole
/// vault on every call); the server filters trashed files in both routes
/// (task 2036).
struct PhotoBackupServerClient {
  let session: URLSession
  let baseURL: String
  let authToken: String
  /// `X-Beebeeb-Device-Id`: the server keys `photo_backup_state` by it.
  let deviceId: String
  /// The engine's extra headers (provenance, expected user).
  let decorate: (inout URLRequest) -> Void
  /// Called with every response before it is classified (the engine signs
  /// out on a confirmed 409 account mismatch). Throwing aborts the call.
  let inspect: (Int, Data) throws -> Void

  init(
    session: URLSession,
    baseURL: String,
    authToken: String,
    deviceId: String,
    decorate: @escaping (inout URLRequest) -> Void = { _ in },
    inspect: @escaping (Int, Data) throws -> Void = { _, _ in }
  ) {
    self.session = session
    self.baseURL = baseURL
    self.authToken = authToken
    self.deviceId = deviceId
    self.decorate = decorate
    self.inspect = inspect
  }

  private func request(_ path: String, method: String) throws -> URLRequest {
    guard let url = URL(string: "\(baseURL)\(path)") else {
      throw PhotoBackupServerResponses.UnexpectedResponse(statusCode: 0, reason: "invalid server URL")
    }
    var request = URLRequest(url: url)
    decorate(&request)
    request.httpMethod = method
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.setValue(deviceId, forHTTPHeaderField: "X-Beebeeb-Device-Id")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    return request
  }

  private func send(_ request: URLRequest) async throws -> (Int, Data) {
    let (data, response) = try await session.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
    try inspect(statusCode, data)
    return (statusCode, data)
  }

  /// The identifiers of `ids` (at most 500, the route's cap) that the server
  /// already has for this device, out of the Trash, each with its file id
  /// (`PhotoBackupServerResponses.checkBackedUp`; throws `ServerLacksBackedUp`
  /// on a server without task 2036).
  func check(_ ids: [String]) async throws -> [String: String] {
    guard !ids.isEmpty else { return [:] }
    guard ids.count <= PendingUploadServerCheck.maxIdentifiersPerCheck else {
      throw PhotoBackupServerResponses.UnexpectedResponse(statusCode: 0, reason: "photo-backup/check over 500")
    }
    var req = try request("/api/v1/files/photo-backup/check", method: "POST")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["identifiers": ids])
    let (status, data) = try await send(req)
    return try PhotoBackupServerResponses.checkBackedUp(statusCode: status, data: data, requested: ids)
  }

  /// local identifier -> file id for this device (`PhotoBackupServerResponses.identifierMap`).
  func identifierMap() async throws -> [String: String] {
    let (status, data) = try await send(try request("/api/v1/files/photo-backup/identifiers", method: "GET"))
    return try PhotoBackupServerResponses.identifierMap(statusCode: status, data: data)
  }
}
