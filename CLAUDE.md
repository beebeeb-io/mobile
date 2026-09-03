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
  with `xcrun simctl io <UDID> screenshot --type=png <abs>.png`.
- **NEVER tap chrome by coordinate. Use a `testID`.** This file used to advise
  `point: "x%,y%"` for labels with count badges. That advice caused a real outage of the whole e2e
  suite: task 1312 moved the tab bar up, and **22 coordinate taps across 9 flows** silently began
  missing their targets — three flows were red on `main` and nobody knew (task 1324). Worse,
  `full-app-test` stayed GREEN while asserting nothing, because its blind tap at `12%,95%` landed on
  a dev-redbox **Dismiss** button. **A coordinate tap can pass while testing nothing.**
  If an element has no testID, add one — that is cheaper than the flow rotting the next time the
  layout moves. Content-relative taps (a file row) are acceptable; chrome-relative taps are not.
- **A Maestro text selector must match the node's ENTIRE accessible name, and React Native's
  `accessibilityLabel` silently REPLACES the visible text.** So an assertion written from what you
  can see on screen is a guess. Three flows were broken by this in one day: the theme option reads
  "Dark" but its label is `"Dark theme"` (plus `", selected"` when active); the tabs read "By me" and
  "With me" but carry count badges. Use `id:` where you can, and a `.*`-anchored regex where you must
  (`"Dark theme.*"`). Read the label in the source — do not read the screen.
- **`clearState: true` does NOT sign out** — the master key persists in the iOS keychain across an
  app-data clear, so the app auto-restores to the authenticated screen (this is the 0876 restore
  working). To force the signed-out screen, sign out in-app first.
- **Local QA account:** `qa0688content@beebeeb.io` / `BeebeebQA0688content!` (OPAQUE, seeded files/
  photos; see `.claude/skills/beebeeb-test-accounts.md`).

## Simulators — two QA sims, one lane per sim (task 1353)

One shared simulator serialized every QA lane and caused real collisions (1348/1351 both drove
`bb-qa-1310` the same morning). There are now **two** sims so two lanes can verify in parallel —
**never share one sim across two lanes; claim one per lane for the session.**

- `bb-qa-1310` — `5F8915EB-2FE7-449E-9524-9E7306029ADD`, iOS 26.2, iPhone 17 Pro.
- `bb-qa-2` — `D7A6B303-B138-4EF5-ABEC-E23AEEE503FC`, iOS 26.2, iPhone 17 Pro.

**Dev-client copy procedure (no rebuild).** A new sim can get the dev client by copying the app
container off an already-built one instead of running `expo run:ios` again:

```sh
xcrun simctl create bb-qa-N "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-2
xcrun simctl boot <new-udid>
xcrun simctl bootstatus -b <new-udid>  # blocks until boot has finished
APP=$(xcrun simctl get_app_container <source-udid> io.beebeeb.app)
xcrun simctl install <new-udid> "$APP"
xcrun simctl launch <new-udid> io.beebeeb.app
```

**Stale-bundle / wrong-Metro deep-link refresh.** Point a booted dev client at a specific Metro
without touching the UI:

```sh
xcrun simctl openurl <udid> "beebeeb://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>"
```

**Gotcha — first open on a fresh install raises two one-time prompts, dismissable headlessly via
Maestro `--udid`.** On a simulator that has never had this URL scheme opened before, `openurl`
raises iOS's native `Open in "Beebeeb"?` (Cancel/Open) alert instead of connecting directly —
confirmed on `bb-qa-2`'s first connect (2026-09-02). Dismissing it does **not** need a human at the
screen — a one-line Maestro flow scoped to that one device with `--udid` does it:

```yaml
# tap-open.yaml
appId: io.beebeeb.app
---
- tapOn: "Open"
```

```sh
env -u NODE_OPTIONS maestro --udid <udid> test tap-open.yaml
```

Once dismissed, the app connects to Metro and immediately shows the dev-client's first-run
"developer menu" explainer sheet ("This is the developer menu…") — a **second**, separate one-time
prompt. Dismiss it the same way with a `tapOn: "Continue"` flow. After both, the app is running the
Metro bundle and the in-app dev menu (Reload / Go home / Tools) responds normally — screenshots
`docs/_qa-evidence/glass-wave-2/1353-bb-qa-2-connected.png` (the "developer menu" sheet, mid-dismiss)
and `1353-bb-qa-2-app.png` (dev menu live, `Tools button` toggle visible and ON). Neither prompt
reappears on that device once dismissed once.

**Always pass `--udid` naming the sim the lane owns.** A bare `maestro test` picks whatever
simulator Maestro finds, which can be the WRONG one when two lanes are running — see "one lane per
sim" above. This is exactly why `bb-qa-1310` must never be touched by a lane that doesn't own it:
an un-scoped Maestro command is the mechanism that would leak input onto it.

**The expo-dev-client floating "Tools" gear is a tap trap.** It sits at roughly `(8%, 47%)` and
silently swallows taps in that region (Maestro `tapOn` reports COMPLETED but nothing happens) —
turn "Tools button" off in the in-app dev menu on each sim you drive with Maestro. It's a per-device
dev-client preference (not repo state), so it must be set again on any new sim, including a fresh
`bb-qa-N` created via the copy procedure above.

## Maestro — shared-driver limits, native pickers, and selector gotchas (task 1350)

- **One `maestro test` at a time, machine-wide.** Extra simulators (see "two QA sims" above) do not
  buy parallel e2e — the XCUITest driver and CPU are the shared resource, not the simulator. Three
  lanes driving three sims at once took the load average past 40, with taps taking 30-90s and
  elements reported "not found" that were plainly on screen. Only one lane may hold the Maestro
  driver at a time, granted by the lead; `xcrun simctl io` screenshots may still overlap freely.
- **An idle-but-still-attached driver on ANY simulator poisons new driver bootstraps on ALL of
  them.** `xcodebuild test-without-building` and its `maestro-driver-iosUITests-Runner` arbitrate
  through one host-level `testmanagerd`, so this is machine-wide, not per-device. Symptom: a brand
  new run backgrounds the app to the Home Screen before the flow's first assertion, and Maestro
  reports "found nothing to terminate". Proven by controlled test (2026-09-02): a cold, never-driven
  sim failed identically until an orphaned driver on a *different* device was killed, then ran clean.
  After every run, check `pgrep -f 'xcodebuild test-without-building'` and kill only your own
  orphan by PID (verify its `-destination id=` first) — never `pkill -f xcodebuild`, which takes out
  other lanes and this Mac's other projects too.
- **ROOT CAUSE FOUND (task 1360, 2026-09-03): a tap reports COMPLETED and the app never changes
  state because the installed Maestro CLI is FOUR MONTHS OUT OF DATE.** Maestro resolves the
  element, taps it, reports COMPLETED, and the next assertion fails against a screen identical to
  the one before the tap. It is NOT "element not found" and NOT "element covered", NOT a product
  bug, and NOT device state — **it is the driver.** The Mac's shared install is
  **Maestro 2.5.1** (`~/.maestro`, installed 1 May); upstream is **2.10.0** (2026-08-31), five
  minors and about four months ahead. Same simulator (`bb-qa-1310`), same flow
  (`file-preview-test.yaml`), no retries either side: **2.5.1 failed 9 of 15 runs; an isolated
  2.10.0 binary passed 15 of 15.** Runs were also ~30% faster on 2.10.0 (~23s apart vs. 28-38s). A
  second simulator, `bb-qa-2`, was checked too and was *worse* under 2.5.1 (10 failures in 10
  completed runs, 2 more that never reached a verdict) — ruling out "one simulator has bad state"
  before the version test even ran.

  **The shared install has NOT been upgraded.** `~/.maestro` (2.5.1) is used by other projects on
  this machine, so this workspace does not upgrade it unilaterally — that decision is queued for
  Guus. Until he decides, **the flows below carry a bounded retry as an interim mitigation** (see
  below). If you're reading this after the upgrade landed, the retries are stale scaffolding for a
  fault that no longer exists — remove them and go back to a plain `tapOn` + single assertion; check
  `maestro --version` first to confirm you're actually past 2.5.1 before you rip them out.

  **Two traps if you re-run this comparison yourself (both cost real time to find):**
  1. `grep -i repeat` on a 2.10.0 run's log is USELESS for checking "did it retry" — it returns
     dozens of hits that are all `repeatable=` fields inside `CommandMetadata` log noise, none of
     them an actual retry command. Check `commands.json` for a real `repeatCommand` entry instead,
     or count `Tap on id: X` occurrences for the control you care about.
  2. **2.10.0 changed the artifact layout**: it writes a `<flow-name>/` **directory** where 2.5.1
     wrote a single `commands-(<flow-name>.yaml).json` file. A script that greps for the old
     filename shape will silently find nothing and undercount — this produced a false "zero runs"
     read on the first attempt at this comparison.

  **Diagnose before you touch anything.** Read the failure screenshot first. If it shows the
  PRE-tap state — the exact same screen the flow was already on — you are looking at this fault,
  not a regression. A genuine regression looks different: a partially-applied state, an error, or a
  screen that changed but changed *wrong*. Every failure instance collected for task 1360 (12+
  screenshots across `select-mode-enter`, `search-cancel`, the search kind-filter capsules, and
  `preview-close`) showed a clean pre-tap freeze, never a different-looking broken screen. If yours
  doesn't match that shape, stop — you may have a real bug, not this fault.

  **The mechanism was confirmed at the JS level too, before the version was known to be the cause.**
  A temporary `console.log` at the top of the handler (`handleClose` in PreviewScreen,
  `enterSelectMode`/`handleSearchToggle`/the kind-filter `onPress` in FilesScreen) proved the JS
  callback **never runs** on a failing tap — absent from the Metro log every single time, present
  every time the tap actually worked. It also proved this is not a slow-JS-thread problem: on 5
  deliberate 8-second post-failure holds (plus one accidental 2-minute hold when a harness script
  crashed and left the app untouched) the handler log never showed up late either. The touch was
  lost before it reached React Native's responder system — consistent with a driver-level fault, and
  now explained by one: the old CLI. That instrumentation has been removed (its job is done); do not
  re-add it to chase this specific fault — the version gap is the answer.

  **Interim mitigation (remove once `~/.maestro` is upgraded past 2.5.1): retry the ACTION, never
  the assertion.** `search-test.yaml` and `file-preview-test.yaml` wrap every affected tap in a
  bounded `repeat...while` that re-taps up to 5 times while the expected post-tap state is still
  absent, followed by the ORIGINAL, unmodified, single-shot assertion. This is a workaround, not a
  fix — it absorbs the fault rather than removing it, and a retry loop would just as easily mask a
  real intermittent product bug of the same shape, which is exactly what upgrading avoids. Prefer
  the upgrade over extending this pattern to new controls if the upgrade decision lands first.
  ```yaml
  - repeat:
      times: 5
      while:
        notVisible:
          id: "select-mode-cancel"
      commands:
        - tapOn:
            id: "select-mode-enter"
  - assertVisible:
      id: "select-mode-cancel"
  ```
  If the tap keeps failing to land, this fails for real — a genuine regression still goes red, it
  just takes up to 5 attempts to prove it consistently isn't landing rather than one unlucky tap.
  **Never retry the assertion itself** (no widening a timeout, no `extendedWaitUntil` bolted onto an
  assertion that used to be immediate, no swallowing the failure) — that is a loosened test wearing
  a disguise, and it is exactly how a real regression would get through unnoticed. Any retry is also
  **loud by construction**: Maestro's own CLI output prints `Repeat while ... (up to N times)` plus
  one line per attempted tap, so a flow that needed 2 or 3 attempts is visible in the run's own log
  and artifacts, not silently absorbed.

  **This pattern is only safe when the tapped action is idempotent — "set to state X", not
  "toggle".** Every control wrapped so far (enter select mode, select a search filter, cancel out of
  search, close a preview) is a one-way move: tapping it again after it already worked is a harmless
  no-op, because the `while` condition is already false and the loop exits before a second tap ever
  fires. A **toggle** control (flips between two states on each tap) is NOT safe to wrap this way: if
  the first tap actually lands but the visibility check races it — the check runs before the UI has
  finished updating — the loop can fire a second tap that flips the toggle straight back, and the
  flow fails with the exact same "COMPLETED, no state change" shape as this fault, except the cause
  this time is the retry itself undoing a tap that worked. That failure is very hard to tell apart
  from the real bridge fault by symptom alone, so do not add this pattern to a toggle control without
  first picking a `while` condition that is unambiguous about which of the toggle's two states is
  the *pre*-tap one — and prove it live, the same way the `search-cancel` mistake below was caught by
  running the flow, not by reading the YAML.

  Picking the `while` condition is the one place this is easy to get subtly wrong — validate it
  live before trusting it. The first attempt at wrapping the second `search-cancel` tap in
  `search-test.yaml` used `notVisible: "Drive"`, which looked right by analogy to a neighboring
  `extendedWaitUntil: visible: "Drive"` — but the folder title stays rendered in the header
  throughout active search, so that condition was **already false before the tap**, and Maestro's
  `repeat` correctly but unhelpfully **skips the whole body** when `while` starts false — the tap
  never fired at all. Caught by actually running the flow, not by reading the YAML. Use whatever
  element genuinely flips state across the tap (here, `search-bar`'s own visibility), and prove it
  by running the flow, not by pattern-matching a neighboring block.

  Controls covered so far: `select-mode-enter`, both `search-cancel` occurrences, and
  `search-filter-photos`/`search-filter-videos` in `search-test.yaml`; `preview-close` in
  `file-preview-test.yaml`. This fault is a bridge-level problem, not specific to these controls —
  if you hit the same COMPLETED-but-frozen shape on a control not listed here, diagnose it the same
  way (instrument the handler, confirm the log is absent not late, confirm the screenshot shows the
  pre-tap state) before assuming it's covered by analogy, then add the same `repeat...while` shape.

- **The row "…" overflow menu is a native menu Maestro cannot tap.** `tapOn` reports COMPLETED, the
  menu stays open, and it blocks all further input until the app is terminated. Its items also carry
  a leading `", "` in their accessible name. Route to the share sheet with a row swipe RIGHT
  ("Share <filename>") instead.
- **`UIDocumentPickerViewController` exposes only "Cancel" and the system keyboard to XCUITest** —
  no Recents/Browse rows, independent of file type, so a document cannot be seeded into the app by
  automation at all (confirmed by hierarchy dump, not just a flaky tap). Workaround: copy the file
  directly into the simulator's local File Provider storage so it appears under "On My iPhone", then
  a human finishes with two taps. `xcrun simctl addmedia` rejects anything non-media
  (`File type unsupported`) so it can't shortcut this for docs.
- **Never `simctl openurl` a dev-client deep link into an already-running app.** It can orphan the
  native view — a solid white screen that survives a simulator reboot while JS keeps running
  underneath. Terminate the app first, then `openurl`.
- **`scrollUntilVisible` + `tapOn` with an `id:` selector can fail to find a row that is genuinely
  off-screen, even though the same `id:` resolves fine once the row is already on screen.**
  Reproduced directly on `dark-mode-test.yaml` (task 1352): from a cold launch, the Appearance
  control is several screens below the fold (Account/Storage/Backup/Devices render above it), and
  `scrollUntilVisible: { element: { id: "appearance-dark" } }` failed 3/3 real attempts —
  `maestro hierarchy` confirmed the `resource-id` was present and correct the whole time, so this
  isn't a missing/renamed testID. Swapping only the *scroll* target to a `text:` regex
  (`"Dark theme.*"`, the row's accessibilityLabel) fixed it 3/3, while the `tapOn` and the
  post-tap `assertVisible` stayed on `id:`. Lesson: prefer `id:` for the tap and the assertion (an
  `id:` lookup against the CURRENT hierarchy is reliable), but if a `scrollUntilVisible` targeting an
  `id:` won't find an element you can see is there, fall back to a `.*`-anchored text regex for the
  scroll only — this is the "regex where you must" case the rule below already describes, not a new
  exception to it.
- **A `launchApp` can leave a stale accessibility-bridge attach that makes the very next
  interaction fail against a screen that is visibly correct.** Symptom: `extendedWaitUntil`/`tapOn`
  on an element that is plainly on screen (and present in a `maestro hierarchy` dump) times out or
  hangs — not "element not found because it's covered", but present-and-still-not-found. A full
  `xcrun simctl terminate <udid> io.beebeeb.app` followed by `xcrun simctl launch <udid>
  io.beebeeb.app` **before** the flow's own `launchApp` clears it reliably — confirmed directly:
  a `dark-mode-test.yaml` run hung for 10+ minutes at almost 0% CPU right after `launchApp`, killing
  it and doing the terminate+launch cycle first made every subsequent run (5 in a row, across three
  different flows) start clean. `launchApp`'s own relaunch does not fix this on its own; the
  external `simctl` cycle does.
- **`pressKey: Enter` on the password field submits the sign-in form reliably** — confirmed
  directly (`LoginScreen.tsx`: the password `TextInput`, `testID="password-input"`, wires
  `onSubmitEditing={handleLogin}`) — and is a cleaner alternative to the documented coordinate tap
  that dismisses the keyboard before tapping `sign-in-button`. In this session's own testing that
  coordinate tap was reliable every time (5/5 across `login-test.yaml` and
  `local-qa-signin-unlock.yaml` runs today), so this isn't "the tap is broken" — but if you hit the
  keyboard-covers-the-button or clears-the-field failure another lane saw, `pressKey: Enter` right
  after typing the password is the fix, and it's one step instead of two.

## QA account hygiene (task 1356)

The local QA account (`qa0688content@beebeeb.io`) got silted up with lanes' throwaway test data
and had to be cleaned — 17 files moved to Trash. What's left is a deliberate fixture set: **do not
touch, duplicate, or delete any of these "because it looks like junk"** — every one below is load-
bearing for a specific flow, and a fixture with no stated purpose is the first thing a future lane
deletes by mistake.

- `qa-red.png` / `qa-blue.png` / `qa-green.png` — small photo fixtures for pin, offline, and
  thumbnail tests.
- `medium-photo.jpeg` — the 2 MB perf-baseline tier (task 1345).
- `big-photo.jpeg` — the large photo fixture.
- `clip-1080p.mp4` — the short video fixture; `search-test.yaml` searches "clip" against this
  file's exact name.
- `clip-1080p (3).mp4` — the 40 MB perf-baseline tier (task 1345). A SEPARATE file from
  `clip-1080p.mp4` above, on purpose: the perf comparison needs the same file run over run, so it
  can't share a name/identity with the search-test fixture.
- `qa-1301-video.mp4` — the 213 MB throughput fixture.
- `qa-hevc.mp4` — HEVC decode coverage.
- `qa-video.mp4` — a 23 kB fixture for a fast round-trip check.
- The empty folder named `Quarterly Financial Reports And Tax Documents 2026 Archive` — the
  absurd length IS the point, it's the truncation/breadcrumb fixture for task 1341. Do not rename
  or shorten it.

Rules for lanes using this account:

- Prefix any throwaway upload with your task id, so the next cleanup can tell what's safe to trash.
- Delete your own throwaway uploads at the end of your lane, whether it succeeded or failed —
  `bb rm <id>` is reversible (Trash, not purge).
- Never repurpose one of the fixtures above for something else, even temporarily.
- If a file fails to decrypt and it isn't already documented as broken by tasks 1349/1351, stop
  and flag it — don't upload past it and mask the failure.

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

- **Manual uploads are native too (task 1310, `NativeManualUploader.swift`).** `encryptedUpload()` in
  `src/lib/encrypted-upload.ts` routes through `uploadEncryptedFileNative()` (api.ts) whenever the caller
  passes `masterKeyHandleId` (FilesScreen, DocumentScanner, ConstellationScanner do). JS keeps the
  storage-v2 protocol — `planUploadChunksNative(size)` (core `planChunks`, profile `"mobile"`) →
  `/api/v1/uploads/init` with that plan → resume state → `complete` → encrypted-name patch — and the
  Swift engine does the rest: `ChunkEncryptorHandle.fromFile` + `nextChunk()` straight from disk,
  `URLSession.upload(for:from:delegate:)` PUTs with `didSendBodyData` byte-level progress, 429/5xx/network
  retry with backoff. JS polls `getUploadProgressNative(requestId)` every 150 ms. Errors come back as a
  `{"bb_upload_error":true,status,code,message}` envelope that `native-upload-bridge.ts` turns back into an
  `ApiError`. Plaintext never enters the JS heap. The old JS chunk loop (`uploadEncryptedChunked`,
  base64 round-trips — measured at ~1 s of pure JS per 4 MiB chunk on an M-series Mac) stays only as the
  fallback for callers without a key handle / servers without v2. Never reintroduce base64 file reads in
  the upload path.


## Graphify

This repo has a knowledge graph at graphify-out/.
- Before exploring code, read graphify-out/GRAPH_REPORT.md for module structure and relationships
- After modifying code, run `graphify update .` and commit the updated graphify-out/
- The graph tracks modules, functions, types, and their relationships (calls, imports, inherits)
- Use `graphify query "<question>"` to ask questions about the codebase
- Use `graphify path "<A>" "<B>"` to find connections between two concepts

## Keep shared docs in sync

When you add/change/remove endpoints, types, build commands, or dependencies: update the relevant skill file in `/home/guus/code/beebeeb.io/.claude/skills/` (beebeeb-api.md, beebeeb-designs.md, beebeeb-stack.md, beebeeb-dev.md). Other agents depend on these being accurate.
