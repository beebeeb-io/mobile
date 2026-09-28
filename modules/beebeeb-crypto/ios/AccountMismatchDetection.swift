import Foundation

/// Task 1599 — whether an HTTP response body is the server's typed 409
/// `account_mismatch` error (`beebeeb-api/src/auth.rs` `check_expected_user`,
/// task 1554): `{"error": "account_mismatch", "message": "..."}`, returned
/// when the `X-Beebeeb-Expected-User` header a mutating request sent doesn't
/// match the session's real account.
///
/// `targets/file-provider/AccountMismatchDetection.swift` implements this
/// exact check already (task 1594 round 4), but is NOT visible to
/// `NativeBackupEngine.swift`: that file ships inside the separate
/// `BeebeebCrypto` CocoaPods module
/// (`modules/beebeeb-crypto/ios/BeebeebCrypto.podspec`'s own `source_files`
/// glob, scoped to this directory), a different target/pod boundary than the
/// File Provider / Share Extension targets the other file compiles into
/// (verified against `ios/Beebeeb.xcodeproj/project.pbxproj` — its two
/// `PBXBuildFile`/`Sources` entries for that file are both extension
/// targets, never the app target `NativeBackupEngine` links from).
///
/// Same detection logic, duplicated rather than shared across that pod/
/// target boundary — kept as its own file, and internal (not `private`),
/// exactly like the File Provider copy, so a standalone `swiftc` compile can
/// unit-test THIS real, shipped file directly (mirrors task 1594 round 4's
/// `.claude/tasks/_qa-evidence/1594/r4-swift-test/` — see
/// `.claude/tasks/_qa-evidence/1599/swift-test/`).
enum AccountMismatchDetection {
  static func isAccountMismatch(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return (object["error"] as? String) == "account_mismatch"
  }
}
