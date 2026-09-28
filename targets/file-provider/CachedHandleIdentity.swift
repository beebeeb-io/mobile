import Foundation

/// Task 1594 round 3 (Codex T4) — `FileProviderExtension.masterKey()`'s cache
/// validity check, extracted as a pure, dependency-free function (no
/// keychain, no `FileProvider`, no UniFFI) so the exact comparison can be
/// unit tested directly (`CachedHandleIdentityTests`, run via a standalone
/// `swiftc` compile — the project's only XCTest target with no app/test host
/// (`ProvenanceHeadersTests`) does not currently include this extension's
/// sources, and this fix does not extend the `.xcodeproj` to add one; this
/// file's own inclusion in the `BeebeebFileProvider` target's Sources phase
/// is the one addition made, mirroring `CryptoBridge.swift`'s entry exactly).
///
/// BEFORE this fix, `FileProviderExtension.masterKey()`'s fast path compared
/// only the owner record: `cachedForOwner == owner`. `mirrorSessionToAppGroup`
/// (the main app, on every session-token change) clears+rewrites the shared
/// "signed-in user" value THE INSTANT a sign-in completes, while the "owner"
/// record only updates once the main app's OWN ownership precheck/verify
/// round-trip finishes (a network round-trip with real latency). In the
/// window between those two moments — session already B, owner record still
/// A — the owner-only comparison matched (owner unchanged since the handle
/// was cached) and returned A's cached handle for a Files.app request that
/// was, by then, actually B's. Keying the cache on BOTH values closes this:
/// either changing invalidates the cache and forces a fresh
/// `ownershipVerified()` round-trip (`CryptoBridge.loadMasterKeyHandle()`),
/// which is the one place that treats a mismatch as a hard refusal.
enum CachedHandleIdentity {
  static func isStillValid(
    cachedOwner: String?,
    cachedSignedInUser: String?,
    currentOwner: String?,
    currentSignedInUser: String?
  ) -> Bool {
    cachedOwner == currentOwner && cachedSignedInUser == currentSignedInUser
  }
}
