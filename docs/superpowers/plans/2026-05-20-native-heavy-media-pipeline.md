# Native Heavy Media Pipeline Plan

Date: 2026-05-20
Owner: Codex
Status: Native preview, Rust streaming downloader, and native cancellation verified

## Goal

Keep React Native for product UI and move expensive iOS data-plane work to native code. The immediate target is media preview: downloading, decrypting, and writing preview originals must not allocate encrypted bytes, decrypted bytes, and base64 copies in the JS heap.

## First Milestone

1. Expose the existing Rust `downloadAndDecryptFile` UniFFI function through the iOS Expo module.
2. Add a TypeScript wrapper that accepts the native master-key handle, API URL, bearer token, file id, and output path.
3. Make `src/lib/native-decrypt.ts` prefer this native download+decrypt path for preview cache files.
4. Keep the existing JS decrypt path only as a fallback for native builds that do not yet expose the new function.
5. Wire `PreviewScreen` photo/video/PDF preview calls to pass the native master-key handle.

## Verification

- `bunx tsc --noEmit` passed.
- XcodeBuildMCP simulator build passed on `Beebeeb` / iPhone 17 Pro Max simulator.
- Simulator smoke test passed on logged-in account:
  - opened Photos tab
  - tapped `IMG_0406.HEIC`; image preview loaded as `1 of 13`
  - swiped to `IMG_0379.MP4` and `IMG_0365.MP4`; pager stayed active
  - swiped to `IMG_0337.JPG`; image preview loaded as `4 of 13`
  - opened a PDF from Files; PDF rendered inline
- runtime logs showed no native download/decrypt errors
- Process RSS after the smoke pass was about 501 MB.

## Rust Streaming Downloader

The Rust download path in `repos/core/beebeeb-upload/src/download.rs` now uses
`X-Chunk-Size` when present and decrypts the HTTP response incrementally. The
download path keeps only the current encrypted chunk buffered, writes decrypted
plaintext directly to the output file, and still falls back to the legacy
whole-body path for servers that do not send `X-Chunk-Size`.

Verification:

- `cargo test -p beebeeb-upload` passed.
- `cargo test -p beebeeb-uniffi download` passed.
- `cd repos/core && bash build-ios.sh` passed.
- `cd repos/mobile && bash scripts/update-ios-artifacts.sh` copied the rebuilt
  `BeebeebCore.xcframework` and Swift bindings into the iOS app.
- `bunx tsc --noEmit` passed after the artifact refresh.
- XcodeBuildMCP `build_run_sim` passed on `Beebeeb` / iPhone 17 Pro Max
  simulator after the artifact refresh.

## Preview Cancellation And Cache Bounds

The photo preview path now aborts stale JS-side preview requests when a page
unmounts or the active file changes. The UniFFI/Rust download path also polls a
native cancellation callback while sending the request, waiting for response
chunks, and decrypting/writing chunks, so stale native downloads can stop
mid-flight instead of only being ignored when they return. Both the generic
preview cache and the full-size photo cache are bounded by count, bytes, and
age.

Implementation:

- `src/lib/native-decrypt.ts` accepts an optional `AbortSignal`, forwards it to
  the JS fallback fetch, forwards it to the native module wrapper, checks
  cancellation around native decrypt calls, and prunes the generic preview
  cache.
- `modules/beebeeb-crypto/src/BeebeebCrypto.ts` creates native preview request
  ids and calls `cancelDownloadAndDecryptFileNative` when the JS abort signal
  fires.
- `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift` stores native
  cancellation callbacks per preview request and passes them into the UniFFI
  download callback.
- `repos/core/beebeeb-upload/src/download.rs` polls the callback cancellation
  flag before requests, while waiting for response chunks, between chunk
  decrypt/write operations, and removes temp output on cancellation.
- `repos/core/beebeeb-upload/src/retry.rs` has a cancellable retry helper so
  preview downloads also stop during retry backoff delays.
- `src/lib/photo-cache.ts` limits full-size decrypted photo cache to 6 memory
  entries, 12 disk entries, 256 MB, and 6 hours.
- `src/lib/photo-cache-policy.ts` contains the pure eviction policy with unit
  coverage.
- `src/screens/PreviewScreen.tsx` creates per-load `AbortController`s for
  photo pages and inline previews, ignores abort errors, and removes stale temp
  files after cancellation/caching.

Verification:

- `bun test src/lib/photo-cache-policy.test.ts src/lib/photo-viewer-window.test.ts`
  passed.
- `bunx tsc --noEmit` passed.
- `cargo test -p beebeeb-upload` passed.
- `cargo test -p beebeeb-uniffi download` passed.
- `cd repos/core && cargo build -p beebeeb-uniffi && cargo run --bin uniffi-bindgen -- generate --library target/debug/libbeebeeb_uniffi.dylib --language swift --out-dir beebeeb-uniffi/bindings` regenerated Swift bindings with `isCancelled()`.
- `cd repos/core && bash build-ios.sh` passed.
- `cd repos/mobile && bash scripts/update-ios-artifacts.sh` copied the rebuilt
  `BeebeebCore.xcframework` and Swift bindings into the iOS app.
- XcodeBuildMCP `build_run_sim` passed on `Beebeeb` / iPhone 17 Pro Max
  simulator.
- `graphify update .` passed in both `repos/mobile` and `repos/core`.

## Simulator Photos Performance Pass

On the iPhone 17 Pro Max simulator, the Photos grid was still rendering too
much work for the visible screen. A pre-fix `snapshot_ui` on the Photos tab
exposed photo cells all the way down to offscreen y positions around 3500, so a
small 107-item library was effectively mounted in one window. The preview
swipe path itself did not show an unbounded leak in this run, but the grid
setup would scale poorly with thousands of backed-up photos.

Implementation:

- `src/screens/PhotosScreen.tsx` now decrypts photo metadata only for the active
  viewport and a small initial window instead of decrypting every photo name and
  MIME type after each load.
- The active thumbnail window is capped at 96 ids and only extends a short
  buffer past the visible rows.
- The Photos `FlatList` now clips subviews, renders smaller batches, and uses a
  tighter window so offscreen cells are not kept mounted unnecessarily.
- Opening preview passes safe placeholder names instead of raw encrypted JSON
  when metadata has not been decrypted yet.

Verification:

- `bunx tsc --noEmit` passed.
- XcodeBuildMCP `build_run_sim` passed on `Beebeeb` / iPhone 17 Pro Max
  simulator.
- Post-fix `snapshot_ui` on the Photos tab exposed only visible rows through the
  bottom of the viewport instead of the entire 107-item section.
- Post-fix preview swiping through HEIC/MP4/JPG worked on simulator; process
  RSS returned to about 442 MB after the interaction settled.
- `graphify update .` passed in `repos/mobile`.

## Backup Idle And FileProvider Materialization Pass

The native backup engine was still waking while idle. The runtime symptom was a
repeated `backup.native.batch.start ... pending=0 running=true` log while the
app was open and all camera-roll items were already backed up.

Implementation:

- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift` now treats the drain
  loop as demand-driven. It exits quietly when SQLite has no pending uploads and
  wakes again only from explicit triggers such as start, resume, network
  restore, initial photo scan, or photo-library inserted assets.
- Empty pending batches now return before `backup.native.batch.start` is logged.
- `targets/file-provider/ApiClient.swift` now returns downloaded encrypted file
  data with `X-Chunk-Count` and `X-Chunk-Size` metadata.
- `targets/file-provider/CryptoBridge.swift` now decrypts the FileProvider
  download stream chunk-by-chunk instead of treating the whole response as one
  AES-GCM ciphertext.
- `targets/file-provider/FileProviderExtension.swift` passes cached plaintext
  size into the chunk-aware decrypt path during `fetchContents`.
- `scripts/perf-smoke-sample.sh` provides a repeatable PID sampler for simulator
  smoke runs. It records CPU/RSS samples and can summarize saved XcodeBuildMCP
  UI hierarchy snapshots.

Verification:

- XcodeBuildMCP `build_run_sim` passed after the backup idle fix.
- Runtime log check over 25 seconds showed `backup.native.start`,
  `backup.native.drain.wake`, and one pacing `mode` event, with no repeated
  empty `backup.native.batch.start` loop.
- XcodeBuildMCP `build_run_sim` passed after the FileProvider chunk-aware
  materialization patch.
- `bunx tsc --noEmit` passed.
- `scripts/perf-smoke-sample.sh --pid 55200 --out /tmp/beebeeb-perf/final-smoke
  --samples 6 --delay 0.25` passed and produced RSS/CPU summary output.

## Later Work

1. Add a native performance smoke test around preview swiping to track RSS and
   main-thread responsiveness.
2. Move the photo/video viewer UI itself to Swift if React Native gesture/paging
   still feels below iOS Photos quality after native data-plane work.
3. Apply the same native-heavy pattern to Files materialization and backup
   scheduling.
