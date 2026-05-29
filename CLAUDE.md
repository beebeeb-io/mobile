# beebeeb-io/mobile

Beebeeb for iOS and Android. React Native + Expo.

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

## Stack

React Native + Expo (managed workflow) + TypeScript. Package manager: **bun**.

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

Thumbnails are WebP format. **Medium (default) is 768px wide at WebP q0.82, capped at 100 KB on disk** — generated in `src/lib/thumbnail.ts` via expo-image-manipulator with a degrade ladder in `src/lib/thumbnail-policy.ts` for photos that exceed the byte cap. Small (384px) and large (1280px) variants exist for list-row + preview contexts. Video and DNG/RAW thumbnails are generated natively in Swift (`BeebeebCryptoModule.swift`) using `CGImageDestination` + `UTType.webP`.

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
