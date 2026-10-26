# Task 2233 — Android device feedback, round 1

Owner: Codex L3, solo. Worktree `/Users/guuslangelaar/code/bb-worktrees/fs-l3-android-2233`, branch `fs/l3-android/device-r1`, base mobile `origin/main` e9043c9. Workspace task: `.claude/tasks/in-development/2233-android-device-feedback-r1-photos-layout-menus-zip.md`, read from GitHub main because the local workspace ref lacks it. No workspace task edits outside this worktree.

Requested order: 5, 3/4, 7, 2, 6, 1. iOS behavior and visuals must remain unchanged. Only local fixtures/dev accounts may be used. Do not merge or access production, private keys, credentials.json or keystores.

Verification contract: each testable fix gets a regression observed red before repair, the isolated runner and `bunx tsc --noEmit`. Emulator screenshots are required for 2/3/4/7, generated ZIP reproduction for 6, emulator before/after JS FPS and first-thumbnail timing for 1. Guus's OnePlus confirmation remains the final device rung.

## Earlier results (superseded by the 2026-10-26 continuation below)

| Item | Implementation and evidence | Open rung |
| --- | --- | --- |
| 5 | Preview decrypt, keep-both filename and deletion copy use existing device helpers; iOS strings preserved. Red 1 pass/1 fail; isolated 2989 pass/0 fail across 288 files; tsc exit 0. | OnePlus confirmation |
| 3/4 | Shared inset helper removes Android's second reservation of the native bar. Android native container already gives the scene a height excluding the complete bar; iOS remains measured height + 12. Red 1/1; green 2/0; isolated 2991/0 across 289 files; tsc exit 0. | Android screenshots and OnePlus confirmation |
| 7 | Android uses BBActionSheet, with a gesture root inside its Modal. iOS keeps its popover and View root. Red 0/2; gesture-root red 2/1; isolated 2994/0 across 290 files; tsc exit 0. | Android screenshot and OnePlus confirmation |
| 2 | Android content padding uses measured header/overlay heights; getItemLayout includes top inset; title tint fade remains mounted. Four platform/scroll outcomes keep iOS fade gating intact. Red 0/2; isolated 2996/0 across 291 files; tsc exit 0. | Android screenshot, scroll-under-header visual check and OnePlus confirmation |
| 6 | Generated a 486-byte DEFLATE ZIP with three entries (root, nested, UTF-8); host probe used the preview's base64/ArrayBuffer conversion and JSZip. Generated 3 entries and existing fixture 2 entries parsed/extracted, 0 errors under Bun. This does not reproduce the Android failure. No speculative ZIP code change. | Emulator reproduction, diagnosis and fix |
| 1 | Pending after item 6; no performance fix or emulator numbers claimed. | Emulator baseline/profile, fix, after measurement |

The 3/4 implementation is one shared-helper commit because both controls already use it. This differs from the requested one-commit-per-individual-item granularity; the shared fix cannot be honestly attributed to only one control.

## Earlier emulator blocker (resolved in this continuation)

The SDK at `~/Library/Android/sdk` has emulator 30.3.5 and no system images or AVDs. An API 36 Google APIs arm64 image and emulator 37.2.12 were downloaded into this task worktree, with a dedicated `bb-2233` AVD and port 5580. Both emulator versions exit **132** before an ADB device appears. The current version also exits 132 with `-no-accel -gpu swiftshader -verbose`. Logs end after resolving the system image; they do not establish the underlying cause. `-accel-check` reports Hypervisor.Framework; it does not prove a boot. No emulator screenshot or timing is available.

No signed development APK was found in the bounded local artifact search. Building/signing one would require a keystore; none was accessed. No production or dev-account sign-in was attempted. No child agents were spawned.

## Evidence and handoff

All full logs and the generated ZIP are under `~/code/bb-gate-logs/2233/`. Item logs: `5-{red,isolated,tsc}.log`, `34-{red,green,isolated,tsc}.log`, `7-{red,gesture-red,isolated,tsc}.log`, `2-{red,isolated,tsc}.log`. Emulator: `sdk-image.log`, `avd-create.log`, `emulator.log`, `emulator-software.log`; host-only ZIP probe: `6-host-probe.log`, fixture `2233-android.zip`.

Next step: restore emulator boot with a development client supplied without accessing keystores, use `10.0.2.2` for a lane-local API, capture 2/3/4/7 screenshots, then reproduce 6 and measure/fix 1 in that order. Keep the PR draft and task in review until the named rungs have evidence. Nothing here authorizes a merge or a production sign-in.

## Item 1 profiling handoff

The Android `FlatList` fallback uses `initialNumToRender=12`, `maxToRenderPerBatch=8`, `updateCellsBatchingPeriod=80`, `windowSize=5`. `handleViewableItemsChanged` defers active thumbnail IDs while `isScrollingRef` is set and flushes them at rest. The tile's `loadThumbnail` flag follows that active set. Screen prefetch and `useThumbnail` both use the JS thumbnail path; metadata updates also rebuild grouping/row props. These are profiling targets, not established causes. Do not tune batch/window sizes without a controlled baseline using the same fixture count/cache state and scroll gesture. Capture JS frame counts/elapsed time, dropped frames, and first-thumbnail load time before and after, in at least three matched runs. No performance change or before/after number is claimed by this PR.

Graphify refresh was attempted after the code changes: 787/787 files extracted; exit 1 because it refused to overwrite the existing 23908-node graph with 7186 nodes. The existing graph remains unchanged. This is a tooling limitation, not a successful refresh. The menu handler's final executable regression also pins web's existing Alert; Android joins iOS's app-options dispatch. Android-condition mutation: 2 pass/1 fail; restored: 3 pass/0 fail.

Final branch verification: `isolated: 2996 pass, 0 fail across 291 files`; `bunx tsc --noEmit` exit 0; `git diff --check` exit 0. Item 6 and item 1 checkpoints separately observed the same 2996/0 count and tsc exit 0. These are source/test results, not emulator/device proof. Full logs: `final-isolated.log`, `final-tsc.log`, `6-{isolated,tsc}.log`, `1-{isolated,tsc}.log` in the evidence directory.

## 2026-10-26 L3 continuation — item 8

The lead supplied a booted `emulator-5554` (bb-pixel-36 / Android 36 arm64).
ADB readback: `get-state=device`, `sys.boot_completed=1`. L3 uses only explicitly
addressed ADB; the lead retains emulator process ownership. No child agents.

Item 8 routes the Files selection bar, FAB and upload card, Photos backup pill,
shared BottomSheet/BBActionSheet, FolderPicker footer, EncryptionProof, preview
DetailsSheet and preview bottom chrome/export/video/editor insets through
`glass/tab-bar-inset.ts`. Toast is top-anchored; ExportProgressBanner inherits its
parent position. Six sheet/card wrappers inherit the shared inset. Background
fills and child captions are deliberately excluded from the window-anchor list.
iOS's previous caller expressions pass through unchanged. The design ruling is
recorded in DEVIATIONS.md before the implementation.

Guard: 20 tests (12 anchor bindings, 6 inherited bindings, arithmetic and top/in-flow
exception). Original integration RED: 11 pass / 9 fail (`8-red-corrected.log`).
Fresh Android-rule mutation RED: 19 pass / 1 fail, expected 12 but received 116;
restored GREEN: 20 pass / 0 fail (`r3/8-{mutation-red,restored-green}.log`).
Fresh isolated run: **isolated: 3016 pass, 0 fail across 292 files**;
`bunx tsc --noEmit` exit 0 (`r3/isolated.log`, `r3/tsc.log`).

Correction to the earlier build blocker: a debug APK can be assembled with
Gradle signing disabled; access to a keystore is not necessary for assembly.
The current build uses the task-local Gradle home and an init script clearing
debug signing. Existing keystores, credentials.json and ~/.private_keys remain
untouched. Metro is explicitly configured for `http://10.0.2.2:3001`; the local
API was absent and is now started from the existing local debug binary, with
local DB URL validated and real mail disabled. Health returns HTTP 200.
Full evidence for this continuation: `~/code/bb-gate-logs/2233/r3/`.


## 2026-10-26 completed continuation — current review evidence

L3 remains solo. The lead's emulator-5554 was only operated through explicitly
addressed ADB; its process, AVD and disk image were not started, stopped or wiped.
No production sign-in, child agents, merge, credentials.json, ~/.private_keys or
existing keystore access. The local QA content account was used against
`http://10.0.2.2:3001`; Metro is on port 8223. The old statement that no account
sign-in was attempted is historical and superseded by this local-only run.

| Item | Current result | Local r3 evidence |
| --- | --- | --- |
| 1 | Remote-only MIME metadata no longer restarts a cached thumbnail. Decoder/window experiments were rejected; original rendering settings retained. Performance improvement is NOT closed; final-source measurements follow below. | `1-metadata-red.log`, `1-metadata-restored.log`, `1-ios-local-mutation-red.log`, `1-matched-comparison.json` |
| 2 | Content scrolls under the Photos title; gradient remains mounted. Top and scrolled screenshots inspected. | `2-photos-header-top.png`, `2-photos-header-scroll.png` |
| 3 | Backup pill sits immediately above native navigation with shared clearance. | `3-photos-backup-pill.png` |
| 4 | Files FAB sits above native navigation with its existing extra spacing. | `4-files-fab.png` |
| 5 | Existing platform-copy repair retained; isolated regressions pass. | Parent `5-red.log`; final suite below |
| 6 | Original failure NOT reproduced; no ZIP code change or root-cause/fix claim. Existing archive opens 3 files/2 folders; generated 486-byte archive opens 3 files, 116 bytes uncompressed. Root entry extraction opens Android's share sheet. | `6-existing-zip.png`, `6-generated-zip.png`, `6-root-entry.png`, `zip-final-settled-ui.jsonl`, `zip-root-extracted-ui.jsonl` |
| 7 | Preview overflow uses the themed app sheet, visually inspected without the Expo Tools overlay. | `7-preview-actions.png` |
| 8 | Selection bar and every inventoried bottom anchor use/inherit the helper. Native tab top y=2190; selection bar bottom y=2159: 31 physical pixels, consistent with 12dp at density 2.625. | `8-files-selection.png`, `selection-ui.jsonl`, `8-final-{mutation-red,restored-green}.log` |

Item 8 final guard count is **21**, including the upload-card inherited binding;
the earlier 20-test log preceded that last inventory entry. Fresh wrong-Android
arithmetic mutation: 20 pass/1 fail; restored: 21 pass/0 fail. This corrects the
earlier count without discarding its red-first evidence.

Item 1 real-hook RED: 3 pass/1 fail; restored: 5 pass/0 fail. The rejected background-decoder experiment
had RED 2 pass/1 fail and GREEN 3/0, but neither its prop nor its component test
ships. The shipping hook's iOS/local mutation fails 2 tests; restored: 5 pass/0 fail. iOS
retains its native request behavior, placeholder props, strings, measured insets,
popover and scroll-gated fade. No iOS native files or assets changed. Physical
iOS runtime testing was not performed in this Android lane.

The library's installed native `decodeAsync=false` path calls its decoder on the
UI thread; upstream documents asynchronous decoding for large-list stutters:
https://github.com/mrousavy/react-native-blurhash#asynchronous-decoding .
Both rejected decoder/window experiments and all provisional measurements remain in r3;
no decoder or batch/window tuning ships. Full results below use the corrected fixed-cache
protocol, not the earlier drifting-cache numbers.

ZIP next rung: obtain the actual failing archive and OnePlus error/log. Neither
was supplied with the original report, and both available emulator fixtures
open/extract. There is no demonstrated ZIP defect to repair red-first here.
A dev-only render error encountered after restarting Metro while its old client
was still running came from Expo HMR (`window.location.reload` unavailable),
not the ZIP parser; fresh app launch removed that instrumentation artifact.

Build correction: unsigned Gradle assembly succeeded (652 tasks: 624 executed,
28 up-to-date; 4m40s). The APK was signed using disposable PEM/PK8 material,
without a keystore, verified with apksigner and installed successfully. Existing
declared patches were applied only to a worktree-local copy of node_modules;
no dependency or lockfile change. `build-patched.log`, `apk-verify.log`,
`install.log`, `environment.log`, and bundle receipts capture this.

Graphify refresh: 790/790 files extracted; it refused to replace the existing
23908-node graph with 7197 nodes (exit 1). Existing graph preserved; generated
converted corpus removed after its count was captured. No forced overwrite.
`r3/graphify-update.log` contains the output.

Final source working-tree verification: **isolated: 3022 pass, 0 fail across
293 files**, `bunx tsc --noEmit` exit 0 (`1-isolated.log`, `1-tsc.log`, before the
rejected decoder experiment). A fresh
HEAD worktree gate is recorded in `final-gate-{isolated,tsc}.log` and
`final-gate-commit.txt` before push. Screenshots and receipts are indexed in
`screenshots.json`; all paths are under `~/code/bb-gate-logs/2233/r3/`.

PR ready-for-review is explicitly requested by Guus in this continuation,
superseding the earlier draft-only handoff. Performance-improvement proof, ZIP reproduction and final OnePlus
confirmation remain open; readiness does not close those rungs or authorize a
merge. The local API/Metro are left available for the lead's review; the emulator
remains owned by the lead.


### Item 1 final-source fixed-cache measurements

Three fresh app processes per version; 247 server media rows, identical 203-file
warm thumbnail cache (SHA256 asserted before every run), 12 identical 400ms
swipes per run. Baseline has the same dev timing trace and neither repair.
After is the shipping remote-MIME repair only, with original list/decoder settings.
TTF measures Photos focus to the first mounted grid Image.onLoad; frame numbers
come from Android `dumpsys gfxinfo framestats`, not JS FPS.

| Version/run | TTF ms | Janky/total frames | p95 ms |
| --- | ---: | --- | ---: |
| matched-before1 | 704 | 188 (70.41%) / 267 | 133ms |
| matched-before2 | 1033 | 214 (77.54%) / 276 | 125ms |
| matched-before3 | 562 | 190 (80.17%) / 237 | 150ms |
| matched-mime1 | 570 | 212 (81.85%) / 259 | 150ms |
| matched-mime2 | 702 | 197 (60.06%) / 328 | 105ms |
| matched-mime3 | 608 | 201 (73.36%) / 274 | 105ms |

Observed medians: **704 → 608ms TTF; 77.54 → 73.36% jank; 133 → 105ms p95**.
Aggregate counts: **592/780 → 610/861 janky/total frames** (75.90 → 70.85%).
Median hook requests: 282 → 278; repeated requests: 131 → 103. Remaining repeats
also include unmount/remount work; the targeted real-hook test proves the MIME
restart specifically, not elimination of all repeats.

These observations are not causal performance proof: shared-host load was
uncontrolled (after 1-minute averages 20.76, 21.06, 17.78), and debug-emulator
jank remains high. A quiet-host or physical OnePlus rerun is still required.
Rejected candidates and their worse numbers remain in r3; no decoder/window
tuning ships. Cache digest: `64dffcefbcd5a1f2c7ca4d1625457fe7b89ebb29860c9a41fc26b83264ba3f77`.
Full final summary: `1-matched-comparison.json`; raw runs: `1-matched-before{1,2,3}-*`
and `1-matched-mime{1,2,3}-*`. The superseded async comparison is explicitly
renamed `1-rejected-async-comparison.json`.
