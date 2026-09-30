import Foundation

/// Task 1594 round 5 ("[P0] Mobile backup created a folder tree sealed with
/// a key that is not the account's" — follow-up recorded in round 4's Notes:
/// `ShareUploader.swift` has its own upload networking and does not reuse
/// `targets/file-provider/ApiClient.swift`, so it never got the
/// `X-Beebeeb-Expected-User` header (task 1554) or the 409 `account_mismatch`
/// handling `ApiClient.swift` added in round 4).
///
/// The two decisions `ShareUploader` needs — "should this request carry the
/// header" and "is this response the server's typed ownership refusal" —
/// are extracted here as pure, dependency-free functions (no `URLSession`,
/// no `MasterKeyHandle`, no `ChunkEncryptorHandle`) so they can be unit
/// tested via a standalone `swiftc` compile. `ShareUploader.swift` itself
/// cannot be compiled that way (it pulls in the whole crypto/network stack),
/// and this project's only host-less XCTest target (`ProvenanceHeadersTests`)
/// does not include the Share Extension's sources — the same situation
/// `CachedHandleIdentity.swift` (round 3) and `AccountMismatchDetection.swift`
/// (round 4) were extracted from, and reusing `AccountMismatchDetection`
/// directly here (rather than re-parsing the body a second way) is why this
/// file is wired into the SAME shared-file mechanism (see
/// `plugins/share-extension/withShareExtension.js`'s `CRYPTO_SHARED_FILES`
/// for `AccountMismatchDetection.swift`) instead of copied.
enum ShareUploadRequestPolicy {
  /// Whether `expectedUser` should be attached as the `X-Beebeeb-Expected-User`
  /// header. Mirrors `ApiClient.authedRequest`'s own gate exactly: `nil` or
  /// empty (no verified owner yet) omits the header, unchanged pre-1594
  /// behaviour.
  static func shouldAttachExpectedUserHeader(_ expectedUser: String?) -> Bool {
    guard let expectedUser else { return false }
    return !expectedUser.isEmpty
  }

  /// Whether an HTTP response is the server's typed 409 `account_mismatch`
  /// (`beebeeb-api/src/auth.rs` `check_expected_user`) — a clean,
  /// non-retryable ownership failure the caller must not confuse with a
  /// generic upload error worth retrying with the same stale key.
  static func isAccountMismatchResponse(statusCode: Int, body: Data) -> Bool {
    statusCode == 409 && AccountMismatchDetection.isAccountMismatch(body)
  }

  /// Task 1671 (Issue 2b) — whether an HTTP status code is a SUCCESS for a
  /// step of the v2 chunked-upload contract
  /// (`beebeeb-api/src/routes/uploads.rs`). The three steps do not all use
  /// the same status code: `init_upload` (:924) returns `201 Created`
  /// (correct REST usage — it creates the file + upload_session rows), while
  /// `upload_chunk` and `complete_upload` both return a bare `Ok(Json(...))`,
  /// which Axum turns into `200 OK`. Pre-fix, `ShareUploader.initUpload`
  /// checked `statusCode == 200` only, so a totally successful init was
  /// treated as a failure — the exact "Upload failed (HTTP 201): ..." Guus
  /// hit on TestFlight build 230, which also stranded a file row + upload
  /// session server-side because no chunk was ever sent.
  ///
  /// Accept the whole 2xx range (matching `ApiClient.validate` in
  /// `targets/file-provider/ApiClient.swift:249` and `res.ok` in
  /// `src/lib/api.ts`'s `initUploadV2`) rather than hardcoding `200` or
  /// `201` — future server-side status changes for any step stay compatible
  /// without another client-side guess.
  static func isSuccessResponse(statusCode: Int) -> Bool {
    (200..<201).contains(statusCode)
  }
}
