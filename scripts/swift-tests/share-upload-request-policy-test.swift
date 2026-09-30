import Foundation

// Task 1671 (Issue 2b) — standalone swiftc unit test for
// `targets/share-extension/ShareUploadRequestPolicy.swift`, the pure,
// dependency-free decision logic `ShareUploader` calls (no `URLSession`, no
// `MasterKeyHandle`). Same pattern as
// `scripts/test-account-refusal-detection.sh` / `account-refusal-detection-test.swift`:
// compiles the REAL shipped source file together with this driver and runs
// it directly — no Xcode project, no simulator, no Pods dependency.
//
// Covers `isSuccessResponse` (new: root cause of "Upload failed (HTTP 201)"
// — `ShareUploader.initUpload` used to hardcode `statusCode == 200`, but
// `beebeeb-api/src/routes/uploads.rs`'s `init_upload` returns 201 Created)
// plus the existing `shouldAttachExpectedUserHeader` / `isAccountMismatchResponse`
// for full-file coverage.
//
// Run via `scripts/test-share-upload-request-policy.sh`. Deliberately NOT
// placed under a directory globbed by a podspec (mirrors
// `account-refusal-detection-test.swift`'s own note) — this file's top-level
// executable statements would break such a build.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

func jsonData(_ obj: [String: Any]) -> Data {
  try! JSONSerialization.data(withJSONObject: obj)
}

// MARK: - isSuccessResponse (task 1671, Issue 2b)

// The three v2 chunked-upload steps this decides for
// (beebeeb-api/src/routes/uploads.rs):
//   - init_upload (:924)    → 201 Created
//   - upload_chunk (:1227)  → 200 OK (bare Ok(Json(...)))
//   - complete_upload (:1502) → 200 OK (bare Ok(Json(...)))
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 201) == true,
  "201 Created (init_upload's real status) is a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 200) == true,
  "200 OK (upload_chunk / complete_upload's real status) is a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 204) == true,
  "204 No Content is a success (any 2xx, not a hardcoded allowlist)"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 299) == true,
  "the top of the 2xx range is still a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 199) == false,
  "199 (just below 2xx) is NOT a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 300) == false,
  "300 (just above 2xx) is NOT a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 404) == false,
  "404 is NOT a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 409) == false,
  "409 is NOT a success (account_mismatch / upload_in_progress both route through here as failures)"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 500) == false,
  "500 is NOT a success"
)
expect(
  ShareUploadRequestPolicy.isSuccessResponse(statusCode: 0) == false,
  "0 (URLResponse wasn't even an HTTPURLResponse) is NOT a success"
)

// MARK: - shouldAttachExpectedUserHeader (pre-existing, task 1594 round 5)

expect(
  ShareUploadRequestPolicy.shouldAttachExpectedUserHeader("user-123") == true,
  "a non-empty expectedUser attaches the header"
)
expect(
  ShareUploadRequestPolicy.shouldAttachExpectedUserHeader("") == false,
  "an empty expectedUser omits the header"
)
expect(
  ShareUploadRequestPolicy.shouldAttachExpectedUserHeader(nil) == false,
  "a nil expectedUser omits the header"
)

// MARK: - isAccountMismatchResponse (pre-existing, task 1594 round 5)

expect(
  ShareUploadRequestPolicy.isAccountMismatchResponse(
    statusCode: 409,
    body: jsonData(["error": "account_mismatch", "message": "nope"])
  ) == true,
  "409 + account_mismatch body is recognised"
)
expect(
  ShareUploadRequestPolicy.isAccountMismatchResponse(
    statusCode: 409,
    body: jsonData(["error": "upload_in_progress", "message": "nope"])
  ) == false,
  "409 with a DIFFERENT error code is not an account mismatch"
)
expect(
  ShareUploadRequestPolicy.isAccountMismatchResponse(
    statusCode: 201,
    body: jsonData(["error": "account_mismatch"])
  ) == false,
  "a non-409 status is never an account mismatch, even with a matching body"
)

// MARK: - Report

if failures.isEmpty {
  print("ShareUploadRequestPolicyTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ShareUploadRequestPolicyTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
