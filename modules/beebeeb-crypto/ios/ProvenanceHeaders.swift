import Foundation

/// Applies the writer-provenance headers (`X-Beebeeb-Client` / `X-Beebeeb-Client-Version`) that the
/// JS client already sends via `mobileClientHeaders()` in `src/lib/api.ts` — but for the native Swift
/// upload/download/backup stack, which builds its own `URLRequest`s outside the JS bridge and was
/// sending neither header (task 1439; server stores these as `object_versions.created_by_client` /
/// `created_by_client_version`).
///
/// This is the ONLY place the two header names, or the `"mobile-ios"` client literal, may appear —
/// every native `URLRequest` construction site calls `ProvenanceHeaders.apply(to:)` instead of setting
/// these headers itself.
///
/// `Bundle.main` correctly resolves to whichever target this file is COMPILED INTO — the main app
/// target (via the `BeebeebCrypto` CocoaPods glob), the Share Extension target, and the File Provider
/// Extension target each read their own bundle's `Info.plist`, so each extension reports its own
/// build's version rather than the host app's. (The main app target's value is what Settings → About
/// shows.)
enum ProvenanceHeaders {
    /// Matches `X-Beebeeb-Client: mobile-ios` sent by `mobileClientHeaders()` in `src/lib/api.ts`
    /// (the `Platform.OS === 'ios'` branch). The native Swift stack is iOS-only — the Android crypto
    /// module is a stub (see the mobile repo's CLAUDE.md, "Platform status") — so there is no
    /// `mobile-android` case here.
    static let clientName = "mobile-ios"

    /// Matches JS's `MOBILE_CLIENT_VERSION = Constants.expoConfig?.version ?? '1.0.0'` in
    /// `src/lib/api.ts` — the `CFBundleShortVersionString` app version only, no build number,
    /// read from whichever bundle this code is compiled into.
    static var clientVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0.0"
    }

    /// Sets both writer-provenance headers on `request`. Safe — and intended — to call on every
    /// native `URLRequest`, including GET/download/metadata requests, not just uploads: a
    /// consistent client signature on every native call is the point, since the server-side
    /// diagnostics this feeds (pre-mortem 07's blast-radius query) key off the writer, and an
    /// inconsistently-tagged native stack is as blind as an untagged one.
    static func apply(to request: inout URLRequest) {
        request.setValue(clientName, forHTTPHeaderField: "X-Beebeeb-Client")
        request.setValue(clientVersion, forHTTPHeaderField: "X-Beebeeb-Client-Version")
    }
}
