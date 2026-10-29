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

  /// Task 1667 round 11: the server answered `/photo-backup/check` without
  /// the `backed_up` field (a server without task 2036). The client cannot
  /// tell a trashed backup from a live one there, so it promotes nothing and
  /// uploads nothing for that batch (fail closed, fetch backoff).
  struct ServerLacksBackedUp: Error, Equatable {}

  /// Task 1667 round 11 (review finding 2, server task 2036):
  /// `POST /api/v1/files/photo-backup/check` for this device. The server
  /// excludes files in the Trash and answers
  /// `{"already_backed_up": [...], "needs_backup": [...],
  ///   "backed_up": [{"local_identifier": ..., "file_id": ...}]}`
  /// (`already_backed_up` stays for older clients). Returns `backed_up` as
  /// local identifier -> file id: the ONLY entries the client may promote,
  /// with that file id.
  ///
  /// Throws `ServerLacksBackedUp` when the body is otherwise valid but has no
  /// `backed_up` field. Throws `UnexpectedResponse` for any status outside
  /// 2xx (404 included) and for a body that is not exactly that shape: a
  /// non-string or empty entry, an identifier the request did not ask about,
  /// one in both lists, a requested identifier in neither, a `backed_up`
  /// entry without a non-empty string `local_identifier` and `file_id`, an
  /// identifier twice in `backed_up`, or `backed_up` naming a different set
  /// of identifiers than `already_backed_up` (the body contradicts itself).
  /// A body the client cannot read is never "nothing backed up".
  static func checkBackedUp(statusCode: Int, data: Data, requested: [String]) throws -> [String: String] {
    guard (200..<300).contains(statusCode) else {
      throw UnexpectedResponse(statusCode: statusCode, reason: "photo-backup/check status")
    }
    let bad = UnexpectedResponse(statusCode: statusCode, reason: "unexpected photo-backup/check body")
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let hitsRaw = object["already_backed_up"] as? [Any],
          let needsRaw = object["needs_backup"] as? [Any] else { throw bad }
    let asked = Set(requested)
    func strings(_ raw: [Any]) throws -> Set<String> {
      var out = Set<String>()
      for value in raw {
        guard let s = value as? String, !s.isEmpty, asked.contains(s) else { throw bad }
        out.insert(s)
      }
      return out
    }
    let hits = try strings(hitsRaw)
    let needs = try strings(needsRaw)
    guard hits.isDisjoint(with: needs), hits.union(needs) == asked else { throw bad }
    guard let backedUpValue = object["backed_up"] else { throw ServerLacksBackedUp() }
    guard let backedUpRaw = backedUpValue as? [Any] else { throw bad }
    var backedUp: [String: String] = [:]
    for entry in backedUpRaw {
      guard let pair = entry as? [String: Any],
            let local = pair["local_identifier"] as? String, !local.isEmpty, asked.contains(local),
            let fileId = pair["file_id"] as? String, !fileId.isEmpty,
            backedUp[local] == nil else { throw bad }
      backedUp[local] = fileId
    }
    guard Set(backedUp.keys) == hits else { throw bad }
    return backedUp
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

  /// Task 1667 round 15 (review of mobile#182 at dd97f2ac, P1 item 2 and P2
  /// item 3): the answer of `GET /api/v1/files/{id}` for an upload this
  /// device opened (server `routes/files.rs` `get_file`: a JSON object with
  /// boolean `is_uploading` and `is_trashed`; `ApiError::NotFound` for an
  /// unknown id or another account's file). Only the API's own answer counts.
  /// The sign-in resolution and the sign-out flush read it through
  /// `NativeBackupEngine.inspectExistingUpload`, and so does the upload
  /// resume path.
  enum ExistingUpload: Equatable {
    /// 2xx, `is_uploading` false, not in the Trash: the upload is complete.
    case complete
    /// 2xx, `is_uploading` false, `is_trashed` true: complete, but the file
    /// is in the Trash, so the photo is NOT backed up (server 2036, round 13
    /// m4). The resolution and the flush neither promote nor mark it.
    case completeInTrash
    /// 2xx, `is_uploading` true: the upload never completed.
    case uploading
    /// 404 with the API's NotFound body: no such file for this account.
    case gone
  }

  /// A 429. `retryAfter` is the server's `Retry-After` in seconds, when it
  /// sent a number.
  struct RateLimited: Error, Equatable {
    let retryAfter: TimeInterval?
  }

  /// Fails closed: throws `RateLimited` for a 429 and `UnexpectedResponse`
  /// for anything that is not the API's own answer: a 404 without the API's
  /// NotFound body (an HTML or empty page from a proxy or the edge), a 2xx
  /// whose body is not a JSON object with boolean `is_uploading` and
  /// `is_trashed`, any other status (5xx included). The caller then keeps
  /// the row and defers; it never reads "not complete" from such an answer
  /// (that would upload the photo a second time).
  static func existingUpload(
    statusCode: Int, contentType: String?, retryAfter: String?, data: Data
  ) throws -> ExistingUpload {
    if statusCode == 429 {
      let seconds = retryAfter.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
      throw RateLimited(retryAfter: seconds.flatMap { $0 >= 0 && $0.isFinite ? $0 : nil })
    }
    if statusCode == 404 {
      guard isApiNotFoundBody(contentType: contentType, data: data) else {
        throw UnexpectedResponse(statusCode: statusCode, reason: "files/{id} 404 without the API's NotFound body")
      }
      return .gone
    }
    guard (200..<300).contains(statusCode) else {
      throw UnexpectedResponse(statusCode: statusCode, reason: "files/{id} status")
    }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let isUploading = jsonBool(object["is_uploading"]),
          let isTrashed = jsonBool(object["is_trashed"]) else {
      throw UnexpectedResponse(statusCode: statusCode, reason: "unexpected files/{id} body")
    }
    if isUploading { return .uploading }
    return isTrashed ? .completeInTrash : .complete
  }

  /// A JSON `true` / `false` only (JSONSerialization also bridges the numbers
  /// 0 and 1 to Bool).
  private static func jsonBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
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
