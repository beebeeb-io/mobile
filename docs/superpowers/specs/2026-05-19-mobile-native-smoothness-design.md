# Mobile Native Smoothness Design

Date: 2026-05-19
Status: Draft for review
Owner: Codex lead integrator

## Goal

Make the iOS app feel native and calm under real user data: thousands of photos, large folders, active camera-roll backup, and iOS Files integration. The app must not make the phone feel frozen, drain foreground bandwidth, or show encrypted placeholders when decrypted metadata is available.

This is a feature freeze for the affected surfaces. Until this work is complete, do not add new photo, files, backup, notification, or File Provider features except changes required by this plan.

## Non-Goals

- No marketing, visual restyle, or new product feature work.
- No TestFlight push until the full integrated gate passes.
- No broad app rewrite. React Native remains the app shell unless profiling proves a specific surface cannot meet budget.
- No crypto protocol changes unless a verified correctness bug requires it.

## Current Problems To Fix

1. Backup can saturate CPU, network, and native/JS bridge work while the user is active.
2. Backup disabling does not reliably stop active work immediately from the user's perspective.
3. Backup progress is inconsistent: some UI shows absolute totals, other UI shows "n of remaining".
4. iOS Files is slow and can show "Encrypted file"; the extension must not decrypt names or download bodies during enumeration.
5. Files tab and Photos tab can do too much metadata/decrypt/network work at screen-open time.
6. There are overlapping implementations for backup and File Provider behavior, which makes fixes fragile.

## Architecture Direction

Use a native-first critical path with React Native as the app shell.

React Native owns:

- Navigation and screen composition.
- Settings controls.
- Rendering cached lists and progress state.
- User actions that call native/cache APIs.

Native Swift owns:

- Camera-roll backup scheduler and lifecycle.
- iOS app-state, lock-state, low-power, thermal, and network policy.
- File Provider extension behavior.
- Local cache APIs exposed to React Native.
- Native thumbnail and materialization orchestration.

Rust owns:

- Crypto.
- Upload/download primitives where already available.
- Any high-volume parsing, hashing, metadata serialization, or cache helpers that benefit from deterministic native performance.

SQLite owns:

- File metadata cache.
- Photo/media index.
- Decrypted metadata cache after the vault is unlocked.
- Backup queue and progress state.
- File Provider cache.

## Performance Budgets

These are hard targets for physical iPhone verification.

- Files tab opens current folder metadata in under 500 ms from warm cache.
- Files tab does not download file bodies during listing.
- File Provider enumeration responds from SQLite only; no network, file-body download, or per-row crypto on the synchronous enumeration path.
- Photos grid first paint is under 700 ms from warm cache.
- Scrolling and pinch gestures do not perform full-size downloads or metadata decrypt bursts.
- Foreground backup must not saturate network. It should preserve interactive app use.
- Foreground active backup uses at most one active file upload and paced chunks.
- Locked/background/idle backup may run faster, but must still honor server rate-limit headers, low power mode, thermal state, and network policy.
- No unbounded `Promise.all` over user file/photo collections.
- No recursive full-vault scan from a screen open path.

## Dynamic Backup Scheduler

The app needs one camera-roll backup engine: native `NativeBackupEngine`. React Native should become a control and display layer. Any JS camera-roll runner must be removed from active startup, foreground, and manual backup paths after parity is verified.

Scheduler states:

| State | Trigger | Behavior |
| --- | --- | --- |
| `foreground_active` | App active, user interacting, visible screen not Backup Insights | Gentle: one file at a time, paced chunks, small batches, yield between files |
| `foreground_idle` | App active, no interaction for a short idle window | Moderate: one to two files at a time if phone is cool and on Wi-Fi |
| `background_unlocked` | App backgrounded and background time available | Moderate/aggressive within iOS limits |
| `locked_after_first_unlock` | Device locked and keychain material is accessible | Aggressive: use available background scheduling and network, still respect thermal/low power |
| `low_power` | Low Power Mode enabled | Pause or very gentle, depending on user setting |
| `thermal_pressure` | Thermal serious/critical | Pause uploads and encryption |
| `cellular` | Not on Wi-Fi and Wi-Fi-only enabled | Pause; otherwise gentle with explicit cellular policy |
| `server_backoff` | 429 or low remaining rate-limit headers | Pause until server reset/retry-after |

Inputs:

- `UIApplication.applicationState`
- screen/interaction activity from React Native
- device lock/background lifecycle where available
- `ProcessInfo.isLowPowerModeEnabled`
- `ProcessInfo.thermalState`
- `NWPathMonitor`
- charger/battery state if available
- server `Retry-After` and `X-RateLimit-*` headers

The scheduler publishes a single status model:

```ts
type BackupMode =
  | 'paused'
  | 'gentle'
  | 'moderate'
  | 'aggressive'
  | 'backing_off';

type BackupProgress = {
  totalAssets: number;
  uploadedAssets: number;
  failedAssets: number;
  pendingAssets: number;
  currentAssetOrdinal: number | null;
  currentFilename: string | null;
  currentBytesUploaded: number;
  currentBytesTotal: number;
  mode: BackupMode;
  reason: string | null;
};
```

User-facing progress should read as absolute progress: "800 of 9000 photos backed up". The current file can be secondary: "Now: IMG_1234.HEIC". "Remaining" can exist as secondary detail, never as the main counter.

## File Provider Design

The built File Provider must be the cache-first implementation.

Enumeration rules:

- `item(for:)` reads SQLite cache only.
- `enumerateItems` reads SQLite cache only and returns immediately.
- Background refresh may update cache after enumeration returns.
- Filename display uses `name_decrypted` from cache, or plaintext legacy names, or "Open Beebeeb to decrypt" only when the main app has not populated decrypted names.
- File bodies download and decrypt only in `fetchContents`.
- Opening a file materializes one file, not siblings or the containing folder.
- Subfolder enumeration refreshes only that folder metadata.
- File Provider logs must prove when enumeration occurs and whether network/download/decrypt was used.

Implementation cleanup:

- Identify which of `targets/file-provider/*` and `plugins/file-provider/*` is compiled into the current iOS target.
- Remove or disconnect the slow API/crypto-per-row File Provider path from the active build.
- Keep exactly one File Provider implementation active.
- Keep the extension process free of Face ID prompts.

## Files Tab Design

Files tab must be metadata-first.

Screen-open flow:

1. Read current folder rows from local SQLite/cache.
2. Render immediately with cached decrypted names and metadata.
3. Refresh the current folder from the API in the background.
4. Decrypt newly changed metadata in bounded batches after unlock.
5. Persist decrypted names/mime guesses into the shared cache for File Provider.
6. Do not download encrypted file bodies unless the user previews, exports, saves offline, shares, or opens a file.

Required behavior:

- A folder containing 10 GB of files must still list quickly because only metadata is loaded.
- No "Encrypted file" for rows whose decrypted name exists in cache.
- No recursive full-vault scan on folder open.
- Move/copy destination pickers must not call `listFiles()` root-only and pretend it has all folders. They need a folder cache/search strategy.

## Photos Design

Photos should use a native/cache-backed media index.

Screen-open flow:

1. Read media rows from local index.
2. Render thumbnail placeholders and cached thumbnails.
3. Refresh media index in background.
4. Generate or fetch thumbnails with strict concurrency.
5. Full download/decrypt only in preview.

Pinch/scroll rules:

- No metadata decrypt burst during gesture.
- No full image download during grid scroll.
- Use thumbnail tiers: small grid, larger preview placeholder, full preview.
- Keep active memory window small and deterministic.

React Native can keep rendering the grid initially. If profiling still shows JS/render bottlenecks after the cache/index rewrite, migrate the grid surface to native Swift as a separate approved task.

## Subagent Workflow

Codex lead integrator keeps control. Every implementation task has an engineer subagent and a reviewer subagent.

Engineer packet includes:

- Goal.
- Owned files/modules.
- Explicit non-owned files.
- Expected behavior.
- Verification commands.
- Required evidence.

Reviewer packet includes:

- The same goal and acceptance criteria.
- The engineer diff/output.
- A read-only review mandate by default.
- Required checks: scope, correctness, regressions, performance risk, tests, and missing evidence.

Task lifecycle:

1. Lead writes task packet.
2. Engineer implements only assigned scope.
3. Reviewer verifies independently.
4. Lead reviews engineer diff and reviewer report.
5. If accepted, lead integrates and runs the integration gate.
6. If rejected, task returns to engineer with concrete fixes.
7. No TestFlight until all accepted tasks pass the full gate.

Subagents must not:

- Change architecture decisions.
- Rename shared contracts without explicit approval.
- Modify unrelated feature surfaces.
- Mark work complete without evidence.
- Push builds or TestFlight releases.

## Workstreams And Task Packets

### 1. Baseline And Instrumentation

Engineer owns:

- Native logging around backup scheduler, upload start/end, mode changes, backoff, thermal/low-power/network state.
- File Provider logs proving enumeration vs materialization.
- RN timing logs for Files and Photos first paint, list update, metadata decrypt, thumbnail fetch.

Reviewer verifies:

- Logs are low overhead.
- Logs are actionable on physical iPhone.
- No sensitive data is logged.

Gate:

- Physical iPhone run captures backup, Files tab, Photos tab, and iOS Files traces.

### 2. Single Backup Engine

Engineer owns:

- Disable JS camera-roll backup active paths after native parity.
- Make RN call native start/stop/status only.
- Keep contacts/calendar out of this workstream. They can receive the same scheduler in a separate approved spec if needed.

Reviewer verifies:

- There is one camera-roll runner.
- Disabling backup stops scheduling new work immediately.
- Restart does not resurrect disabled camera-roll backup.

Gate:

- Toggle camera-roll backup off during active backup; no new file starts after current safe boundary.

### 3. Dynamic Backup Scheduler

Engineer owns:

- Native scheduler state machine.
- Policy table for concurrency, batch size, chunk pacing, pause reasons.
- RN activity signal for user interaction/foreground active.

Reviewer verifies:

- State transitions are deterministic.
- Low Power, thermal, cellular, server backoff, and app foreground are honored.
- No unbounded upload or encryption concurrency remains.

Gate:

- Physical iPhone: app remains responsive during foreground backup.
- Locked/background mode increases throughput when allowed.

### 4. Backup Progress Semantics

Engineer owns:

- Single progress model.
- Settings/Backup Insights/Photos banner text alignment.

Reviewer verifies:

- Main progress is absolute: uploaded of total.
- Current asset display is coherent.
- No "n of remaining" primary counter remains.

Gate:

- Screenshots from Photos and Backup Insights with the same totals.

### 5. File Provider Active Implementation Cleanup

Engineer owns:

- Confirm active extension source in Xcode project.
- Remove/disconnect slow File Provider implementation from active target.
- Ensure cache-first implementation is the only compiled extension path.

Reviewer verifies:

- Xcode project membership.
- No active per-row network or per-row crypto enumeration.
- Extension still builds and mounts.

Gate:

- iOS Files root and subfolders enumerate metadata from SQLite.
- Opening one file downloads only that file.

### 6. File Provider Cache Population

Engineer owns:

- Main-app cache population for root and opened folders.
- Batched decrypted metadata sync into shared SQLite.
- Enumerator signaling for changed folders.

Reviewer verifies:

- Names persist across app restart.
- Subfolders populate correctly.
- "Open Beebeeb to decrypt" appears only before the main app has unlocked and synced names.

Gate:

- Physical iPhone iOS Files shows real names for root and subfolders after unlock/sync.

### 7. Files Tab Cache-First

Engineer owns:

- Local metadata cache read path.
- Background folder refresh.
- Progressive name/mime hydration.
- Strict no-body-download listing invariant.

Reviewer verifies:

- Folder listing does not call download endpoints.
- Large folders remain responsive.
- Preview/export/offline are the only body-download actions.

Gate:

- 10 GB main folder scenario lists metadata quickly.

### 8. Photos Cache And Thumbnail Pipeline

Engineer owns:

- Local media index read path.
- Thumbnail tier policy.
- Strict concurrency and memory window.

Reviewer verifies:

- Grid scroll/pinch never downloads full images.
- Thumbnail requests are bounded.
- Preview shows cached thumbnail first, then full image.

Gate:

- Physical iPhone screen recording shows smooth pinch/scroll.

## Verification Gates

Per task:

- Targeted unit tests where pure logic exists.
- `bunx tsc --noEmit`.
- Native build through XcodeBuildMCP when Swift/Xcode files change.
- `graphify update .` after code changes.
- Reviewer sign-off.

Integrated gate:

- Physical iPhone test with active backup and app foreground usage.
- Physical iPhone iOS Files test: root, subfolder, open file, failure handling.
- Photos grid scroll and pinch recording.
- Files tab large-folder test.
- Backup disable/re-enable test.
- Low Power Mode test.
- Wi-Fi-only/cellular behavior test.
- Server 429/backoff simulation using a mocked response, local route, or staging route.
- Local production IPA build only after all above passes.

## Acceptance Criteria

The work is complete when:

- Backup no longer makes the iPhone feel frozen in foreground use.
- Backup runs faster when the phone is locked/idle, within OS and user policy.
- Disabling camera-roll backup visibly stops the active session without restart.
- Backup progress is absolute and consistent across screens.
- Files tab lists metadata quickly without downloading file bodies.
- iOS Files shows decrypted names after app unlock/cache sync.
- iOS Files opens files on demand without downloading siblings.
- Photos grid scroll and pinch are smooth on physical iPhone.
- There is one active camera-roll backup engine and one active File Provider implementation.
- TestFlight is built only after the full verification gate passes.
