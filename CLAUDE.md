# beebeeb-io/mobile

Beebeeb for iOS (ships at the September 2026 launch) and Android (post-launch). React Native + Expo (managed workflow) + TypeScript. Package manager: **bun**. This file is evergreen rules only; per-task incident narratives, rulings and corrections live in `docs/runbook/mobile-task-history.md` (topic headings, `#task-NNNN` anchors) — pointers below cite it as `(details: H#…)`.

## Platform status — iOS-first (task 0711)

iOS ships at launch; **Android does NOT ship September 1 — post-launch.** The Android crypto module (`modules/beebeeb-crypto/android/.../BeebeebCryptoModule.kt`) is a **stub** (every native crypto/keychain/OPAQUE call throws `NotLinkedException`); making it real (UniFFI `.so`, Keystore + BiometricPrompt, device QA) is post-launch work. **Do not represent Android as shipping at launch** in code, docs, or any outward surface. (Android *browsers* run the web app + CLI — that IS fine to say.)

## iOS builds — always build locally on macOS (free)

**Never use `eas build` without `--local` on a macOS device** (cloud builds cost credits; local is free and just as fast on Apple Silicon). Exception: CI/CD without Xcode. Prereqs: `fastlane`, `xcbeautify` (`brew install`). **Never remove the `ios/.xcode.env` pin `export ENTRY_FILE="src/App.tsx"`** — without it an `eas build --local` staged in a symlinked tmpdir fails "Unable to resolve module …/src/App.tsx" → ARCHIVE FAILED. (details: H#task-0671)

Android versionCode is local too: bump `android/app/build.gradle` (and `app.json`) by 1 for every Play upload; Play rejects a versionCode ≤ the last upload.

```bash
# Build locally (free — runs on this Mac, ~10-15 min)
eas build --platform ios --profile production --local --output ./build/beebeeb.ipa

# Submit to TestFlight (always free)
eas submit --platform ios --path ./build/beebeeb.ipa

# Or combine: build + submit in one step
eas build --platform ios --profile production --local --output ./build/beebeeb.ipa && \
  eas submit --platform ios --path ./build/beebeeb.ipa
```

## `expo prebuild` — ALWAYS run the vendored-file restore afterwards (task 1305)

`expo prebuild` (with AND without `--clean`) deletes/overwrites files the config plugins do NOT reproduce: `ios/BeebeebCore.xcframework`, `ios/Beebeeb/beebeeb_uniffi.swift`, `ios/.xcode.env`, `ios/BeebeebWidget/BeebeebWidget.swift`, `PrivacyInfo.xcprivacy` — committed copies are the source of truth. **Treat it like `git clean`: destructive in this tree, never in a tree you did not allocate.** Every extension target is created by its config plugin (`plugins/lib/extension-target.js`) — never by hand in Xcode; plugin mods execute in REVERSE registration order; every Rust-linking target sets its own per-SDK `OTHER_LDFLAGS`; a `PBXBuildFile` belongs to exactly ONE build phase. `--clean` used to destroy the `ProvenanceHeadersTests`/`CoreVectorsKATTests` native test targets; they now live at `targets/native-tests/` and are plugin-owned (task 1562). (details: H#task-1305)

```sh
bunx expo prebuild --platform ios --clean --no-install && scripts/restore-vendored-ios.sh
```

### Prebuild bridge guard (task 2252)

`modules/beebeeb-crypto/ios/BeebeebCryptoBridge.swift` is the only bridge source;
CocoaPods compiles it directly. The UniFFI plugin must never overwrite it.
`node scripts/check-prebuild-bridge.cjs` exercises the plugin copy mod in a disposable
project and compares the resulting bridge bytes with the module source. CI runs it;
`bun install` installs the same pre-commit check for this worktree, preserving any
existing secret/coordination hook. Install explicitly with
`bash scripts/install-prebuild-guard.sh` if lifecycle scripts are disabled.
The guard checks the copy mod; a real clean prebuild plus the documented restore
and an iOS Debug build remain required when changing the generator.

### Native XCTest targets are plugin-owned (task 1562)

`ProvenanceHeadersTests` and `CoreVectorsKATTests` now survive `expo prebuild --clean`. Both were
hand-added straight into `project.pbxproj` (tasks 1382/1439) with no config plugin, so a clean
prebuild silently dropped the old `ios/BeebeebNativeTests/` group and both targets — `scripts/kat-ios.sh`
then failed outright ("scheme not found"). Canonical sources now live OUTSIDE `ios/` at
`targets/native-tests/` (mirroring `targets/share-extension/`, `targets/file-provider/`);
`plugins/native-tests/withNativeTestTargets.js` wires both host-less XCTest bundles on every
prebuild via `plugins/lib/xctest-target.js` (no test host, no Pods, no entitlements, no Info.plist
file, never embedded into the app). Verify with `scripts/check-prebuild-test-targets.sh` (clean
prebuild + `restore-vendored-ios.sh`, then `xcodebuild -list` — never a pbxproj text grep). LOCAL
gate only, same as `kat-ios.sh`. (details: H#task-1562)

## iOS 27 UIScene lifecycle (build-213 App Review crash, fixed in 214)

Scene lifecycle is plugin-owned (`plugins/scene-lifecycle/withSceneLifecycle.js` + `ios/Beebeeb/SceneDelegate.swift`) — never reintroduce bare `UIWindow(frame:)`/`startReactNative` on AppDelegate. Cold-launch deep links: fold `connectionOptions.urlContexts`/`.userActivities` into the `launchOptions` passed to `factory.startReactNative` — `RCTLinkingManager.getInitialURL()` reads it directly and does NOT fire an event. BGTaskScheduler, remote-notification registration and JS `AppState` privacy-lock were verified unaffected. (details: H#build-213)

## iPad (iPhone compatibility mode) (task 1588)

- **Any top chrome must be laid out from `useSafeAreaInsets().top`, never from a fixed offset or y=0** — `WindowControlsAwareWindow` adds the iPad window-control height (43 pt on an iPad Air 11" M3, 0 on an iPhone) to the safe area.
- **Driver: AXe, window offset added** — `axe describe-ui` frames are WINDOW coordinates; tap at `x + (820 - windowWidth)/2` (portrait iPad Air 11"). Maestro sees SpringBoard, not the app; out-of-process UI (pickers, share sheet, alerts) is tapped by screenshot coords. An edge swipe on the window's left edge resizes it (to 375 pt) and can empty the accessibility tree until a sim reboot. (details: H#task-1588)

## Rendering & preview traps

- A `<WebView>` whose DIRECT parent sets `justifyContent`/`alignItems:'center'` paints NOTHING on iOS 27, regardless of the WebView's own sizing — wrap it in its own plain non-centered `flex:1` View (`svgWebViewWrap`/`docxWebViewWrap` pattern). WebView-only trap: a blank plain View/Image is usually a bad data source — check that first. (details: H#task-1564, H#task-1569)
- Preview text detection: test the mime an UPSTREAM guess actually produces, not just `''`/`application/octet-stream`, whenever a fallback layers on top of another one; the gate is an allowlist-of-exclusions (`isConfidentlyNonTextMimeType` in `code-text-preview.ts`). (details: H#task-1570)

## Worktree `.env` — copy it by hand, or the app silently defaults to production (task 1394)

`git worktree add` does not copy the gitignored `.env`. Before the first simulator run in any new worktree: `cp <primary-checkout>/.env .env` (`EXPO_PUBLIC_API_URL=http://localhost:3001`), then start/RESTART Metro (the URL is inlined at bundle time). Required evidence: the Metro boot line `[Beebeeb] API environment: Local (http://localhost:3001)` — a "wrong password"/"account not found" result against a documented localhost-only QA account is the tell it was missed, not credential drift. (details: H#task-1394)
## Local simulator QA — environment gotchas on this Mac

- Node crash `MODULE_NOT_FOUND … restore-node-options.cjs` = cmux's temp `NODE_OPTIONS` shim got GC'd — recreate as a no-op: `echo 'module.exports={};' > "$(printf '%s' "$NODE_OPTIONS" | sed -E 's/.*--require=([^ ]*restore-node-options\.cjs).*/\1/')"`, or prefix node CLIs with `env -u NODE_OPTIONS`.
- `simctl` hangs forever until Xcode first-launch is completed: a human runs `sudo xcodebuild -runFirstLaunch` once (cannot be headless). Health check: `xcodebuild -checkFirstLaunchStatus` (exit 0 = done, 69 = pending).
- `cargo run` deadlocks in the nested agent shell — run the binary directly: `cd repos/server && ./target/debug/beebeeb-api`.
- Local API blob storage is LOCAL FILESYSTEM (`BLOB_STORE=local`, default pool at `BLOB_STORE_PATH`) — upload/download/offline-pin/sharing QA is safe locally; the `S3_*` vars are inert; only push notifications and real-device-only surfaces need TestFlight.
- Maestro `takeScreenshot` relative paths resolve against Maestro's CWD — write `takeScreenshot: "${EVIDENCE_DIR}/some-name"` and invoke with `-e EVIDENCE_DIR=/abs/path`, or `xcrun simctl io <UDID> screenshot --type=png <abs>.png`.
- **NEVER tap chrome by coordinate — use a `testID`.** A coordinate tap can pass while testing nothing. Content-relative taps (a file row) OK; chrome-relative not. A Maestro text selector must match the ENTIRE accessible name, and RN `accessibilityLabel` silently REPLACES visible text — read the label in the source; `id:` where you can, a `.*`-anchored regex where you must.
- `clearState: true` does NOT sign out (master key persists in keychain) — sign out in-app.
- Local QA account: `qa0688content@beebeeb.io` / `BeebeebQA0688content!` (OPAQUE, seeded; `.claude/skills/beebeeb-test-accounts.md`). (details: H#qa-env-gotchas)

## Simulators — one lane per sim (tasks 1353/1426/1409)

| Sim | UDID | iOS | Device |
|---|---|---|---|
| `bb-qa-1310` | `D41C3AA1-D520-4CEF-A286-5F8717A03B7F` | 26.5 | iPhone 17 Pro |
| `bb-qa-2` | `C44A5FD9-42B4-4334-934C-E4D9C3D76041` | 26.5 | iPhone 17 Pro |
| `bb-shots` | `B272D461-0765-4890-B08C-C894925919EA` | 26.5 | iPhone 17 Pro Max |
| `bb-ios27` | `6A2C9171-813B-443E-A19D-B7869D5D0A20` | 27.0 | iPhone 17 Pro |

- **Never share one sim across two lanes; claim one per lane for the session.** Sims have vanished wholesale before — confirm first: `xcrun simctl list devices | grep bb-`. **Always pass `--udid` naming the sim your lane owns.**
- After ANY native-dependency change, rebuild the dev client once and re-run the copy procedure below against every QA sim before its next lane (a copied container keeps the native modules linked at copy time). (details: H#task-1409)
- Dev-client copy procedure (no rebuild):
```sh
xcrun simctl create bb-qa-N "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl boot <new-udid>
xcrun simctl bootstatus -b <new-udid>  # blocks until boot has finished
APP=$(xcrun simctl get_app_container <source-udid> io.beebeeb.app)
xcrun simctl install <new-udid> "$APP"
xcrun simctl launch <new-udid> io.beebeeb.app
```

- Point a dev client at a specific Metro: `xcrun simctl openurl <udid> "beebeeb://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>"` — two one-time prompts on a fresh install ("Open in Beebeeb?" alert, then the developer-menu sheet), dismissed headlessly with one-line Maestro `--udid` flows (`tapOn: "Open"` / `tapOn: "Continue"`). **Never `openurl` a deep link into an already-running app** (it can orphan the native view — white screen; terminate first).
- iOS 27 sims ignore dev-client deep links at cold start — use `xcrun simctl launch <udid> io.beebeeb.app --initialUrl http://127.0.0.1:<port>`, and never `launchApp` inside that Maestro flow. Turn "Tools button" OFF in the dev menu on every Maestro-driven sim — the floating gear at ~(8%, 47%) swallows taps (per-device preference). (details: H#task-1353)

## Maestro (task 1350)

- **One `maestro test` at a time, machine-wide** — the XCUITest driver/CPU is the shared resource, not the simulator; the lead grants it. `xcrun simctl io` screenshots may overlap freely.
- An idle-but-attached driver on ANY sim poisons new driver bootstraps on ALL of them (one host-level `testmanagerd`): after every run `pgrep -f 'xcodebuild test-without-building'` and kill only your own orphan by PID (verify its `-destination id=`) — **never `pkill -f xcodebuild`**.
- A tap reports COMPLETED and the screen does not change → it is the DRIVER, not the app (a clean PRE-tap screenshot is the proof). Retry mitigations in `search-test.yaml`/`file-preview-test.yaml`; remove once `maestro --version` is past 2.5.1 (full analysis: `docs/maestro-driver-fault-1360.md`). (details: H#task-1360)
- `tapOn: "Dismiss menu"` on a `BBActionSheet` scrim can navigate into the wrong screen — a point tap at `50%,15%` dismisses reliably. The row "…" overflow is a NATIVE menu Maestro cannot tap in the recorded driver sessions (this is not a blanket UIMenu limitation: `fab-add` → "New folder" is tappable; release recipe `e2e/maestro/1381-native-fab-folder.yaml`) — row swipe RIGHT, or for folders `tapOn: id: "file-row-actions-<id>"` then `sheet-action-<action>`. `UIDocumentPickerViewController` exposes only "Cancel"/keyboard to XCUITest — documents cannot be seeded by automation (`simctl addmedia` rejects non-media).
- `scrollUntilVisible` with an `id:` can miss an off-screen row — fall back to a `.*`-anchored text regex for the SCROLL only (details: H#task-1352). A stale accessibility bridge after `launchApp` (present-but-still-not-found, ~0% CPU hang): external `xcrun simctl terminate` + `launch` before the flow's `launchApp`. `pressKey: Enter` on the password field submits sign-in. (details: H#task-1350)

## QA account & fixtures (task 1356)

`qa0688content@beebeeb.io` holds load-bearing fixtures — never touch/duplicate/delete them: `qa-red/blue/green.png`; `medium-photo.jpeg` (2 MB perf tier); `big-photo.jpeg`; `clip-1080p.mp4` (search fixture); `clip-1080p (3).mp4` (40 MB tier — separate on purpose); `qa-1301-video.mp4` (213 MB); `qa-hevc.mp4`; `qa-video.mp4`; the empty folder `Quarterly Financial Reports And Tax Documents 2026 Archive` (truncation fixture — never rename). Lanes: prefix throwaway uploads with your task id; delete your own at lane end (`bb rm` is reversible); never repurpose a fixture; flag decrypt failures not already documented by tasks 1349/1351. (details: H#task-1356)

## Native signup & onboarding (task 1746)

The app creates accounts natively, driven by `GET /api/v1/onboarding` (spec `docs/specs/2026-10-04-backend-driven-onboarding.md` §5): the server declares steps/numbers/permission, nothing hard-coded. Flow: Welcome → Login/Signup → SignupFlow (email, code, terms, password, phrase, create) → unlock(freshMasterKey), refreshAuth → AccountStateProvider → blocking `AccountOnboardingOverlay` (verify_email, accept_terms, update_required). Pure logic in `src/lib/onboarding/` (tested without mocks); crypto stays in core (`OnboardingBridge.swift` → `beebeeb_core::onboarding`, task 1744; JS holds integer handles; master key never leaves Rust). Contract copy `src/contracts/onboarding/` is byte-identical to `repos/server/contracts/onboarding/`, guarded by `scripts/check-onboarding-contract.sh` (re-vendor with `cp -R` after server changes). **No purchase UI, by construction** (App Store 3.1.3, task 1400; guarded by `no-purchase-ui.test.ts`/`account-summary.test.ts`). Anti-enumeration: the code screen's copy is identical for every address — never add a sentence saying whether an address is new. Recovery phrase screen: `usePreventScreenCapture`, `selectable={false}`, words dropped on leave; Simulator framebuffer capture NOT blocked (device-only). Debug fixture: `beebeeb://dev/onboarding-fixture?name=…` (`off` clears). Native rebuild after any `beebeeb_uniffi.swift`/`BeebeebCore.xcframework` change: `scripts/swift-ci/build-ios-simulator.sh` (unsigned sim build cannot use the Keychain in the Simulator; QA install build: `CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO`; restore `Podfile.lock`/`project.pbxproj` before committing). Two emailed codes needed today (signup + `verify_email`) — a server finding. Metro quirk: a file created after Metro started can report "Unable to resolve module" — restart Metro. (details: H#task-1746)

Local run (a lane's OWN API, never the shared :3001):
```sh
# server worktree .env (debug build): its own DB and port
BB_PORT=3146  DATABASE_URL=<the dev Postgres URL, pointing at your own database name>
BB_SIGNUP_EMAIL_CODE=1  BB_REQUIRE_EMAIL_VERIFICATION=1  BB_REQUIRE_PLAN_AT_SIGNUP=1
BB_ENTRY_ALLOWANCE_BYTES=2000000000          # allowance ships OFF
BB_SIGNUP_TICKET_TTL_SECONDS=60              # floor is 60; default 1800
# a native mobile-ios matrix row (server_config key onboarding_policy_matrix), purchase_surface none
# mailpit (docker compose up -d mailpit) shows the emailed 8-digit codes on :8025
# mobile worktree .env:  EXPO_PUBLIC_API_URL=http://localhost:3146  -> Metro must print
#   "[Beebeeb] API environment: Local (http://localhost:3146)"
```

## Storage location is a COUNTRY, never a city (task 2050)

Canon (Guus, 2026-10-19, `docs/canon/data-residency.md`): the app names countries ("Germany", "Finland", "Netherlands (coming soon)") and "Europe" — never a city, never the provider. The choice list comes ONLY from the API (`src/lib/regions.ts` over `src/lib/storage-regions.ts`); PUT carries the item id; "Only store in <country>" is `region_strict` on GET/PUT `/me/region` (PUT replaces the whole choice). **Strict placement is HIDDEN on mobile (`STRICT_PLACEMENT_ON_MOBILE`; task 2054 owns the Swift side).** Per-file location is `storage_location.country` ("Europe" when absent); the deprecated `city` is never read. Guard: `src/lib/no-city-in-copy.guard.test.ts` fails on city names in non-test source. (details: H#task-2050)

## Tests — run `bun run test`, NOT `bun test` (task 0877)

`bun run test` isolates each test file in its own process — **every test file must mock every native module it needs itself**; never rely on another file having mocked it. (details: H#task-0877)

```sh
bun run test        # correct: per-file process isolation (155 pass / 0 fail)
bun test            # WRONG: leaky shared registry, reports ~10 phantom failures
```

### Native crypto KAT — `scripts/kat-ios.sh` (task 1382) — LOCAL GATE, NOT CI

Drives the vendored, sha256-pinned `repos/core/test-vectors/vectors.json` (vendored at
`targets/native-tests/Vectors/core-vectors.json`, and compiled from
`targets/native-tests/CoreVectorsKATTests.swift` — both outside `ios/`, task 1562) through the SAME
production UniFFI bindings the app links; all 31 families are required by name with their row
count, and 26 of them are decrypted or derived through the binding. The other 5 are only counted:
`envelope_serialization` (explicit `XCTSkip` — no UniFFI export) plus the four folder/owner-wrap
families no mobile reader uses yet. Run `scripts/kat-ios.sh` by
hand after touching `beebeeb_uniffi.swift`, `BeebeebCore.xcframework`, or the vectors file — CI runs
`typecheck` only. Keep regens additive-only at the FFI level and symbol-diff the two
`beebeeb_uniffiFFI.h` files before shipping (the 0426 12-symbol-drift lesson). (details: H#task-1382, H#task-1450)

## API

Backend at `http://localhost:3001` — same endpoints as web; see `repos/server/CLAUDE.md`. `mobileClientHeaders()` sends `X-Beebeeb-Client: mobile-ios|mobile-android` and, since task 1436, `X-Beebeeb-Client-Version` (from `Constants.expoConfig?.version ?? '1.0.0'`) on the 5 unauthenticated auth-bootstrap calls AND all 3 upload-init call sites (server PR #23 / task 1369). Native `URLRequest` sites (26) all go through `ProvenanceHeaders.apply(to:)` (task 1439) — the ONLY place those header names or the `"mobile-ios"` literal may appear; tested by the standalone `ProvenanceHeadersTests` target: `xcodebuild test -project ios/Beebeeb.xcodeproj -scheme ProvenanceHeadersTests -destination 'id=<sim-udid>'`. (details: H#task-1436)

## Design references / Screens / Brand

- `../../design/hifi/hifi-ios-app.jsx` (Home, Photos, Preview, Share, Settings, Biometric, Camera backup) · `hifi-android-app.jsx` · `hifi-mobile-extra.jsx` (offline, upgrade, share extension, push) · `hifi-mobile-sync.jsx`.
- Tabs: Files, Shared, Photos, Settings; plus file preview, share sheet, biometric lock. Same design tokens as web, converted to RGB (OKLCH unsupported in RN) — `src/theme.ts`.

## Thumbnails

WebP. Medium (default) 768px at q0.82, ~100 KB target / 128 KB encrypted cap (`src/lib/thumbnail.ts`, degrade ladder in `thumbnail-policy.ts`); small 384px, large 1280px. Native backup path (task 0631): ONE PhotoKit source fetch (1600px) per asset → medium + large + blurhash via the shared `ThumbnailGenerator`; server stores them as reserved V1 chunk blobs — medium `4294967295.bin`, large `4294967293.bin`. Rendering ladder (task 0552): PhotoKit-first → encrypted-thumbnail fallback → ~25-byte blurhash placeholder. Downloads use plain `fetch` (not `rateLimitedFetch` — dedicated 50k req/min tier); cached at `documentDirectory/beebeeb-thumbnails-v3/{fileId}.{variant}.webp`; queue max 5 concurrent. (details: H#task-0631, H#task-0553, H#task-0552)

## Crypto

Consumes `beebeeb-core` via UniFFI (generated Swift at `modules/beebeeb-crypto/ios/beebeeb_uniffi.swift`, static libs vendored in `ios/BeebeebCore.xcframework`) — GENERATED ARTIFACTS: regenerate from core's `build-ios.sh`, never hand-edit; template trailing whitespace is expected. The master key never leaves Rust/the keychain.
- Native backup uploads (`NativeEncryptedBackupUploader.swift`) use `ChunkEncryptorHandle`: `forPush` (not `fromFile`) for in-memory `Data`; `chunkPlan()` sizes (never hardcode a chunk size); `pushChunk` frames PUT directly; `finish()` runs the integrity guard BEFORE `upload/complete`; `upload/init` still sends `size_bytes` = plaintext count. Profiles: `"desktop" | "web" | "mobile" | "backup"`.
- Manual uploads are native too (task 1310): `encryptedUpload()` routes through `uploadEncryptedFileNative()` whenever the caller passes `masterKeyHandleId`; JS polls `getUploadProgressNative(requestId)` every 150 ms; errors return as a `{"bb_upload_error":true,status,code,message}` envelope. Plaintext never enters the JS heap — **never reintroduce base64 file reads in the upload path.** (details: H#task-1310)

## Vault key ownership (task 1594)

The keychain master key carries an owner record (`io.beebeeb.master-key-owner`, `src/lib/key-ownership.ts`). On unlock: refuse with no signed-in user; purge key + check + fallback + simulator file + owner BEFORE loading when the owner is someone else; prove the key once per sign-in via `POST /api/v1/auth/verify-recovery-check` (a 400 there is ambiguous, settled by the account's X25519 public key); a recovery phrase is verified the same way before storing. **Never add a key-load path that skips this.** `X-Beebeeb-Expected-User` (server 1554) is sent on authenticated mutations (`src/lib/expected-user.ts`); a 409 `account_mismatch` ends the local session; BackupService stops with `VaultKeyMismatchError`. (details: H#task-1594)

## On-disk storage — every new path must be registered (task 0300)

iOS backs up `Documents/`, `Library/Application Support/`, and App Group containers — NOT `Library/Caches/`. Any path written outside `Caches/` must be registered in `PlaintextStorageProtection.swift` AND mirrored in `PROTECTED_LEAF_NAMES` (`src/lib/plaintext-storage.ts`), or `bun run test` fails. New Swift file: add to `REVIEWED_NATIVE_SOURCES` + call `PlaintextStorageProtection.protect(dir)` after `createDirectory`. New JS cache file: register the leaf name + `notePlaintextPathCreated()` after the write. Prefer `FileSystem.cacheDirectory` for disposables. Verify: `bash scripts/verify-backup-exclusion.sh <sim-udid>`. (details: H#task-0300)

## Camera-roll backup manifest (tasks 1667/2033/2036)

`Documents/SQLite/beebeeb-backup.db` — per-account manifest that survives sign-out as a file.
- **ONE SQLite copy for the manifest (task 2033):** manifest files (`BackupManifestHandle`, `BackupManifestStore`, `ManifestWriteFence`, `NativeBackupEngine`) `import ManifestSQLite` and call `exsqlite3_*`; **never** `import SQLite3`/bare `sqlite3_*` in a manifest file; never pass a connection/statement to a file on the other copy. Every OTHER SQLite file stays on one copy too (File Provider cache + `ThumbnailQueueDB`/`PhotoBackupManager` on the Rust copy). Linkage check: `nm -u` on the manifest `.o` files lists `_exsqlite3_*`, no `_sqlite3_*`. Guard: `src/lib/manifest-single-sqlite-copy.guard.test.ts`.
- Writers exclude each other: engine `BackupManifestHandle.busyTimeoutMs` (2000 ms) == JS `PRAGMA busy_timeout = MANIFEST_BUSY_TIMEOUT_MS` (the guard checks); never hold a manifest write transaction across a call that waits on the other side.
- **Never unlink the file under an open handle.** **Never close the JS handle while the engine's connection is open on the file.** Sign-out keeps the JS handle OPEN (purge hold + drain, `peerMayHoldFile`, park instead of close, `pending_reset_deferred`); JS closes it in exactly two places, both after the engine's handle is closed: (1) the failed-reset path, (2) `admitJsOpen` closes leftover JS on `pending_reset_deferred`. A reset counts only if the WAL was TRUNCATE-checkpointed; JS opens the manifest ONLY through the native gate (`admitBackupManifestJsOpen`, `src/lib/backup-manifest-js-open-gate.ts`); native never closes/checkpoints while JS may hold the file outside the purge hold.
- Engine handle in `BackupManifestHandle.swift` — the only code that opens/resets/closes/reopens the native connection; `start()`/BG task never run without a handle (`manifestUnavailableReason`, retry 2/4/8/16 then every 30 s). Engine lifecycle is ONE transition (`BackupEngineLifecycle.swift`) — never hold the lock across a keychain/Face ID read; `processBatch` takes the batch slot (`beginBatchProcessing`) before the rebuild gate.
- **Every manifest write is fenced** (Swift `ManifestWriteFence`; JS `BackupWriteTicket`, `src/lib/backup-write-ticket.ts`): ticket taken BEFORE the slow step, checked as the first statement of the same `dbQueue` block; a new writer without a ticket check fails tests.
- Server dedupe guarantee: `POST /api/v1/files/photo-backup/check` (task 2036) is the authority — bulk pass over all fresh pending rows + per-batch guard for every fresh row; any failed step defers the WHOLE batch with a backoff (nothing uploads on a failure); a server without `backed_up` fails closed. A mark 404 is "file gone, done" ONLY with the API's own `{"error":"not found"}` body. `backup_pending_marks` kept across sign-out (30-day expiry); `X-Beebeeb-Device-Id` handoff (`BackupDeviceId.swift`) — native NEVER mints a device id.
- Tests: `scripts/swift-tests/*-test.swift` suite + the `src/lib` guard tests (full list in history). (details: H#task-1667, H#task-2033, H#task-2036)

The legacy JS `BackupService.flattenDuplicateBackupFolders()` coalesces concurrent calls with `_flattenInFlight` and latches `_backupTreeFlattened` only after the entire subtree is clean. Errors or deferred merges leave it retryable on the next warm-up. The successful latch lasts for the JS session; relaunch before testing a newly introduced duplicate after a clean pass. This is distinct from the native manifest and upload engine.

## Files (File Provider extension) (task 1722)

- Behaviour tests run the shipped extension sources (`src/lib/file-provider-extension-behaviour.test.ts`; CI `swift-gate` with `BB_REQUIRE_NATIVE_SWIFT_HARNESSES=1`) — add a scenario there before changing extension behaviour; `String.raw` Swift must be ASCII.
- The simulator CAN hold the Files Secure Enclave key (Apple-silicon sims emulate it). The key has ONE writer: `KeychainManager.syncFileProviderWrappedKey`/`deleteFileProviderKey` — never call `storeFileProviderWrappedKey` from a new path; keep "consent off, then delete" in every revoking path.
- Files key group `R8352WDJJR.io.beebeeb.files` (app + File Provider only, never Share/widget); keep the shared group FIRST in `keychain-access-groups`; every Files-key query names the group. Items: SE tag `io.beebeeb.sekey.files.v2`, wrapped blob service `io.beebeeb.masterkey.files.v2`.
- **Files is on by default** for a signed-in, unlocked account (`src/lib/files-mount-default.ts`); off state in SecureStore `beebeeb.files-mount-off.v1.<digest>`, NOT AsyncStorage (the sign-out purge deletes `RCTAsyncLocalStorage_V1`). iOS shows a default "Beebeeb" location whenever our `io.beebeeb.files` domain is not registered — by design; `assertNotVisible: "Beebeeb"` on Locations fails by design.
- Files content is plaintext ONLY in App Group `temp/` — never the manager's `temporaryDirectoryURL()` (`plaintext-storage.test.ts` fails on system temp APIs there). Folders already listed are never listed again (working set carries root + materialized children, 300 s refresh). Removing the domain deletes every item in it, including un-uploaded Files-created files. The refresh `enumerateItems` rarely finishes — work that must complete runs in its own detached task.
- Before `simctl delete`/`erase` after Files was mounted: wait for `…/FileProvider/Purgatory/` to empty (EPERM otherwise). (details: H#task-1722)

## GET /files/index — only through `file-index-loader.ts` (task 1959)

`src/lib/file-index-loader.ts` is the only caller of `getFileIndex()` (`file-index-loader.guard.test.ts`); native never calls `GET /api/v1/files/index` (~2.4 s/call on a 40k vault). The loader coalesces callers and serves the on-disk cache for 5 minutes after a server check (`FILE_INDEX_REVALIDATE_MS`); `force: true` skips; the reconcile is throttled to once per 5 min. Own uploads are classified locally (`upload-classification.ts` / `backup_assets.asset_type`); a row no source knows makes a `revalidateUnclassified` caller revalidate once. Account boundary: `src/lib/account-epoch.ts` — a stale-epoch request rejects with `StaleAccountError` (discard silently: no error UI, no fallback). (details: H#task-1959)

## Bottom sheets — one primitive (task 1586)

Every partial-height sheet renders through `src/components/sheet/BottomSheet.tsx` (+`BottomSheetScrollView`): full width, bottom attached, `GLASS_RADII.sheet` top corners, detents (`src/lib/sheet-detents.ts`: half / 72 % / 90 %), fling-to-dismiss, scroll hand-over; RN Animated + gesture-handler, no Reanimated; inside an RN `Modal` wrap in `GestureHandlerRootView`; a routed sheet (`ShareSheet`) uses `animation: 'none'` and pops in `onDismissed`. `sheet-sweep.test.ts` fails if a sheet floats inset again. Exceptions: DEVIATIONS.md → "Task 1586".

## iOS app compile gate — `ios-build` CI job (task 1669)

`.github/workflows/ci.yml` job `ios-build` (macos-latest, free) runs `scripts/swift-ci/build-ios-simulator.sh` (`bun install`, `pod install`, unsigned `xcodebuild` of the `Beebeeb` scheme) — the only thing that compiles `modules/beebeeb-crypto/ios/*.swift` before a TestFlight build; asserts `BUILD SUCCEEDED` ×1, 0 `: error:` lines, and that `NativeBackupEngine.swift`/`BeebeebAppDelegate.swift` were actually compiled. Guards: `src/lib/app-delegate-launch-guard.test.ts`, `src/lib/native-backup-engine-db-queue.test.ts`. Unit suite = job `unit-tests` (`scripts/ci/unit-suite.sh`, requires the truth line `isolated: N pass, 0 fail across F files`; `--self-test` proves the gate goes red).

## How we work (evidence, design, done, parallel agents)

Full rules: workspace `CLAUDE.md` → "How we work" (also in workspace `AGENTS.md`). Repo-specific: truth line `bun run test 2>&1 | tee /tmp/bb-mobile-test.log` must end `isolated: N pass, 0 fail across F files` — assert N (2026-09-12: 272 across 35), not the word "ok"; `bunx tsc --noEmit; echo exit=$?` — assert the exit code, not silence. Maestro evidence = the per-flow lines of `run-all.yaml`, pasted into the task file; COMPLETED against an unchanged screenshot is the driver fault, not a pass. Simulators by UDID, always. Design before code: `design/ios26-canvas/` + `DEVIATIONS.md`; a ruling from Guus supersedes the canvas (precedent 1357); the DEVIATIONS.md line rides the same commit as the code. Done means the declared rung ran — `tsc` + `bun run test` never close a simulator, Maestro, or device rung; a Linux session parks the task in `in-review/` naming the open rungs.

## Graphify

Knowledge graph at `graphify-out/`: read `GRAPH_REPORT.md` before exploring code; run `graphify update .` after modifying code and commit `graphify-out/`; `graphify query "<question>"`; `graphify path "<A>" "<B>"`.

## Keep shared docs in sync

When you add/change/remove endpoints, types, build commands, or dependencies: update the matching skill file in the beebeeb workspace's `.claude/skills/` directory (beebeeb-api.md, beebeeb-designs.md, beebeeb-stack.md, beebeeb-dev.md). Other agents depend on these being accurate.
