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

## Entitlements: dual-file fragility

There are **two** entitlement files for this target and Xcode signs against
the manual one, not the Expo-generated one:

- `repos/mobile/ios/BeebeebShare/BeebeebShare.entitlements` (used at build time, signed into the `.appex`)
- `repos/mobile/targets/share-extension/generated.entitlements` (output of `expo prebuild`)
- `repos/mobile/targets/share-extension/expo-target.config.js` (canonical source)

If you change `expo-target.config.js`, you must either:

1. Re-run `npx expo prebuild` (which overwrites `ios/BeebeebShare/BeebeebShare.entitlements`), or
2. Manually mirror the change into `ios/BeebeebShare/BeebeebShare.entitlements`.

The May 2026 incident (task 0433) was that `expo-target.config.js` had
`keychain-access-groups` but the manual file did not — the Share Extension
shipped without keychain entitlement and `SharedKeychain.loadMasterKey()`
returned `nil` for every fresh install. Always keep both files in sync.

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
