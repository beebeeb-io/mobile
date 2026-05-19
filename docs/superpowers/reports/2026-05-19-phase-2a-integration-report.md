# Mobile Native Smoothness Phase 2A Integration Report

Date: 2026-05-19
Status: Completed with remaining physical-device gates

## Scope

Phase 2A addressed the highest-risk foundations found in Phase 1:

- iOS Files now builds the cache-first File Provider source set instead of the slow plugin path.
- Native photo backup now has conservative pacing for active foreground use, low power, thermal pressure, and backoff.
- Backup progress copy now uses absolute progress instead of remaining-first wording.

This does not claim the whole app is perfect. Physical iPhone verification is still required before TestFlight because simulator builds cannot prove iOS Files materialization, locked-device backup behavior, or real-device thermal/network smoothness.

## Commits

- `567150a docs(mobile): plan smoothness phase 2a`
- `79ab584 test(mobile): guard file provider target sources`
- `f008c42 fix(mobile): activate cache-first file provider`
- `3c6e44c fix(mobile): pace native photo backup`
- `16f0d8e fix(mobile): show absolute backup progress`

## Verification

- `./scripts/verify-file-provider-target.sh`: passed with `File Provider target uses targets/file-provider sources`.
- `bunx tsc --noEmit`: passed.
- XcodeBuildMCP simulator build/run: passed for workspace `ios/Beebeeb.xcworkspace`, scheme `Beebeeb`, simulator `iPhone 17 Pro Max`.
  - Latest build log: `/Users/guuslangelaar/Library/Developer/XcodeBuildMCP/workspaces/beebeeb.io-4b6ae2343b4d/logs/build_run_sim_2026-05-19T17-50-28-319Z_pid9386_b5904362.log`
- `graphify update .`: passed.
  - Graphify rebuilt `16575` nodes and `22233` edges.
  - `graph.html` generation was skipped because the graph is too large.

## What Changed

### File Provider

`scripts/verify-file-provider-target.sh` rejects active `../plugins/file-provider/...` source references and requires all cache-first `../targets/file-provider/*.swift` source references.

The Xcode project now points the active File Provider target at:

- `targets/file-provider/FileProviderExtension.swift`
- `targets/file-provider/FileProviderItem.swift`
- `targets/file-provider/FileProviderEnumerator.swift`
- `targets/file-provider/CacheManager.swift`
- `targets/file-provider/ApiClient.swift`
- `targets/file-provider/CryptoBridge.swift`
- `targets/file-provider/KeychainKeyLoader.swift`
- `targets/file-provider/Constants.swift`
- `targets/file-provider/SyncEngine.swift`

The staged activation patch intentionally did not modify the plugin source tree.

### Native Backup

`NativeBackupEngine` now computes a pacing mode from app state, Low Power Mode, thermal state, and server backoff. Active foreground backup uses one file at a time with a paced delay. Background mode can use a larger batch limit. Stop/cancel guards prevent the next asset from starting after disable at the next safe boundary.

The native patch also redacted touched thumbnail logs so they no longer include local or server IDs.

### Progress Copy

Photos and Settings progress text now uses absolute progress:

- `completed of total photos/items backed up`
- `uploaded of total items backed up`

The patch did not add current-file claims because native does not yet publish current-asset metadata.

## Remaining Risks

- Physical iPhone iOS Files verification is still required:
  - root folder lists quickly from cache.
  - subfolders list quickly from cache.
  - opening text, PDF, image, and video files succeeds without `NSFileProviderErrorDomain -2015`.
- Physical iPhone backup verification is still required:
  - disabling camera-roll backup prevents new native assets from starting at the next safe boundary.
  - active foreground backup no longer saturates the phone.
  - locked/background backup behavior works within iOS limits.
- Photos grid and pinch performance are not fully solved by Phase 2A. There are broader dirty worktree edits in `PhotosScreen.tsx` that appear related, but they were not reviewed or committed as part of this phase.
- Several unrelated files remain dirty in the worktree. They must be audited before any production/TestFlight build.

## Next Recommended Gate

Run a physical iPhone verification pass before TestFlight:

1. Install the current local build on the physical iPhone.
2. Open iOS Files, browse Beebeeb root and nested folders, and open at least text, PDF, image, video, and large-file samples.
3. Capture device logs for File Provider enumeration and materialization.
4. Start camera-roll backup with the app active and confirm the phone remains usable.
5. Disable camera-roll backup mid-run and confirm no new assets start after the current safe boundary.
6. Lock the phone after unlock and capture backup behavior/logs.

Only after those pass should the TestFlight production build be considered.
