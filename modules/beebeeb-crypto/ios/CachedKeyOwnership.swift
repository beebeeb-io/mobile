import Foundation

/// Task 1599 followups (item 3): the pure "may this cached master-key handle
/// be adopted for this account?" decision, extracted as a standalone,
/// independently-testable type — mirrors `AccountMismatchDetection.swift`'s
/// precedent (a pure decision pulled out of `NativeBackupEngine.swift` so it
/// is `swiftc`-testable without the full Keychain/UniFFI dependency graph
/// `BeebeebCryptoBridge`/`NativeBackupEngine` themselves carry).
///
/// `cachedOwnerId` is whatever `BeebeebCryptoBridge.cachedMasterKeyOwnerId()`
/// returns — `nil` means the cache was populated by a path with no
/// JS-confirmed owner attached (see that function's doc comment).
/// `currentAccountId` is the account the caller is trying to adopt the
/// handle FOR — always non-empty at the one real call site
/// (`NativeBackupEngine`'s background-task adoption gates this behind
/// `!accountId.isEmpty` before it ever reaches here).
///
/// An unconfirmed (`nil`) owner refuses, deliberately — this is a change
/// from the pre-1599 behavior of adopting any cached handle unconditionally.
/// A handle cached without a known owner is exactly the "stale/foreign key"
/// shape task 1594's original bug was, so this reader must not trust it just
/// because SOMETHING is cached.
enum CachedKeyOwnership {
  static func mayAdopt(cachedOwnerId: String?, currentAccountId: String) -> Bool {
    guard let cachedOwnerId, !cachedOwnerId.isEmpty else { return false }
    return cachedOwnerId == currentAccountId
  }
}
