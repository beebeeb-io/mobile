import Foundation

/// Task 1667 round 5 (Codex P1 "Fail closed when the identifier route returns
/// 404"): how `NativeBackupEngine` reads the answers of the two photo-backup
/// map routes. Pure (no URLSession, no SQLite), so
/// `scripts/swift-tests/photo-backup-route-responses-test.swift` drives it with
/// real HTTP responses from a URLProtocol stub, through the real rebuild gate,
/// sign-out flush and reset.
///
/// `GET /api/v1/files/photo-backup/identifiers`: every server this app talks
/// to has the route, and its handler (server `routes/photo_backup.rs`
/// `identifier_map`) never answers 404. A 404 there is a routing or proxy
/// failure, so it is a failed fetch like any other non-2xx:
/// `ManifestRebuildGate` defers and retries after its fetch backoff. It is
/// never an empty map. On an emptied manifest an empty map makes the gate
/// declare the account ready, and the scan then uploads the camera roll again.
///
/// `POST /api/v1/files/photo-backup/mark`: the handler answers 404 when the
/// file is gone or is not the caller's (`ApiError::NotFound`). That is final
/// (nothing to map, asking again would not change it), so it counts as done.
/// Only the API's own body for it counts: any other 404 (a proxy page, an
/// empty body, another shape) is a failure. The row then stays unmarked, the
/// catch-up retries it, and a sign-out keeps it as a pending mark.
enum PhotoBackupServerResponses {
  struct UnexpectedResponse: Error, Equatable {
    let statusCode: Int
    let reason: String
  }

  /// The identifiers route's map (local identifier -> file id). Throws for any
  /// status outside 2xx, 404 included, and for a 2xx body of the wrong shape.
  /// An empty map is only ever a 2xx `{"identifiers": {}}`.
  static func identifierMap(statusCode: Int, data: Data) throws -> [String: String] {
    guard (200..<300).contains(statusCode) else {
      throw UnexpectedResponse(statusCode: statusCode, reason: "photo-backup/identifiers status")
    }
    guard let map = BackupManifestStore.parseIdentifierMap(data) else {
      throw UnexpectedResponse(statusCode: statusCode, reason: "unexpected photo-backup/identifiers body")
    }
    return map
  }

  enum MarkOutcome: Equatable {
    /// 2xx: the server's map has the association.
    case marked
    /// 404 with the API's NotFound body: the file is gone or not this
    /// account's. Nothing to map; done.
    case fileGone
    /// Anything else. Not recorded; retried later, kept through sign-out.
    case failed(statusCode: Int)

    /// Whether `server_marked_at` may be set for the row.
    var recordsServerMark: Bool {
      switch self {
      case .marked, .fileGone: return true
      case .failed: return false
      }
    }
  }

  static func markOutcome(statusCode: Int, contentType: String?, data: Data) -> MarkOutcome {
    if (200..<300).contains(statusCode) { return .marked }
    if statusCode == 404, isApiNotFoundBody(contentType: contentType, data: data) { return .fileGone }
    return .failed(statusCode: statusCode)
  }

  /// `ApiError::NotFound` exactly as the API renders it (server
  /// `beebeeb-api/src/error.rs`, the generic arm of `into_response`:
  /// `ApiError::NotFound => (StatusCode::NOT_FOUND, "not found")`, sent as
  /// `axum::Json(json!({ "error": message }))`): media type
  /// `application/json`, and a JSON object whose ONLY member is
  /// `"error": "not found"`. `NotFoundWithMessage` adds `"message"`; the mark
  /// handler never returns it, so it does not match either.
  static func isApiNotFoundBody(contentType: String?, data: Data) -> Bool {
    guard let contentType,
          let mediaType = contentType.split(separator: ";", omittingEmptySubsequences: false).first,
          mediaType.trimmingCharacters(in: .whitespaces).lowercased() == "application/json" else { return false }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object.count == 1,
          let error = object["error"] as? String else { return false }
    return error == "not found"
  }
}
