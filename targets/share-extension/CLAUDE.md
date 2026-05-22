# share-extension target

Native iOS Share Sheet extension. When the user picks "Save to Beebeeb" from
another app's share sheet, this extension encrypts the shared file in-process
and uploads it directly to the Beebeeb API.

## Files

- `ShareViewController.swift` — UIKit UI: file preview + folder picker + progress
- `ShareUploader.swift` — encrypts via `BeebeebCryptoShim`, uploads via the v2 chunked-upload endpoints
- `SharedKeychain.swift` — reads the wrapped master key from the App Group keychain (no biometric prompt)
- `BeebeebCryptoShim.swift` — Swift wrapper around the UniFFI bindings to `beebeeb-core`
- `FolderFetcher.swift` — `GET /api/v1/files?parent_id=null` for the picker
- `expo-target.config.js` — entitlements + bundle identity, consumed by `@bacons/apple-targets` during `expo prebuild`
- `generated.entitlements` — Expo-generated copy of the entitlements; should be byte-identical to `expo-target.config.js`'s `entitlements:` dict
- `Info.plist` — extension principal class + activation rules

## Source-of-truth files: edit the plugin, not the regenerated copies

This target has both Swift source files AND entitlements in **two places**.
**The Expo plugin at `plugins/share-extension/withShareExtension.js` is the
canonical source.** `expo prebuild` runs that plugin and regenerates the
`ios/BeebeebShare/` copies. Edits made directly to the regenerated copies
survive only until the next `expo prebuild --clean` (which EAS production
builds run automatically).

| What | Edit here (canonical) | Regenerated copy (do not edit) |
|---|---|---|
| Swift sources (`SharedKeychain.swift`, `ShareViewController.swift`, ...) | `targets/share-extension/<name>.swift` | `ios/BeebeebShare/<name>.swift` |
| Entitlements (`keychain-access-groups`, `application-groups`, ...) | inline template inside `plugins/share-extension/withShareExtension.js` | `ios/BeebeebShare/BeebeebShare.entitlements` |
| Info.plist | inline template inside `plugins/share-extension/withShareExtension.js` | `ios/BeebeebShare/Info.plist` |

`targets/share-extension/expo-target.config.js` and
`targets/share-extension/generated.entitlements` exist for documentation /
future migration to the `@bacons/apple-targets` plugin. They are **not in
the active plugin chain** today — `expo prebuild` ignores them for this
target. Don't trust them as source of truth.

To change entitlements: edit the inline template in
`plugins/share-extension/withShareExtension.js`, then run
`npx expo prebuild --platform ios --clean` to regenerate
`ios/BeebeebShare/BeebeebShare.entitlements`. EAS will rerun prebuild on
its own.

Two incidents we shipped through this footgun (2026-05):
- **Task 0433** added `keychain-access-groups` directly to the manual
  entitlements file. The plugin template still emitted only
  `application-groups`, so a subsequent prebuild would have wiped the fix.
- **Task 0444** caught the latent regression and updated the plugin
  template. Without that, every `expo prebuild --clean` was a silent
  security regression on top of 0428 + 0433.

## Plaintext on disk: never

`SharedKeychain.loadMasterKey()` returning `nil` MUST cause the share to
abort with a clear user-visible error. **Do not** write the plaintext file
to the App Group container as a "stage for later" fallback. The old fallback
existed before May 2026 and was removed by task 0428: an uninstall before
the main app drained the staging directory would leak plaintext.

## Team ID

The keychain access group is `R8352WDJJR.io.beebeeb.shared`. The team ID
prefix is hardcoded in `SharedKeychain.accessGroup` to match
`KeychainKeyLoader.accessGroup` in the file-provider target and the
`appleTeamId` in `app.json`. If the team ID ever rotates, update all four
places at once.

## Build & verify

The share extension piggybacks on the main app's `expo prebuild` output and
is built as part of the `Beebeeb` Xcode workspace (scheme: `BeebeebShare`).
Per the workspace rule, build locally on macOS:

```sh
cd repos/mobile
eas build --platform ios --profile production --local --output ./build/beebeeb.ipa
```

After a signed build, verify the entitlements landed correctly:

```sh
codesign -d --entitlements - ./build/Beebeeb.app/PlugIns/BeebeebShare.appex
```

The output must contain both `application-groups` and `keychain-access-groups`.
