# beebeeb-io/mobile

Beebeeb for iOS (ships at the September 2026 launch) and Android (post-launch). React Native + Expo.

## Platform status — iOS-first, Android descoped from launch (task 0711)

**iOS ships at launch. Android does NOT ship September 1; it is post-launch.** The Android crypto module (`modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt`) is a **stub** — every native crypto / keychain / OPAQUE call throws `NotLinkedException`, so the app does not function on Android. Making it real is post-launch work (link the Rust `.so` via UniFFI, Android Keystore + BiometricPrompt, device QA) tracked in the post-launch Android task. Do not represent Android as shipping at launch in code comments, docs, or any outward surface. (Android *browsers* run the web app + CLI — that IS fine to say.)

## iOS builds — always build locally on macOS (free)

**Never use `eas build` without `--local` when working on a macOS device.**
EAS cloud builds cost credits. Local builds are free and just as fast on Apple Silicon.

```bash
# Build locally (free — runs on this Mac, ~10-15 min)
eas build --platform ios --profile production --local --output ./build/beebeeb.ipa

# Submit to TestFlight (always free)
eas submit --platform ios --path ./build/beebeeb.ipa

# Or combine: build + submit in one step
eas build --platform ios --profile production --local --output ./build/beebeeb.ipa && \
  eas submit --platform ios --path ./build/beebeeb.ipa
```

Prerequisites (must be installed):
- `fastlane` — `brew install fastlane` ✓ already installed
- `xcbeautify` — `brew install xcbeautify` (cleaner build logs)

Exception: CI/CD environments without Xcode must use cloud builds.

### `eas build --local` "Unable to resolve module …/src/App.tsx" — symlinked-tmpdir fix (task 0671)

`eas build --local` stages the project in a **symlinked tmpdir** (macOS `/tmp`→`/private/tmp`,
`/var/folders/…/T`→`/private/var/…`). The "Bundle React Native code and images" script computes the
bundler ENTRY as an **absolute** path (via `expo/scripts/resolveAppEntry … absolute`) only when
`ENTRY_FILE` is empty; that absolute path keeps the unresolved-symlink form while Metro realpaths its
projectRoot, so Metro sees the entry *outside* the project root → `Unable to resolve module …/src/App.tsx`
→ **ARCHIVE FAILED** on any entry. Direct local builds in the real repo dir are unaffected (no symlinked tmpdir).
**Fix (committed):** `ios/.xcode.env` pins a **relative** entry — `export ENTRY_FILE="src/App.tsx"` —
which resolves against Metro's realpath'd cwd everywhere. Do not remove it.

## `expo prebuild` — ALWAYS run the vendored-file restore afterwards (task 1305)

`expo prebuild` (with AND without `--clean`) deletes/overwrites files that config plugins do
NOT reproduce: `ios/BeebeebCore.xcframework`, `ios/Beebeeb/beebeeb_uniffi.swift`,
`ios/.xcode.env` (the 0671 ENTRY_FILE pin), `ios/BeebeebWidget/BeebeebWidget.swift`,
`PrivacyInfo.xcprivacy`. The uniffi-bridge plugin only re-copies the Rust artifacts when
`../../core` sits next to the project — never true in a worktree or an eas staging dir — so the
committed copies are the source of truth. Symptoms when you forget: "Undefined symbols
_ffi_beebeeb_uniffi_*" at link, "Build input file cannot be found: BeebeebWidget.swift", or an
`eas build --local` that dies with "Unable to resolve module …/src/App.tsx".

```sh
bunx expo prebuild --platform ios --clean --no-install && scripts/restore-vendored-ios.sh
```

Since SDK 57 every extension target (FileProvider, Share, Widget) is created by its config
plugin (`plugins/lib/extension-target.js` is the shared helper) — do not add targets by hand in
Xcode; a clean prebuild must reproduce the whole project. Config-plugin mods execute in
**reverse registration order** (the last plugin in app.json runs first), so never rely on one
plugin seeing another's target: every target that links the Rust core sets its own per-SDK
`OTHER_LDFLAGS` in `extension-target.js`; `uniffi-bridge` only handles the app target.
Invariant the helper enforces: a `PBXBuildFile` belongs to exactly ONE build phase — dedupe build
files per owning target, never globally by fileRef, or `pod install` fails in Xcodeproj's
`project.save` ("Consistency issue: no parent for object …").

## Local simulator QA — environment gotchas on this Mac (verified 2026-06-29)

Running the iOS app on the Simulator for QA hits several env-specific walls. Workarounds:

- **Any node process crashes with `MODULE_NOT_FOUND … internal/preload` / `restore-node-options.cjs`**
  — `NODE_OPTIONS` is `--require=/var/folders/…/T/cmux-claude-node-options/restore-node-options.cjs`,
  but cmux's temp shim got garbage-collected from `/var/folders/.../T`, so node can't load the
  `--require` and crashes on startup (this also fails the Claude **Stop hooks**).
  **Durable fix:** recreate the shim as a no-op — `echo 'module.exports={};' > "$(printf '%s'
  "$NODE_OPTIONS" | sed -E 's/.*--require=([^ ]*restore-node-options\.cjs).*/\1/')"` (or just
  unset `NODE_OPTIONS` in your shell profile). It lives in a temp dir, so it can recur if that dir
  is cleaned again — a cmux lifecycle issue, not a beebeeb one.
  **Per-command fallback:** prefix node CLIs with `env -u NODE_OPTIONS` (`eas`, `bunx tsc`, `maestro`).
- **`simctl` hangs forever (any subcommand)** until Xcode first-launch is completed — it spawns
  `xcodebuild -runFirstLaunch`, which does a **PackageKit system install** (needs admin/root).
  **Fix: a human runs `sudo xcodebuild -runFirstLaunch` once** (it cannot be done headlessly — it
  blocks on `AuthorizationCopyRights`). Non-hanging health check: `xcodebuild -checkFirstLaunchStatus`
  (exit 0 = done, 69 = pending).
- **`cargo run` deadlocks** through the nested agent shell (GNU Make jobserver-token deadlock; rustc
  sits at 0% CPU, no output) — even `CARGO_BUILD_JOBS=4` did not reliably help. **Fix: run the
  prebuilt binary directly** — `cd repos/server && ./target/debug/beebeeb-api` (the workspace has 4
  bins, so `cargo run` also needs `--bin beebeeb-api`). For mobile QA a slightly-stale server is fine.
- **Local API blob storage is LOCAL FILESYSTEM — safe for upload/download QA.** (Corrected
  2026-08-28; this entry previously claimed local uploads hit the prod Hetzner bucket. That is
  **wrong** and it wrongly ruled out local content QA for two months.) `repos/server/.env` sets
  `BLOB_STORE=local`, and `main.rs:1157` (`ensure_dev_local_pool`) idempotently guarantees exactly
  one ACTIVE `default` pool on disk at `BLOB_STORE_PATH`. Verified against the live dev DB: all 95
  `storage_pools` rows are `provider=local`, and the default is
  `file://…/repos/server/data/blobs`. The `S3_*` vars in `.env` are **inert** while
  `BLOB_STORE=local` — `main.rs:1252` only reads them under `BLOB_STORE=s3`. `live-src`/`live-tgt`
  are inactive (`is_active=f`) migration placeholders. Upload, download, offline pinning, and
  sharing are all locally testable; only push notifications and real-device-only surfaces need
  TestFlight.
- **Maestro `takeScreenshot`** silently drops relative paths — pass an **absolute** path, or capture
  with `xcrun simctl io <UDID> screenshot --type=png <abs>.png`. Tab/sub-tab labels with count badges
  (e.g. "By me 6") aren't reliable text targets — tap by `point: "x%,y%"`.
- **`clearState: true` does NOT sign out** — the master key persists in the iOS keychain across an
  app-data clear, so the app auto-restores to the authenticated screen (this is the 0876 restore
  working). To force the signed-out screen, sign out in-app first.
- **Local QA account:** `qa0688content@beebeeb.io` / `BeebeebQA0688content!` (OPAQUE, seeded files/
  photos; see `.claude/skills/beebeeb-test-accounts.md`).

## Stack

React Native + Expo (managed workflow) + TypeScript. Package manager: **bun**.

## Tests — run `bun run test`, NOT `bun test` (task 0877)

```sh
bun run test        # correct: per-file process isolation (155 pass / 0 fail)
bun test            # WRONG: leaky shared registry, reports ~10 phantom failures
```

bun 1.3.4 keeps `mock.module()` registrations on a **process-global** registry that is never
reset between test files, and `mock.restore()` does not undo them. The first file to register a
specifier wins for the entire run, so two files mocking the same module differently corrupt each
other — e.g. `api-client-session.test.ts` registers an empty `expo-file-system`, which starves
`welcome-seed.test.ts` of `cacheDirectory`.

`bun run test` invokes `scripts/test-isolated.mjs`, which gives every test file its own process
(the module-registry-per-file semantics jest has and bun lacks). Consequence for new tests:
**every test file must mock every native module it needs itself** — never rely on another file
having mocked it. Two tests were found relying on exactly that when isolation was introduced.

## API

Backend at `http://localhost:3001`. Same endpoints as the web client — see `repos/server/CLAUDE.md` for the full API reference.

## Design references

- `../../design/hifi/hifi-ios-app.jsx` — iOS screens (Home, Photos, Preview, Share, Settings, Biometric, Camera backup)
- `../../design/hifi/hifi-android-app.jsx` — Android screens
- `../../design/hifi/hifi-mobile-extra.jsx` — Offline, upgrade, share extension, push notifications
- `../../design/hifi/hifi-mobile-sync.jsx` — Mobile sync features

## Screens

- Files (tab) — pinned folders, recent files
- Shared (tab) — shared with me
- Photos (tab) — date grid, auto-backup indicator
- Settings (tab) — security, backup, app config
- File preview — PDF/image with actions
- Share sheet — bottom sheet with link settings
- Biometric lock — Face ID / fingerprint

## Brand

Same design tokens as web but converted to RGB (OKLCH not supported in React Native). See `src/theme.ts` for the color mapping.

## Thumbnails

Thumbnails are WebP format. **Medium (default) is 768px wide at WebP q0.82, ~100 KB target / 128 KB encrypted cap** — generated in `src/lib/thumbnail.ts` via expo-image-manipulator with a degrade ladder in `src/lib/thumbnail-policy.ts` for photos that exceed the byte cap. Small (384px) and large (1280px) variants exist for list-row + preview contexts.

**Native backup path (task 0631).** At backup time the native engine (`NativeBackupEngine.swift`) makes ONE high-quality PhotoKit source fetch (`thumbSourceMaxSize` = 1600px long-edge) per camera-roll photo/video and from it generates BOTH the medium (768px) and large (1280px) thumbnails **plus a blurhash**, via the shared `ThumbnailGenerator` (Rust `resizeForThumbnail` Lanczos3 + Swift `SDWebImageWebPCoder` WebP encode — not `CGImageDestination`). Medium PUTs to `/thumbnail?blurhash=…`, large to `/thumbnail/large`. Server stores these as reserved V1 chunk blobs: **medium = `u32::MAX` → `4294967295.bin`, large = `u32::MAX-2` → `4294967293.bin`** (there is no `thumbnail_large_encrypted` column; `files.has_large_thumbnail` flips true on the large PUT). The native blurhash comes from `BlurHashEncoder.swift` (self-contained woltapp encoder, 4×3 components, byte-identical to the JS `react-native-blurhash`). The legacy degraded-thumbnail regen worker (`ThumbnailService.regenerateThumbnail`, task 0553) also encodes through the same `ThumbnailGenerator.medium` ladder + 128 KB cap.

**Rendering layered (task 0552):**

1. **PhotoKit-first.** If a file has a `localIdentifier` in the camera-roll → PhotoKit serves the thumbnail directly via `PHImageManager.requestImage(for:targetSize:)`. No bandwidth, no decrypt cost, exact-pixel sizing for each tile. The identifier map is fetched from `GET /api/v1/files/photo-backup/identifiers` and cached in `src/lib/local-identifier-map.ts`.
2. **Encrypted-thumbnail fallback.** For files not in camera roll, the encrypted blob is downloaded + decrypted + cached.
3. **Blurhash placeholder.** ~25-byte unencrypted blurhash stored alongside the file metadata (`files.blurhash`) renders an instant gradient via `react-native-blurhash` while either pixel source resolves. Removes flash-of-empty-tile during scroll.

Thumbnail downloads use plain `fetch` (NOT `rateLimitedFetch`) because the server has a dedicated thumbnail rate limit tier (50k req/min per user). Cached at `documentDirectory/beebeeb-thumbnails-v3/{fileId}.{variant}.webp` (variant in the filename — important: a list view loading `small` no longer poisons a grid's `medium` lookup). Bulk backfill of degraded legacy thumbnails lives in Settings → Advanced → "Improve thumbnail quality" (task 0553).

Concurrency is managed by the thumbnail loading queue in `src/lib/thumbnail-cache.ts` (max 5 concurrent loads). The Settings → Performance slider controls **download behavior** (Data saver / Balanced / Smooth — when to prefetch encrypted thumbs), not thumbnail size.

## Crypto

Consumes `beebeeb-core` via UniFFI-generated Swift/Kotlin bindings. Crypto runs at native speed, not in JS. The master key never leaves Rust/the keychain — Swift holds an opaque `MasterKeyHandle` and all derivation/encryption happens inside core.

- **Bindings:** the generated Swift lives at `modules/beebeeb-crypto/ios/beebeeb_uniffi.swift` (the BeebeebCrypto pod compiles it as part of the module) and the static libs + C header are vendored in `ios/BeebeebCore.xcframework` (`libbeebeeb_uniffi.a` for device, `libbeebeeb_uniffi_sim_fat.a` for simulator). These are **generated artifacts** — regenerate them from `beebeeb-core`'s `build-ios.sh` (overwrite in place, no `pod install` needed since the podspec globs them) rather than hand-editing. They carry uniffi-bindgen template trailing whitespace; that is expected, not a lint failure to "fix".

- **Native backup uploads (`NativeEncryptedBackupUploader.swift`)** use the shared streaming primitive `ChunkEncryptorHandle`:
  - `ChunkEncryptorHandle.forPush(masterKey:, fileId:, fileSize:, profile: "mobile")` — `forPush` (not `fromFile`) because callers hold in-memory `Data`, not a file path.
  - `chunkPlan()` gives `{chunkSizeBytes, chunkCount}` (derived in core from profile + size — never hardcode a chunk size). Slice the plaintext into plan-sized chunks; `pushChunk(plaintext:)` returns an `EncryptedChunkDto{index, data}` whose `data` is the full `nonce||ct||tag` frame to PUT directly. Then `finish()` runs the integrity guard **before** `upload/complete`.
  - Wire contract preserved: `upload/init` still sends `size_bytes` = plaintext byte count (the server recomputes stored size from chunks); `chunk_count` comes from the plan.
  - Profiles are `"desktop" | "web" | "mobile" | "backup"`. The photo/contacts/calendar backup managers call `NativeEncryptedBackupUploader.shared.upload(plaintext:…)`; the HTTP transport is still Swift (URLSession), the encryption is core.


## Graphify

This repo has a knowledge graph at graphify-out/.
- Before exploring code, read graphify-out/GRAPH_REPORT.md for module structure and relationships
- After modifying code, run `graphify update .` and commit the updated graphify-out/
- The graph tracks modules, functions, types, and their relationships (calls, imports, inherits)
- Use `graphify query "<question>"` to ask questions about the codebase
- Use `graphify path "<A>" "<B>"` to find connections between two concepts

## Keep shared docs in sync

When you add/change/remove endpoints, types, build commands, or dependencies: update the relevant skill file in `/home/guus/code/beebeeb.io/.claude/skills/` (beebeeb-api.md, beebeeb-designs.md, beebeeb-stack.md, beebeeb-dev.md). Other agents depend on these being accurate.
