import Foundation

/// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0) — whether an HTTP
/// response body is one of the server's typed account-refusal errors that
/// `signup_plan::ensure_can_upload`/`ensure_can_store`
/// (`beebeeb-api/src/signup_plan.rs`, task 1037, extended by server PR #129)
/// returns on an upload-path 409: a never-paid MANDATED trial cancelled
/// before its first charge (`trial_cancelled_read_only`), a lapsed trial/plan
/// (`account_lapsed`), or an account with no plan at all (`plan_required`).
/// Distinct from `AccountMismatchDetection.isAccountMismatch` (this device's
/// SESSION doesn't match the account) — all three of these mean "this IS the
/// right account, it just cannot store data right now for a billing reason."
///
/// Server evidence (read before writing this file, not assumed): all three
/// codes are `ApiError::ConflictCode` (`error.rs`, renders as plain
/// `StatusCode::CONFLICT` = 409, body `{"error": <code>, "message": ...}`) —
/// `signup_plan.rs`'s `ensure_can_store` (`account_lapsed` / `plan_required`)
/// and `ensure_trial_not_cancelled_read_only` (`trial_cancelled_read_only`,
/// `TRIAL_CANCELLED_READ_ONLY_CODE`). `ensure_can_upload` — the gate actually
/// bound at every upload-path call site (`routes/uploads.rs`'s `init_upload`,
/// `upload_chunk`, AND `complete_upload`; task 1605's server PR #129 review
/// added the re-check to the latter two, not just init, specifically so a
/// session opened before a cancel could not go on uploading after it) — runs
/// both checks. Also covers the sibling 413 `quota_exceeded` with
/// `is_trial_cap: true` (`ApiError::QuotaExceeded`) — the 25 GB never-paid-
/// trial cap, as opposed to an ordinary "you're out of plan storage" quota
/// hit, which the native pipeline continues to treat as a ordinary retryable
/// failure, unchanged by this task (a real out-of-quota IS worth retrying
/// once the user frees space; a trial cap is not, until the first charge).
///
/// Same "duplicated, not shared across the pod/target boundary" rationale as
/// `AccountMismatchDetection.swift` alongside this file — see that file's
/// doc comment for why: only the two extension targets and the app target
/// (via the `BeebeebCrypto` pod) need this, and they sit on different sides
/// of a CocoaPods module boundary `NativeBackupEngine.swift` cannot import
/// across.
enum AccountRefusalDetection {
  /// The three typed 409 codes `ensure_can_upload`/`ensure_can_store` can
  /// return on an upload/share-creation call. `nil` for any other 409 body
  /// — including `account_mismatch` (handled separately, by
  /// `AccountMismatchDetection`) and the pre-existing 1589 "live foreign
  /// lease" 409 on `/uploads/init`, which is NOT one of these codes.
  static let knownRefusalCodes: Set<String> = [
    "trial_cancelled_read_only",
    "account_lapsed",
    "plan_required",
  ]

  static func accountRefusalCode(_ data: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let code = object["error"] as? String else { return nil }
    return knownRefusalCodes.contains(code) ? code : nil
  }

  /// True only for the 413 `quota_exceeded` whose `is_trial_cap` field is
  /// `true` — the 25 GB never-paid-trial cap specifically, never an
  /// ordinary plan-quota hit (which omits the field entirely, or carries it
  /// as `false`).
  static func isTrialCapQuotaExceeded(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    guard (object["error"] as? String) == "quota_exceeded" else { return false }
    return (object["is_trial_cap"] as? Bool) == true
  }
  /// `limit_bytes` of the 413 body: the cap the server enforced (10 GB for a
  /// no-card trial, 25 GB for the older mandated one). `nil` when absent.
  static func trialCapLimitBytes(_ data: Data) -> Int64? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let n = object["limit_bytes"] as? NSNumber else { return nil }
    return n.int64Value
  }

  /// Decimal units, one decimal trimmed: the same output as the JS `formatSize`
  /// (`onboarding/account-summary.ts`) for the sizes a trial cap takes.
  static func formatSize(_ bytes: Int64) -> String {
    let kb = 1_000.0, mb = 1_000_000.0, gb = 1_000_000_000.0, tb = 1_000_000_000_000.0
    func trim(_ n: Double) -> String {
      n == n.rounded() ? String(Int64(n)) : String(format: "%.1f", n).replacingOccurrences(of: ".0", with: "")
    }
    let b = Double(bytes)
    if b >= tb { return "\(trim((b / tb * 10).rounded() / 10)) TB" }
    if b >= gb { return "\(trim((b / gb * 10).rounded() / 10)) GB" }
    if b >= mb { return "\(Int64((b / mb).rounded())) MB" }
    if b >= kb { return "\(Int64((b / kb).rounded())) KB" }
    return "\(bytes) B"
  }

  /// The upload refusal for a never-paid trial's storage cap. Word for word the
  /// JS `trialCapMessage` (`trial-refusals.ts`): the server's number, no call to
  /// action, no price, no plan. A missing or unusable limit keeps 25 GB.
  static func trialCapMessage(limitBytes: Int64?) -> String {
    let bytes = (limitBytes ?? 0) > 0 ? limitBytes! : 25_000_000_000
    return "This account is on the \(formatSize(bytes)) trial storage cap. Free up space to keep uploading."
  }
}
