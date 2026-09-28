import Foundation

/// Task 1594 round 4 (Codex P1, FileProviderExtension.swift:73) — whether an
/// HTTP response body is the server's typed 409 `account_mismatch` error
/// (`beebeeb-api/src/auth.rs` `check_expected_user`, task 1554):
/// `{"error": "account_mismatch", "message": "..."}`, returned when the
/// `X-Beebeeb-Expected-User` header a mutating request sent doesn't match the
/// session's real account.
///
/// Extracted as a pure, dependency-free function (no `URLSession`, no
/// keychain — just `Foundation`'s `JSONSerialization`), mirroring
/// `CachedHandleIdentity` (task 1594 round 3, Codex T4), so the exact
/// detection can be unit tested directly via a standalone `swiftc` compile —
/// this project's only XCTest target with no app/test host
/// (`ProvenanceHeadersTests`) does not currently include `ApiClient`'s
/// sources (which pull in `BeebeebKeychainCore` + `ProvenanceHeaders`), and
/// this fix does not extend the `.xcodeproj` to add one. `ApiClient.validate`
/// calls this directly rather than duplicating the parse.
enum AccountMismatchDetection {
  static func isAccountMismatch(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return (object["error"] as? String) == "account_mismatch"
  }
}
