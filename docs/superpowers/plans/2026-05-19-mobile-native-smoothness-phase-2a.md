# Mobile Native Smoothness Phase 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two worst iOS pain points measurably safer: iOS Files must enumerate from the cache-first File Provider path, and camera-roll backup must stop being an unbounded foreground grinder.

**Architecture:** Keep React Native as the shell, but move critical pressure decisions into native Swift. Phase 2A is intentionally narrow: activate the existing cache-first File Provider target path, add verification guardrails so the slow plugin path cannot silently return, and add native backup pacing/disable semantics before broader Photos/Files UI rewrites.

**Tech Stack:** Expo React Native, Swift File Provider extension, Swift native backup engine, Rust `beebeeb-core` bindings, SQLite cache, XcodeBuildMCP for iOS simulator/device verification.

---

## Preflight For Every Task

- Read `CLAUDE.md`, especially the local build and Graphify requirements.
- Read `graphify-out/GRAPH_REPORT.md` before exploring code.
- Read `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md`.
- Read `docs/superpowers/reports/2026-05-19-phase-1-integration-report.md`.
- Run `git status --short` and do not revert or stage unrelated dirty worktree changes.
- If using XcodeBuildMCP, first read the installed `build-ios-apps:ios-debugger-agent` skill and call `session_show_defaults` before build/run/test tools.

## Files And Ownership

- File Provider activation owner:
  - Modify: `ios/Beebeeb.xcodeproj/project.pbxproj`
  - Modify only if compile errors require it: `targets/file-provider/*.swift`
  - Do not modify: `plugins/file-provider/*` except in a separate cleanup task.
- File Provider guardrail owner:
  - Create: `scripts/verify-file-provider-target.sh`
  - Modify: `package.json` only if adding a script entry is necessary.
- Backup pacing owner:
  - Modify: `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`
  - Modify: `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift` only if a JS-exposed user-active signal is required.
  - Modify: `modules/beebeeb-crypto/src/BeebeebCrypto.ts` only if the native module surface changes.
- Backup RN signal owner:
  - Modify: `src/App.tsx`
  - Modify: `src/lib/backup-context.tsx`
  - Do not mount `PhotoBackupBridge`.
- Reviewers are read-only unless the lead explicitly asks for a fix.

## Task 1: File Provider Target Guardrail

**Files:**
- Create: `scripts/verify-file-provider-target.sh`

- [ ] **Step 1: Create a failing guardrail script**

Create `scripts/verify-file-provider-target.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

project_file="ios/Beebeeb.xcodeproj/project.pbxproj"

if rg -n 'path = "../plugins/file-provider/' "$project_file"; then
  echo "File Provider target still references plugins/file-provider; expected targets/file-provider" >&2
  exit 1
fi

required=(
  "../targets/file-provider/FileProviderExtension.swift"
  "../targets/file-provider/FileProviderItem.swift"
  "../targets/file-provider/FileProviderEnumerator.swift"
  "../targets/file-provider/CacheManager.swift"
  "../targets/file-provider/ApiClient.swift"
  "../targets/file-provider/CryptoBridge.swift"
  "../targets/file-provider/KeychainKeyLoader.swift"
  "../targets/file-provider/Constants.swift"
  "../targets/file-provider/SyncEngine.swift"
)

for path in "${required[@]}"; do
  if ! rg -F "path = \"$path\"" "$project_file" >/dev/null; then
    echo "Missing File Provider source reference: $path" >&2
    exit 1
  fi
done

echo "File Provider target uses targets/file-provider sources"
```

- [ ] **Step 2: Make the script executable**

Run:

```bash
chmod +x scripts/verify-file-provider-target.sh
```

- [ ] **Step 3: Verify it fails before target activation**

Run:

```bash
./scripts/verify-file-provider-target.sh
```

Expected before Task 2: fail with `File Provider target still references plugins/file-provider`.

- [ ] **Step 4: Commit the guardrail only**

Run:

```bash
git add scripts/verify-file-provider-target.sh
git commit -m "test(mobile): guard file provider target sources"
```

## Task 2: Activate Cache-First File Provider Target

**Files:**
- Modify: `ios/Beebeeb.xcodeproj/project.pbxproj`
- Modify only if the build proves it is needed: `targets/file-provider/*.swift`

- [ ] **Step 1: Replace active File Provider source references**

In `ios/Beebeeb.xcodeproj/project.pbxproj`, the active File Provider target currently references:

```text
../plugins/file-provider/BeebeebFileProvider.swift
../plugins/file-provider/FileProviderItem.swift
../plugins/file-provider/FileProviderEnumerator.swift
../plugins/file-provider/FileProviderCrypto.swift
../plugins/file-provider/FileProviderAPIClient.swift
```

Replace the active extension source set with these cache-first files:

```text
../targets/file-provider/FileProviderExtension.swift
../targets/file-provider/FileProviderItem.swift
../targets/file-provider/FileProviderEnumerator.swift
../targets/file-provider/CacheManager.swift
../targets/file-provider/ApiClient.swift
../targets/file-provider/CryptoBridge.swift
../targets/file-provider/KeychainKeyLoader.swift
../targets/file-provider/Constants.swift
../targets/file-provider/SyncEngine.swift
../targets/file-provider/Info.plist
```

The source build phase must compile the nine Swift files above. The Info.plist must remain the File Provider extension Info.plist, not a compiled source.

- [ ] **Step 2: Run the guardrail**

Run:

```bash
./scripts/verify-file-provider-target.sh
```

Expected: `File Provider target uses targets/file-provider sources`.

- [ ] **Step 3: Build locally with XcodeBuildMCP**

Use XcodeBuildMCP, not cloud EAS. Before the first build call, verify defaults with `session_show_defaults`.

Expected: simulator build succeeds for workspace `ios/Beebeeb.xcworkspace`, scheme `Beebeeb`.

- [ ] **Step 4: Verify File Provider compile membership**

Run:

```bash
rg -n "plugins/file-provider|targets/file-provider|FileProviderExtension.swift|FileProviderEnumerator.swift|CacheManager.swift|ApiClient.swift|CryptoBridge.swift|KeychainKeyLoader.swift|Constants.swift|SyncEngine.swift" ios/Beebeeb.xcodeproj/project.pbxproj
```

Expected: no `plugins/file-provider` references in the File Provider target membership; `targets/file-provider` references are present.

- [ ] **Step 5: Commit only target activation files**

Run:

```bash
git add ios/Beebeeb.xcodeproj/project.pbxproj targets/file-provider
git commit -m "fix(mobile): activate cache-first file provider"
```

Before committing, inspect `git diff --cached --stat` and ensure no unrelated dirty files are staged.

## Task 3: Native Backup Gentle Foreground Policy

**Files:**
- Modify: `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`

- [ ] **Step 1: Add scheduler mode state**

Add a small native mode model near the engine state:

```swift
private enum BackupPacingMode: String {
  case foregroundActive
  case foregroundIdle
  case background
  case lowPower
  case thermalPressure
  case serverBackoff

  var batchLimit: Int {
    switch self {
    case .foregroundActive, .lowPower, .thermalPressure, .serverBackoff:
      return 1
    case .foregroundIdle:
      return 2
    case .background:
      return 3
    }
  }

  var delayNanoseconds: UInt64 {
    switch self {
    case .foregroundActive: return 2_000_000_000
    case .foregroundIdle: return 750_000_000
    case .background: return 150_000_000
    case .lowPower, .thermalPressure, .serverBackoff: return 5_000_000_000
    }
  }
}
```

- [ ] **Step 2: Compute mode at the drain boundary**

Before each batch in the drain loop, compute mode from current app state, Low Power Mode, thermal state, and backoff state. Low Power Mode and serious/critical thermal states must either pause work or use the lowest `batchLimit` and highest delay.

- [ ] **Step 3: Enforce batch limit and delay**

Pass `mode.batchLimit` into the existing batch upload call. After each batch, sleep for `mode.delayNanoseconds` unless cancelled. Check `Task.isCancelled`, `isRunning`, and `isPaused` before starting the next batch.

- [ ] **Step 4: Improve disable semantics**

When `stop()` is called, make the next safe boundary immediate: cancel the drain task, set `isRunning = false`, set `isPaused = false`, clear sensitive state, and ensure no new asset starts after stop. Do not cancel already handed-off URLSession background uploads in this task.

- [ ] **Step 5: Add safe perf logs**

Emit:

```text
[BeebeebPerf] backup.native.mode mode=<mode> batchLimit=<n>
[BeebeebPerf] backup.native.stop total=<n> completed=<n> inProgress=<n>
```

Do not log filenames, local asset IDs, server file IDs, paths, tokens, keys, or encrypted names.

- [ ] **Step 6: Build and verify**

Run:

```bash
bunx tsc --noEmit
```

Then run the XcodeBuildMCP simulator build. Expected: TypeScript and iOS build both pass.

- [ ] **Step 7: Commit native pacing only**

Run:

```bash
git add modules/beebeeb-crypto/ios/NativeBackupEngine.swift
git commit -m "fix(mobile): pace native photo backup"
```

## Task 4: RN Backup Progress Copy Consistency

**Files:**
- Modify: `src/lib/backup-context.tsx`
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/screens/PhotosScreen.tsx`

- [ ] **Step 1: Normalize progress model in RN**

Use absolute totals everywhere:

```ts
const uploaded = p.completed;
const total = p.total;
const failed = p.failed ?? 0;
const pending = Math.max(0, total - uploaded - failed);
```

Primary UI copy must read `uploaded of total photos backed up`. Remaining count can be secondary only.

- [ ] **Step 2: Remove remaining-first copy**

Replace user-visible strings shaped like `Backing up n of remaining m` with absolute progress strings. Keep current-file detail empty until native provides current asset metadata.

- [ ] **Step 3: Typecheck**

Run:

```bash
bunx tsc --noEmit
```

Expected: pass.

- [ ] **Step 4: Commit RN progress copy only**

Run:

```bash
git add src/lib/backup-context.tsx src/screens/SettingsScreen.tsx src/screens/PhotosScreen.tsx
git commit -m "fix(mobile): show absolute backup progress"
```

## Task 5: Graphify And Integration Report

**Files:**
- Modify: `graphify-out/GRAPH_REPORT.md`
- Modify: `graphify-out/graph.json`
- Create: `docs/superpowers/reports/2026-05-19-phase-2a-integration-report.md`

- [ ] **Step 1: Update Graphify after code changes**

Run:

```bash
graphify update .
```

Expected: graph files updated; HTML visualization may be skipped if graph is too large.

- [ ] **Step 2: Write integration report**

Create `docs/superpowers/reports/2026-05-19-phase-2a-integration-report.md` with:

```markdown
# Mobile Native Smoothness Phase 2A Integration Report

Date: 2026-05-19
Status: Completed

## Commits

- test(mobile): guard file provider target sources
- fix(mobile): activate cache-first file provider
- fix(mobile): pace native photo backup
- fix(mobile): show absolute backup progress

## Verification

- ./scripts/verify-file-provider-target.sh
- bunx tsc --noEmit
- XcodeBuildMCP simulator build
- graphify update .

## Remaining Risks

- Physical iPhone Files verification is still required before TestFlight.
- Background locked-device backup behavior still needs physical-device logs.
- Photos grid/pinch performance is not solved by Phase 2A.
```

- [ ] **Step 3: Commit report and Graphify**

Run:

```bash
git add graphify-out/GRAPH_REPORT.md graphify-out/graph.json docs/superpowers/reports/2026-05-19-phase-2a-integration-report.md
git commit -m "docs(mobile): summarize smoothness phase 2a"
```

## Final Gate Before TestFlight

Do not push to TestFlight until all of these pass:

```bash
./scripts/verify-file-provider-target.sh
bunx tsc --noEmit
```

And XcodeBuildMCP simulator build/run must succeed. Physical iPhone verification is required for:

- iOS Files root folder lists quickly from cache.
- iOS Files subfolders list from cache.
- Opening a small text/PDF/image file succeeds without `NSFileProviderErrorDomain -2015`.
- Disabling camera-roll backup stops new native work at the next safe boundary.
- Foreground backup no longer saturates the phone during active use.
