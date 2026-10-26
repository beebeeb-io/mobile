# Task 2233 — Android device feedback, round 1

Owner: Codex L3, solo. Worktree `/Users/guuslangelaar/code/bb-worktrees/fs-l3-android-2233`, branch `fs/l3-android/device-r1`, base mobile `origin/main` e9043c9. Workspace task: `.claude/tasks/in-development/2233-android-device-feedback-r1-photos-layout-menus-zip.md`, read from GitHub main because the local workspace ref lacks it. No workspace task edits outside this worktree.

Requested order: 5, 3/4, 7, 2, 6, 1. iOS behavior and visuals must remain unchanged. Only local fixtures/dev accounts may be used. Do not merge or access production, private keys, credentials.json or keystores.

Verification contract: each testable fix gets a regression observed red before repair, the isolated runner and `bunx tsc --noEmit`. Emulator screenshots are required for 2/3/4/7, generated ZIP reproduction for 6, emulator before/after JS FPS and first-thumbnail timing for 1. Guus's OnePlus confirmation remains the final device rung.

## Results so far

| Item | Implementation and evidence | Open rung |
| --- | --- | --- |
| 5 | Preview decrypt, keep-both filename and deletion copy use existing device helpers; iOS strings preserved. Red 1 pass/1 fail; isolated 2989 pass/0 fail across 288 files; tsc exit 0. | OnePlus confirmation |
| 3/4 | Shared inset helper removes Android's second reservation of the native bar. Android native container already gives the scene a height excluding the complete bar; iOS remains measured height + 12. Red 1/1; green 2/0; isolated 2991/0 across 289 files; tsc exit 0. | Android screenshots and OnePlus confirmation |
| 7 | Android uses BBActionSheet, with a gesture root inside its Modal. iOS keeps its popover and View root. Red 0/2; gesture-root red 2/1; isolated 2994/0 across 290 files; tsc exit 0. | Android screenshot and OnePlus confirmation |
| 2 | Android content padding uses measured header/overlay heights; getItemLayout includes top inset; title tint fade remains mounted. Four platform/scroll outcomes keep iOS fade gating intact. Red 0/2; isolated 2996/0 across 291 files; tsc exit 0. | Android screenshot, scroll-under-header visual check and OnePlus confirmation |
| 6 | Generated a 486-byte DEFLATE ZIP with three entries (root, nested, UTF-8); host probe used the preview's base64/ArrayBuffer conversion and JSZip. Generated 3 entries and existing fixture 2 entries parsed/extracted, 0 errors under Bun. This does not reproduce the Android failure. No speculative ZIP code change. | Emulator reproduction, diagnosis and fix |
| 1 | Pending after item 6; no performance fix or emulator numbers claimed. | Emulator baseline/profile, fix, after measurement |

The 3/4 implementation is one shared-helper commit because both controls already use it. This differs from the requested one-commit-per-individual-item granularity; the shared fix cannot be honestly attributed to only one control.

## Emulator blocker

The SDK at `~/Library/Android/sdk` has emulator 30.3.5 and no system images or AVDs. An API 36 Google APIs arm64 image and emulator 37.2.12 were downloaded into this task worktree, with a dedicated `bb-2233` AVD and port 5580. Both emulator versions exit **132** before an ADB device appears. The current version also exits 132 with `-no-accel -gpu swiftshader -verbose`. Logs end after resolving the system image; they do not establish the underlying cause. `-accel-check` reports Hypervisor.Framework; it does not prove a boot. No emulator screenshot or timing is available.

No signed development APK was found in the bounded local artifact search. Building/signing one would require a keystore; none was accessed. No production or dev-account sign-in was attempted. No child agents were spawned.

## Evidence and handoff

All full logs and the generated ZIP are under `~/code/bb-gate-logs/2233/`. Item logs: `5-{red,isolated,tsc}.log`, `34-{red,green,isolated,tsc}.log`, `7-{red,gesture-red,isolated,tsc}.log`, `2-{red,isolated,tsc}.log`. Emulator: `sdk-image.log`, `avd-create.log`, `emulator.log`, `emulator-software.log`; host-only ZIP probe: `6-host-probe.log`, fixture `2233-android.zip`.

Next step: restore emulator boot with a development client supplied without accessing keystores, use `10.0.2.2` for a lane-local API, capture 2/3/4/7 screenshots, then reproduce 6 and measure/fix 1 in that order. Keep the PR draft and task in review until the named rungs have evidence. Nothing here authorizes a merge or a production sign-in.

## Item 1 profiling handoff

The Android `FlatList` fallback uses `initialNumToRender=12`, `maxToRenderPerBatch=8`, `updateCellsBatchingPeriod=80`, `windowSize=5`. `handleViewableItemsChanged` defers active thumbnail IDs while `isScrollingRef` is set and flushes them at rest. The tile's `loadThumbnail` flag follows that active set. Screen prefetch and `useThumbnail` both use the JS thumbnail path; metadata updates also rebuild grouping/row props. These are profiling targets, not established causes. Do not tune batch/window sizes without a controlled baseline using the same fixture count/cache state and scroll gesture. Capture JS frame counts/elapsed time, dropped frames, and first-thumbnail load time before and after, in at least three matched runs. No performance change or before/after number is claimed by this PR.

Graphify refresh was attempted after the code changes: 787/787 files extracted; exit 1 because it refused to overwrite the existing 23908-node graph with 7186 nodes. The existing graph remains unchanged. This is a tooling limitation, not a successful refresh. The menu handler's final executable regression also pins web's existing Alert; Android joins iOS's app-options dispatch. Android-condition mutation: 2 pass/1 fail; restored: 3 pass/0 fail.

Final branch verification: `isolated: 2996 pass, 0 fail across 291 files`; `bunx tsc --noEmit` exit 0; `git diff --check` exit 0. Item 6 and item 1 checkpoints separately observed the same 2996/0 count and tsc exit 0. These are source/test results, not emulator/device proof. Full logs: `final-isolated.log`, `final-tsc.log`, `6-{isolated,tsc}.log`, `1-{isolated,tsc}.log` in the evidence directory.
