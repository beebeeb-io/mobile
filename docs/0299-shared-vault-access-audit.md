# 0299 Shared Vault Access Audit

Date: 2026-05-13
Scope: iOS main app, Share Extension, File Provider, and Widget App Group/keychain boundaries.

## Shared Identifiers

- App Group: `group.io.beebeeb.shared`
- Shared keychain access group: `$(AppIdentifierPrefix)io.beebeeb.shared`, resolved in code as `R8352WDJJR.io.beebeeb.shared`
- Main app bundle: `io.beebeeb.app`
- Share Extension bundle: `io.beebeeb.app.share`
- File Provider bundle: `io.beebeeb.app.file-provider`
- Widget bundle: `io.beebeeb.app.widget`
- File Provider domain: `io.beebeeb.files`

## Inventory

| Surface | Shared material | Source |
| --- | --- | --- |
| Main app entitlements | App Group plus shared keychain group | `app.json`, `ios/Beebeeb/Beebeeb.entitlements` |
| Share Extension | Writes plaintext inbound share payloads and JSON manifests to `IncomingShares/` in the App Group. It does not read the session token or master key. | `plugins/share-extension/ShareViewController.swift` |
| Main app share drain | Reads `IncomingShares/`, copies payloads to main-app `PendingShareUploads/`, encrypts/uploads only when the vault is unlocked, and acknowledges App Group copies only after upload. | `modules/beebeeb-crypto/ios/PendingSharesAccess.swift`, `plugins/share-extension/PendingSharesHandler.ts`, `src/App.tsx` |
| File Provider auth | Reads `io.beebeeb.sessionToken` and `io.beebeeb.apiBaseUrl` from App Group `UserDefaults`. | `plugins/file-provider/FileProviderAPIClient.swift`, `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift` |
| File Provider unlock gate | Reads `io.beebeeb.fileProvider.enabled`, `io.beebeeb.fileProvider.requireDeviceAuth`, and `io.beebeeb.fileProvider.unlockedUntilMs` from App Group `UserDefaults`. | `plugins/file-provider/FileProviderAPIClient.swift`, `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift` |
| File Provider crypto | Reads the Secure Enclave-wrapped master key from the shared keychain group and derives per-file keys in the extension process. | `plugins/file-provider/FileProviderCrypto.swift`, `modules/beebeeb-crypto/ios/KeychainManager.swift` |
| Widget | Reads `widget-data.json` from the App Group. The file contains storage usage and recent file display names only. | `src/utils/widgetData.ts`, `ios/BeebeebWidget/BeebeebWidget.swift` |
| Simulator fallback | The main app may store a raw master key in main-app sandbox/SecureStore for simulator/dev unlock, but it no longer mirrors raw key material into App Group `UserDefaults` or App Group files. | `src/lib/crypto-context.tsx`, `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift`, `plugins/file-provider/FileProviderCrypto.swift` |

## Dormant Native Target Templates

The repo also contains `targets/file-provider/` and `targets/share-extension/` source trees. The checked-in Xcode project currently wires the File Provider target to `plugins/file-provider/*.swift` and the Share Extension target to `ios/BeebeebShare/ShareViewController.swift`; it does not use the `targets/*` Swift sources. Before reusing those templates, reconcile their key labels and extension keychain behavior with this audit.

## Findings And Fixes

- Verified File Provider entitlements: the active checked-in extension entitlement file includes the shared keychain access group required by `FileProviderCrypto`.
- Removed the debug simulator App Group raw-master-key fallback. Older builds used `io.beebeeb.simulatorFileProviderMasterKey` in App Group `UserDefaults`; current native code removes that value and returns `false`.
- Tightened cleanup on sign-out and lock:
  - `clearFileProviderSharedState` clears File Provider unlock state, extension-readable session token, API base URL, stale simulator master-key mirror, and File Provider cache files.
  - Sign-out also discards pending Share Extension payloads and clears widget data.
  - Unlock paths re-mirror the session token before opening the File Provider access window.

## Legacy Keychain Migration

`KeychainManager.load(label:)` first queries the shared access group and then falls back to a legacy non-access-group item when the shared item is missing. When a legacy wrapped key decrypts successfully, it calls `store(masterKeyBytes:label:)`, which writes the same master key into the shared access group. `delete()` removes both shared and legacy keychain entries.

This is source-verified but still needs physical-device verification with a vault created before the shared access-group change.

## Platform Constraint

The File Provider extension is `com.apple.fileprovider-nonui`, so Files.app cannot present a Beebeeb-specific password prompt inside Files. The implemented path is app-level opt-in plus device-owner authentication in Beebeeb, then a short App Group unlock window for Files integration. Full end-to-end File Provider crypto verification remains physical-device-only because the simulator cannot exercise Secure Enclave-backed shared keychain behavior.

## Verification Status

- Source audit complete for App Group paths, keychain groups, session mirroring, sign-out cleanup, Share Extension dropbox handling, File Provider access gating, and widget storage.
- Simulator verification can validate buildability and source/App Group cleanup behavior, but it cannot prove physical Secure Enclave shared-keychain access.
- Physical iPhone verification remains required before moving 0299 to verified.
