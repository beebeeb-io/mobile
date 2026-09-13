# 0300 Plaintext Lifecycle Audit

Date: 2026-09-13
Scope: every path the iOS app writes outside `Library/Caches/`, plus the two plaintext paths inside it.
Companion: `docs/0299-shared-vault-access-audit.md` (App Group / keychain boundary — not repeated here).
Enforced by: `modules/beebeeb-crypto/ios/PlaintextStorageProtection.swift`, `src/lib/plaintext-storage.test.ts`.
Evidence: `docs/_qa-evidence/0300-backup-exclusion-simulator.txt`.

## Why this exists

Before this audit, `grep -rn 'isExcludedFromBackup'` over the whole repo returned zero matches. iOS
backs up `Documents/`, `Library/Application Support/`, and App Group containers by default, so every
decrypted byte the app persisted outside `Library/Caches/` was inside the user's iCloud and Finder
backups. A backup that captures plaintext is permanently outside Beebeeb's control.

## Inventory

| Path | Contents | Source | Backed up before | Now |
| --- | --- | --- | --- | --- |
| `Documents/beebeeb-thumbnails-v3/` | Decrypted thumbnail WebP bytes | `modules/beebeeb-crypto/ios/ThumbnailService.swift:305-310`, `src/lib/thumbnail-cache.ts:26` | Yes — plaintext images | Excluded + `CompleteUntilFirstUserAuthentication` (creation-site call + launch `hardenAll()`) |
| `Documents/beebeeb-photokit-cache/` | Decrypted PhotoKit PNG renders | `modules/beebeeb-crypto/ios/PhotoKitResolver.swift:16-21,80` | Yes — plaintext images | Excluded + protected (creation-site call + launch `hardenAll()`) |
| `Documents/beebeeb-name-cache-v1.json` | Decrypted file names + mime | `src/lib/name-cache.ts:1-14,30` | Yes — plaintext metadata | Excluded + protected (JS write triggers `notePlaintextPathCreated()` + launch `hardenAll()`) |
| `Documents/beebeeb-file-index-cache-v1.json` | File index rows; names remain ciphertext (`name_encrypted`) | `src/lib/file-index-cache.ts:6,10-12` | Yes — ids/sizes only | Excluded + protected |
| `Documents/local-id-map.json` | fileId to PHAsset localIdentifier map | `src/lib/local-identifier-map.ts:59,262` | Yes — metadata | Excluded + protected (JS write triggers `notePlaintextPathCreated()` + launch `hardenAll()`) |
| `Documents/PendingShareUploads/` | Share-sheet payloads staged BEFORE encryption | `modules/beebeeb-crypto/ios/PendingSharesAccess.swift:9-13,178-183` | Yes — plaintext file bodies | Excluded + protected (creation-site call + launch `hardenAll()`) |
| App Group `IncomingShares/` | Share Extension inbound payloads, plaintext | `modules/beebeeb-crypto/ios/PendingSharesAccess.swift:9-10,165-170`; `docs/0299-shared-vault-access-audit.md` | Yes — plaintext file bodies | Excluded + protected (creation-site call + launch `hardenAll()`) |
| `Documents/offline/` | Offline copies — the SAME `nonce\|\|ct\|\|tag` blobs the server stores, NOT decrypted at rest | `src/lib/offline-manager.ts:14,79,283` | Yes — ciphertext only | Excluded (backup size, not confidentiality) — JS write triggers `notePlaintextPathCreated()` + launch `hardenAll()` |
| `Documents/thumbnail_queue.sqlite` | Thumbnail work queue | `modules/beebeeb-crypto/ios/ThumbnailQueueDB.swift:23-26` | Yes — metadata | Excluded + protected (registry + launch `hardenAll()` — no creation-site call added; the file is created before the registry's directory-kind entries would help, so launch-time protection is the mechanism here) |
| `Documents/SQLite/beebeeb-backup.db` | Backup-insights DB read by React Native | `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:2994-2998` | Yes — metadata | Excluded + protected (directory; registry + launch `hardenAll()`) |
| `Application Support/NativeBackupStaging/` | Staged `.enc` chunks awaiting upload | `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:27,2258-2261` | Yes — ciphertext, unbounded size | Excluded + protected (registry + launch `hardenAll()`) |
| `Application Support/Beebeeb/backup.db` | PhotoBackupManager state | `modules/beebeeb-crypto/ios/PhotoBackupManager.swift:182-186` | Yes — metadata | Excluded + protected (directory; registry + launch `hardenAll()`) |
| `Application Support/<bundle-id>/RCTAsyncLocalStorage_V1/` | AsyncStorage key-value store | `node_modules/@react-native-async-storage/async-storage/ios/RNCAsyncStorage.mm:17,129-148` | Yes | Excluded + protected (registry + launch `hardenAll()`) |
| App Group `widget-data.json` | Storage totals + recent display names | `src/utils/widgetData.ts:11,36-40`; `docs/0299-shared-vault-access-audit.md` | Yes — plaintext names | Excluded + protected — the one App Group write reachable only via `Paths.appleSharedContainers` rather than `FileSystem.documentDirectory`; `writeWidgetData()` calls `notePlaintextPathCreated()` after every write |
| `Caches/preview/` | Decrypted preview files | `src/lib/native-decrypt.ts:43,575-584` | No — iOS excludes `Caches/` | Accepted, see below |
| `Caches/*` one-shot exports (share, save, proof, zip-extract, upload staging) | Decrypted bytes for share/save flows | `src/screens/FilesScreen.tsx`, `src/screens/SharedViewScreen.tsx`, `src/components/preview/ZipRenderer.tsx`, `src/lib/api.ts` | No — iOS excludes `Caches/` | Accepted, see below |
| `Documents/beebeeb-simulator-master-key.txt` | RAW master key, base64 | `src/lib/crypto-context.tsx:74,88-96,141-142`; `modules/beebeeb-crypto/ios/BeebeebCryptoBridge.swift:165-175` | Yes, on simulators only | Excluded + protected (registry + launch `hardenAll()`); gate pinned by `src/lib/software-vault-gate.test.ts` + `src/lib/software-vault-gate-device.test.ts` |
| App Group `pinned/` | Decrypted, pinned Files.app content — a **separate compiled `.appex` target**, not the main app | `targets/file-provider/Constants.swift:74-80`, `targets/file-provider/FileProviderExtension.swift:107-112` | Yes — plaintext images/documents, indefinitely retained | Excluded + protected (registry entry + target-membership fix, Task 2) |
| App Group `temp/` | Decrypted transient blobs returned to the system from `fetchContents` | `targets/file-provider/Constants.swift:82-87`, `targets/file-provider/FileProviderExtension.swift:97-108` | Yes — plaintext, and never deleted after use (see Findings) | Excluded + protected |

## Findings And Fixes

- Decrypted thumbnails and decrypted PhotoKit renders were both written to `Documents/` and were both
  in every iCloud and Finder backup. Fixed by `PlaintextStorageProtection.protect(_:)` at the
  creation site and by `hardenAll()` at launch, which repairs existing installs with no migration.
- The PhotoKit PNG cache was not named in any prior task, finding, or document. It was found by
  enumerating `documentDirectory` uses rather than by following the reported symptom.
- The **File Provider extension** (`targets/file-provider/`, compiled into the separate
  `BeebeebFileProvider.appex` target) decrypts on demand for Files.app/Quick Look and writes the
  result into App Group `pinned/` and `temp/` — both backed up, and neither was in any prior report.
  Because this target does not compile the `beebeeb-crypto` Expo module, fixing it required adding
  `PlaintextStorageProtection.swift` (and, once discovered by a real `xcodebuild` failure — see
  below — `RuntimeTrace.swift`, its own dependency) to the extension's own compiled sources, not
  just calling an existing function from a new call site.
- **A real build failure caught a gap the plan missed:** `PlaintextStorageProtection.swift` calls
  `RuntimeTrace.event(...)` on a protection failure. `RuntimeTrace.swift` lives in
  `modules/beebeeb-crypto/ios/` and is compiled into the main app via the CocoaPods glob, but the
  `BeebeebFileProvider` extension target only had `PlaintextStorageProtection.swift` added to its
  sources — not `RuntimeTrace.swift`. `xcodebuild` failed with `cannot find 'RuntimeTrace' in scope`
  for the extension target specifically (the main app target compiled fine, since its Pod glob picks
  up every file in the directory). Fixed by adding `RuntimeTrace.swift` to the extension's compiled
  sources too, the same pbxproj pattern used for `PlaintextStorageProtection.swift`. `RuntimeTrace`
  depends only on `Foundation` and `os.log`, both extension-safe, so no further linkage was needed.
- **Open finding, not fixed by this work:** `FileProviderExtension.swift` never deletes a `temp/`
  entry after handing it to the system from `fetchContents`. Excluding `temp/` from backup (this
  item) stops it from leaving the device; it does not stop it from accumulating on the device. This
  is a lifecycle bug, filed as a fast-follow rather than expanded into this item's scope.
- Pre-encryption share staging (`PendingShareUploads/` and App Group `IncomingShares/`) held full
  plaintext file bodies until upload completed. Both are now excluded and protected.
- The pre-mortem brief stated that offline staging holds "full decrypted files". It does not:
  `offline-manager.ts:14` and the `createDownloadResumable` call at `:283` write the server's
  ciphertext blob unchanged, and decryption happens into `Caches/preview/`. Recorded here so the
  claim is not repeated.
- No explicit file-protection class was set anywhere (`grep -rn 'FileProtection' modules` returned 0).
  All registry paths now carry `NSFileProtectionCompleteUntilFirstUserAuthentication` — not
  `.complete`, because `NativeBackupEngine` uploads from a background URLSession and
  `PhotoBackupManager` runs on PHKit callbacks while the device is locked.
- The plan's Task 3 wiring list named four JS writers (`name-cache.ts`, `file-index-cache.ts`,
  `thumbnail-cache.ts`, `offline-manager.ts`) plus the App Group write in `widgetData.ts`, but missed
  a sixth: `src/lib/local-identifier-map.ts:262` also writes a `documentDirectory` file
  (`local-id-map.json`) and had no `notePlaintextPathCreated()` call. Found by re-deriving the writer
  list from the registry rather than trusting the plan's enumeration, and fixed the same way as the
  other five.
- Not every registry directory got a creation-site `protect()` call — `NativeBackupEngine.swift`'s
  `SQLite/` and `NativeBackupStaging/` directories, `PhotoBackupManager.swift`'s `Beebeeb/` directory,
  and `ThumbnailQueueDB.swift`'s queue file rely on `hardenAll()` at launch alone (they are not on the
  plan's Task 2 call-site list). This is intentional, not an oversight: `hardenAll()` runs first in
  `BeebeebAppDelegate.application(_:didFinishLaunchingWithOptions:)`, before any of these subsystems
  gets a chance to write, and it creates-then-protects every directory-kind registry entry
  unconditionally — so these paths are excluded from the very first launch of the new build, with no
  window where they exist unprotected. A creation-site call is redundant defense-in-depth for paths
  that are already covered at launch; it was added only where the spec's acceptance criteria named a
  specific line (`ThumbnailService.swift:306`, `PhotoKitResolver.swift:19`,
  `PendingSharesAccess.swift:169,181`, and the two File Provider directories).

## Accepted Plaintext

- **`Caches/preview/` and the one-shot `Caches/` exports.** Decrypted bytes are unavoidable for
  QuickLook, the share sheet, and save-to-Photos. `Library/Caches` is excluded from iOS backups by
  the system, is purged under storage pressure, and `native-decrypt.ts` prunes the preview cache
  itself. Retention rule: preview entries live until the pruner evicts them; one-shot export files
  are written per action and are not re-read. No change.
- **`Documents/beebeeb-simulator-master-key.txt`.** Kept because simulator QA is how most of this
  repo is verified. It is written only when `usesSoftwareVaultFallback()` is true, i.e.
  `!Device.isDevice`. `src/lib/software-vault-gate.test.ts` (simulator scenario) and
  `src/lib/software-vault-gate-device.test.ts` (real-hardware negative) fail if that gate ever admits
  real hardware. Retention rule: overwritten on each key store; removed with the app container.
- **`Documents/offline/`.** Ciphertext, so not a confidentiality concern; excluded anyway because a
  large pinned set would otherwise be duplicated into the user's iCloud quota.

## Platform Constraint

Backup exclusion is a per-path resource value; it cannot be declared in `Info.plist` or in
`app.json`. It must be set from code on each path, and it must be re-applied after a path is
recreated — which is why `hardenAll()` runs on every cold launch and every JS writer calls
`notePlaintextPathCreated()`. Verification of the real backup contents (as opposed to the resource
value) requires a physical device: an encrypted local backup taken in Finder, then the Beebeeb app
container inspected for the six paths named in the task file's Guus-gated verification step.

## Verification Status (2026-09-13)

- Real `xcodebuild` build of this branch succeeded (`BUILD SUCCEEDED`, `BeebeebFileProvider.appex`
  rebuilt, 0 errors), installed and launched on simulator `bb-qa-2`
  (`D7A6B303-B138-4EF5-ABEC-E23AEEE503FC`).
- `scripts/verify-backup-exclusion.sh` against the real app container: **13 of 13 checkable
  registry paths EXCLUDED, 0 LEAKING** — this is every directory-kind entry plus the file-kind
  entries this simulator already carried from prior sessions, all protected by `hardenAll()` at
  launch alone, before any sign-in. Evidence:
  `docs/_qa-evidence/1374/verify-backup-exclusion-partial-post-launch.txt`.
- 4 of 17 entries (App Group `IncomingShares`, `widget-data.json`, `pinned`, `temp`) are unverified
  on simulator — `SKIP (not created yet)` — because creating them needs a signed-in session
  (Photos/Settings screens) plus Files.app File Provider access, and neither could be driven this
  session: the machine-wide Maestro driver was contended by another live lane throughout, and the
  QA account (`qa0688content@beebeeb.io`) was independently flagged broken against localhost by
  lane eng-1395 during the same session. Next agent: re-run with a freshly signed-up local account
  and a clear Maestro window — `xcrun simctl launch <udid> io.beebeeb.app`, tap the dev-server row,
  sign up/in, visit Files + Photos + Settings tabs, then in Files.app open the Beebeeb File Provider
  and open one file, then re-run `scripts/verify-backup-exclusion.sh <udid>`.
- Physical-device Finder-backup inspection remains Guus-gated per the spec (§9 Q1) and is unaffected
  by the above — it verifies the real backup, not the resource value, and was never simulator work.
