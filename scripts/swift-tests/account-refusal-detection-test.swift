import Foundation

// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0) — standalone
// swiftc unit test for `modules/beebeeb-crypto/ios/AccountRefusalDetection.swift`.
// No Xcode project, no simulator, no Pods dependency: pure-Swift decision
// logic, compiled and run directly against the REAL shipped file (copied in
// by `scripts/test-account-refusal-detection.sh`, never re-typed here).
// Mirrors the pattern `AccountMismatchDetection.swift`'s own header comment
// documents ("a standalone swiftc compile can unit-test THIS real, shipped
// file directly").
//
// Run via `scripts/test-account-refusal-detection.sh`. Deliberately NOT
// placed under `modules/beebeeb-crypto/ios/` — that directory is globbed by
// `BeebeebCrypto.podspec` (`source_files = '**/*.{h,m,mm,swift}'`), and this
// file's top-level executable statements would break that build if it were.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

// MARK: - accountRefusalCode

func jsonData(_ obj: [String: Any]) -> Data {
  try! JSONSerialization.data(withJSONObject: obj)
}

expect(
  AccountRefusalDetection.accountRefusalCode(jsonData([
    "error": "trial_cancelled_read_only",
    "message": "You cancelled your trial before it was charged, so uploads are paused.",
  ])) == "trial_cancelled_read_only",
  "trial_cancelled_read_only body recognised"
)

expect(
  AccountRefusalDetection.accountRefusalCode(jsonData([
    "error": "account_lapsed",
    "message": "Your trial has ended and your account is read-only.",
  ])) == "account_lapsed",
  "account_lapsed body recognised"
)

expect(
  AccountRefusalDetection.accountRefusalCode(jsonData([
    "error": "plan_required",
    "message": "Choose a plan to start using Beebeeb.",
  ])) == "plan_required",
  "plan_required body recognised"
)

// Must NEVER collide with account_mismatch — that is a DIFFERENT signal
// (wrong session, not a billing refusal) handled by AccountMismatchDetection.
expect(
  AccountRefusalDetection.accountRefusalCode(jsonData([
    "error": "account_mismatch",
    "message": "This session does not match the account of the vault key on this device.",
  ])) == nil,
  "account_mismatch body is NOT an account refusal code"
)

// The pre-existing 1589 "live foreign lease" 409 on /uploads/init must stay
// a generic retryable failure, not get routed into the pause-and-keep-queue
// path meant for billing refusals.
expect(
  AccountRefusalDetection.accountRefusalCode(jsonData([
    "error": "upload_in_progress",
    "message": "Another upload is already in progress for this file.",
  ])) == nil,
  "unrelated 409 body (upload_in_progress) is NOT an account refusal code"
)

expect(
  AccountRefusalDetection.accountRefusalCode(Data("not json".utf8)) == nil,
  "malformed body returns nil, never crashes"
)

expect(
  AccountRefusalDetection.accountRefusalCode(Data()) == nil,
  "empty body returns nil"
)

// MARK: - isTrialCapQuotaExceeded

expect(
  AccountRefusalDetection.isTrialCapQuotaExceeded(jsonData([
    "error": "quota_exceeded",
    "limit_bytes": 25_000_000_000,
    "used_bytes": 25_000_000_000,
    "is_trial_cap": true,
    "message": "You've reached the 25 GB trial storage cap.",
  ])) == true,
  "quota_exceeded + is_trial_cap:true is recognised"
)

expect(
  AccountRefusalDetection.isTrialCapQuotaExceeded(jsonData([
    "error": "quota_exceeded",
    "limit_bytes": 200_000_000_000,
    "used_bytes": 200_000_000_000,
    "is_trial_cap": false,
  ])) == false,
  "quota_exceeded + is_trial_cap:false is an ORDINARY quota hit, not a refusal"
)

expect(
  AccountRefusalDetection.isTrialCapQuotaExceeded(jsonData([
    "error": "quota_exceeded",
    "limit_bytes": 200_000_000_000,
    "used_bytes": 200_000_000_000,
  ])) == false,
  "quota_exceeded with is_trial_cap omitted defaults to false (older server, never a false positive)"
)

expect(
  AccountRefusalDetection.isTrialCapQuotaExceeded(jsonData([
    "error": "object_budget_exceeded",
    "is_trial_cap": true,
  ])) == false,
  "a DIFFERENT error code is never treated as the trial cap, even if is_trial_cap were somehow present"
)

expect(
  AccountRefusalDetection.isTrialCapQuotaExceeded(Data("not json".utf8)) == false,
  "malformed body returns false, never crashes"
)

// MARK: - Report

if failures.isEmpty {
  print("AccountRefusalDetectionTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("AccountRefusalDetectionTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
