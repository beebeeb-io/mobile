# Mobile Native Smoothness Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish verified evidence for the active backup and iOS Files paths, then add low-risk instrumentation needed to drive the native smoothness rebuild.

**Architecture:** This phase does not rewrite behavior. It maps the currently active native/React Native/File Provider paths, records exactly where slowness can occur, and adds targeted debug instrumentation behind stable prefixes so later tasks can prove improvements on a physical iPhone.

**Tech Stack:** React Native + Expo + TypeScript, Swift iOS module, Xcode project, File Provider extension, SQLite caches, XcodeBuildMCP, Bun.

---

## File Structure

- `ios/Beebeeb.xcodeproj/project.pbxproj`: verify which File Provider Swift files are active target members.
- `targets/file-provider/*`: cache-first File Provider implementation candidate.
- `plugins/file-provider/*`: older File Provider implementation candidate.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`: native backup lifecycle, progress, scheduler, native logs.
- `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift`: native module bridge for backup/File Provider settings/status.
- `src/lib/backup-context.tsx`: React Native backup settings, native start/stop/status calls.
- `src/lib/PhotoBackupBridge.tsx`: legacy JS photo backup bridge candidate.
- `src/services/PhotoSyncEngine.ts`: legacy JS camera-roll runner candidate.
- `src/screens/FilesScreen.tsx`: Files tab list timing and body-download audit.
- `src/screens/PhotosScreen.tsx`: Photos tab timing and full-image-download audit.
- `src/lib/file-provider-mount.ts`: main-app File Provider cache sync and mount behavior.
- `docs/superpowers/reports/`: create reports from read-only audits and instrumentation evidence.

## Rules For All Tasks

- Do not push to TestFlight.
- Do not change crypto protocol behavior.
- Do not remove code in Phase 1 unless a task explicitly says so.
- Do not revert existing dirty worktree changes.
- If a file already has user changes, work with them and keep edits narrow.
- For every engineer task, run `bunx tsc --noEmit` when TypeScript changes.
- For Swift/Xcode changes, verify with XcodeBuildMCP simulator build/run.
- Run `graphify update .` after code changes.
- Reviewer agents are read-only unless the lead explicitly asks them to patch.

## Task 1: Active File Provider Path Audit

**Files:**
- Read: `ios/Beebeeb.xcodeproj/project.pbxproj`
- Read: `targets/file-provider/FileProviderExtension.swift`
- Read: `targets/file-provider/FileProviderEnumerator.swift`
- Read: `targets/file-provider/FileProviderItem.swift`
- Read: `targets/file-provider/SyncEngine.swift`
- Read: `plugins/file-provider/BeebeebFileProvider.swift`
- Read: `plugins/file-provider/FileProviderEnumerator.swift`
- Read: `plugins/file-provider/FileProviderItem.swift`
- Read: `plugins/file-provider/FileProviderAPIClient.swift`
- Create: `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md`

- [ ] **Step 1: Identify target membership from Xcode project**

Run:

```bash
rg -n "BeebeebFileProvider.swift|FileProviderExtension.swift|FileProviderEnumerator.swift|FileProviderItem.swift|SyncEngine.swift|plugins/file-provider|targets/file-provider" ios/Beebeeb.xcodeproj/project.pbxproj
```

Expected: output shows which physical file paths are compiled into the File Provider extension target.

- [ ] **Step 2: Inspect active candidate implementations**

Run:

```bash
sed -n '1,180p' targets/file-provider/FileProviderExtension.swift
sed -n '1,140p' targets/file-provider/FileProviderEnumerator.swift
sed -n '1,140p' targets/file-provider/FileProviderItem.swift
sed -n '1,140p' targets/file-provider/SyncEngine.swift
sed -n '1,180p' plugins/file-provider/BeebeebFileProvider.swift
sed -n '1,160p' plugins/file-provider/FileProviderEnumerator.swift
sed -n '1,140p' plugins/file-provider/FileProviderItem.swift
```

Expected: worker records whether the active implementation enumerates from SQLite only or calls API/crypto during enumeration/item filename rendering.

- [ ] **Step 3: Write the report**

Create `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md` with this exact structure:

```markdown
# File Provider Active Path Audit

Date: 2026-05-19
Status: Completed

## Active Target Membership

Write one bullet per active File Provider source file with the Xcode project evidence that proves target membership.
Write one bullet per inactive duplicate File Provider source file with the evidence that proves it is not compiled.

## Enumeration Behavior

Write one paragraph each for `item(for:)`, `enumerateItems`, `filename`, and `fetchContents`.
Each paragraph must say whether it uses SQLite, API calls, crypto, file-body download, or a combination.

## Root Cause Assessment

Write one paragraph explaining the most likely source of "Encrypted file" on the user's iPhone.
Write one paragraph explaining the most likely source of slow iOS Files enumeration on the user's iPhone.

## Evidence

Include exact file paths and line numbers for every claim above.

## Recommended Phase 2 Task

List exact files to keep active, exact files to disconnect from the active target, and the verification command or device action required after cleanup.
```

- [ ] **Step 4: Verify report has no placeholders**

Run:

```bash
rg -n "TBD|TODO|unknown|fill in|placeholder|Write one|Include exact|List exact" docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md
```

Expected: no output.

## Task 2: Active Camera-Roll Backup Path Audit

**Files:**
- Read: `src/lib/backup-context.tsx`
- Read: `src/lib/PhotoBackupBridge.tsx`
- Read: `src/services/PhotoSyncEngine.ts`
- Read: `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`
- Read: `modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift`
- Read: `modules/beebeeb-crypto/src/BeebeebCrypto.ts`
- Create: `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md`

- [ ] **Step 1: Trace React Native backup entry points**

Run:

```bash
rg -n "togglePhotoBackup|triggerBackupNow|enablePhotoBackup|disablePhotoBackup|triggerImmediateBackup|startNativeBackup|PhotoBackupBridge|processUploads|fullReconciliation|PhotoSyncEngine" src/lib src/services modules/beebeeb-crypto/src modules/beebeeb-crypto/ios -S
```

Expected: output shows every start/stop/manual/legacy runner path.

- [ ] **Step 2: Read active control files**

Run:

```bash
sed -n '140,390p' src/lib/backup-context.tsx
sed -n '1,560p' src/lib/PhotoBackupBridge.tsx
sed -n '120,370p' src/services/PhotoSyncEngine.ts
sed -n '170,260p' modules/beebeeb-crypto/ios/NativeBackupEngine.swift
sed -n '390,520p' modules/beebeeb-crypto/ios/NativeBackupEngine.swift
sed -n '930,1110p' modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift
```

Expected: worker records whether JS and native camera-roll backup paths can both run.

- [ ] **Step 3: Write the report**

Create `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md` with this exact structure:

```markdown
# Camera-Roll Backup Active Path Audit

Date: 2026-05-19
Status: Completed

## Active Start Paths

Write one bullet each for app startup, toggle on, manual "Back up now", app foreground, and photo library changes.
Each bullet must name the function that starts work and whether it routes to JS, native, or both.

## Active Stop Paths

Write one bullet each for toggle off, app unmount, native stop, and JS abort.
Each bullet must name the function that stops work and what it cannot stop.

## Duplicate Runner Risk

State whether the JS runner is active, whether the native runner is active, and whether both can run for camera roll in the same app session.

## Disable-While-Running Behavior

Explain what stops immediately, what can continue, and why restart changes behavior.

## Progress Model Problems

Explain where absolute counters are produced, where remaining counters are produced, and where current file or asset data is lost.

## Evidence

Include exact file paths and line numbers for every claim above.

## Recommended Phase 2 Task

List exact JS active paths to disable, exact native methods to expose or adjust, and the verification command or device action required after cleanup.
```

- [ ] **Step 4: Verify report has no placeholders**

Run:

```bash
rg -n "TBD|TODO|unknown|fill in|placeholder|Write one|State whether|Explain what|Include exact|List exact" docs/superpowers/reports/2026-05-19-backup-active-path-audit.md
```

Expected: no output.

## Task 3: Low-Overhead Performance Instrumentation

**Files:**
- Create: `src/lib/perf-mark.ts`
- Create: `src/lib/perf-mark.test.ts`
- Modify: `src/screens/FilesScreen.tsx`
- Modify: `src/screens/PhotosScreen.tsx`
- Modify: `src/lib/PhotoBackupBridge.tsx`

- [ ] **Step 1: Write failing tests for the performance marker**

Create `src/lib/perf-mark.test.ts`:

```ts
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { createPerfMarker } from './perf-mark';

describe('perf marker', () => {
  test('records elapsed time with stable labels', () => {
    let now = 1000;
    const logs: string[] = [];
    const marker = createPerfMarker({
      now: () => now,
      log: (line) => logs.push(line),
      enabled: true,
    });

    const end = marker.start('files.open', { folder: 'root' });
    now = 1242;
    end({ count: 12 });

    expect(logs).toEqual([
      '[BeebeebPerf] files.open 242ms folder=root count=12',
    ]);
  });

  test('does nothing when disabled', () => {
    const logs: string[] = [];
    const marker = createPerfMarker({
      now: () => 1000,
      log: (line) => logs.push(line),
      enabled: false,
    });

    marker.start('photos.open')();
    expect(logs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test src/lib/perf-mark.test.ts
```

Expected: fail because `src/lib/perf-mark.ts` does not exist.

- [ ] **Step 3: Implement the performance marker**

Create `src/lib/perf-mark.ts`:

```ts
type PerfFields = Record<string, string | number | boolean | null | undefined>;

interface PerfMarkerOptions {
  now?: () => number;
  log?: (line: string) => void;
  enabled?: boolean;
}

function formatFields(fields: PerfFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
    .join(' ');
}

export function createPerfMarker(options: PerfMarkerOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? console.info;
  const enabled = options.enabled ?? __DEV__;

  return {
    start(label: string, fields: PerfFields = {}) {
      const startAt = now();
      return (endFields: PerfFields = {}) => {
        if (!enabled) return;
        const elapsedMs = Math.max(0, Math.round(now() - startAt));
        const suffix = formatFields({ ...fields, ...endFields });
        log(`[BeebeebPerf] ${label} ${elapsedMs}ms${suffix ? ` ${suffix}` : ''}`);
      };
    },
    event(label: string, fields: PerfFields = {}) {
      if (!enabled) return;
      const suffix = formatFields(fields);
      log(`[BeebeebPerf] ${label}${suffix ? ` ${suffix}` : ''}`);
    },
  };
}

export const perfMark = createPerfMarker();
```

- [ ] **Step 4: Run performance marker tests**

Run:

```bash
bun test src/lib/perf-mark.test.ts
```

Expected: pass.

- [ ] **Step 5: Instrument Files screen open and list update**

Modify `src/screens/FilesScreen.tsx`:

```ts
import { perfMark } from '../lib/perf-mark';
```

Inside `fetchFiles`, before `try`, add:

```ts
const endPerf = perfMark.start('files.fetch', {
  parent: parentId ?? 'root',
  refresh: isRefresh,
});
```

Inside the success path after `applyFilesForFolder(...)`, add:

```ts
endPerf({ count: result.length });
```

Inside the `catch`, before `setError(...)`, add:

```ts
endPerf({ error: true });
```

- [ ] **Step 6: Instrument Photos fetch**

Modify `src/screens/PhotosScreen.tsx`:

```ts
import { perfMark } from '../lib/perf-mark';
```

Inside `fetchPhotos`, before `try`, add:

```ts
const endPerf = perfMark.start('photos.fetch', { refresh: isRefresh });
```

Inside the success path after `setPhotos(...)` decisions are complete and before `void pruneThumbnailCache();`, add:

```ts
endPerf({ count: images.length });
```

Inside the `catch`, before `setError(...)`, add:

```ts
endPerf({ error: true });
```

- [ ] **Step 7: Instrument JS backup bridge start/finish**

Modify `src/lib/PhotoBackupBridge.tsx`:

```ts
import { perfMark } from './perf-mark';
```

Inside `startSync`, after the early return guard and before the Wi-Fi check, add:

```ts
const endPerf = perfMark.start('backup.js.startSync', {
  unlocked: s.isUnlocked,
  enabled: s.isPhotoBackupEnabled,
  wifiOnly: s.wifiOnly,
});
```

Before each return from the Wi-Fi deferral branch, add:

```ts
endPerf({ deferred: 'wifi' });
```

At the final status reporting success path, after `stateRef.current.reportPhotoProgress(...)`, add:

```ts
endPerf({ uploaded: sessionUploadedCount, pending, failed });
```

Inside both reconciliation and processUploads catch blocks, add:

```ts
endPerf({ error: true });
```

- [ ] **Step 8: Verify tests and TypeScript**

Run:

```bash
bun test src/lib/perf-mark.test.ts
bunx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 9: Update Graphify**

Run:

```bash
graphify update .
```

Expected: graphify updates `graphify-out/GRAPH_REPORT.md` and `graphify-out/graph.json`.

## Task 4: Native Backup Instrumentation

**Files:**
- Modify: `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`

- [ ] **Step 1: Add native log helper**

In `NativeBackupEngine.swift`, inside `final class NativeBackupEngine`, add:

```swift
private func perfLog(_ event: String, _ fields: [String: CustomStringConvertible] = [:]) {
  let suffix = fields
    .map { "\($0.key)=\($0.value)" }
    .sorted()
    .joined(separator: " ")
  if suffix.isEmpty {
    NSLog("[BeebeebPerf] backup.native.\(event)")
  } else {
    NSLog("[BeebeebPerf] backup.native.\(event) \(suffix)")
  }
}
```

- [ ] **Step 2: Log lifecycle transitions**

In `start()`, after `isRunning = true`, add:

```swift
perfLog("start", [
  "total": totalAssets,
  "completed": completedAssets
])
```

In `stop()`, before `NSLog("[NativeBackupEngine] Stopped")`, add:

```swift
perfLog("stop", [
  "total": totalAssets,
  "completed": completedAssets,
  "inProgress": inProgressAssets
])
```

In `pause()`, before the existing `NSLog`, add:

```swift
perfLog("pause")
```

In `resume()`, before the existing `NSLog`, add:

```swift
perfLog("resume")
```

- [ ] **Step 3: Log batch start and finish**

In `processBatch(limit:)`, after `let pending = dbQueue.sync { getPendingUploads(limit: limit) }` and before `if pending.isEmpty`, add:

```swift
perfLog("batch.start", [
  "limit": limit,
  "pending": pending.count,
  "running": isRunning
])
```

After `let duration = Date().timeIntervalSince(batchStart)`, add:

```swift
perfLog("batch.finish", [
  "uploaded": uploaded,
  "pending": pending.count,
  "durationMs": Int(duration * 1000)
])
```

- [ ] **Step 4: Log per-asset safe events**

In `uploadSingleAsset`, after `onFileStatus?(asset.localAssetId, "uploading", nil, nil)`, add:

```swift
perfLog("asset.start", [
  "assetType": asset.assetType,
  "retry": asset.retryCount
])
```

After `bytesUploaded += Int64(data.count)`, add:

```swift
perfLog("asset.finish", [
  "bytes": data.count,
  "chunks": result.chunksUploaded
])
```

In the `catch` block before `return false`, add:

```swift
perfLog("asset.fail", [
  "assetType": asset.assetType,
  "retry": asset.retryCount
])
```

Do not log filenames, local asset IDs, tokens, encrypted names, or file IDs.

- [ ] **Step 5: Verify iOS simulator build**

Use XcodeBuildMCP. Before build, show defaults. Then build/run simulator.

Expected: build succeeds.

- [ ] **Step 6: Update Graphify**

Run:

```bash
graphify update .
```

Expected: graphify updates `graphify-out/GRAPH_REPORT.md` and `graphify-out/graph.json`.

## Task 5: Phase 1 Integration Report

**Files:**
- Read: `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md`
- Read: `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md`
- Read: recent test/build command output from the lead integrator
- Create: `docs/superpowers/reports/2026-05-19-phase-1-integration-report.md`

- [ ] **Step 1: Write integration report**

Create `docs/superpowers/reports/2026-05-19-phase-1-integration-report.md`:

```markdown
# Mobile Native Smoothness Phase 1 Integration Report

Date: 2026-05-19
Status: Completed

## What Was Verified

- File Provider active path:
- Camera-roll backup active path:
- RN instrumentation:
- Native backup instrumentation:

## Important Findings

Write the confirmed File Provider active-path finding, the confirmed backup active-path finding, and the confirmed instrumentation finding. Each finding must include evidence paths.

## Commands Run

- `bun test src/lib/perf-mark.test.ts`:
- `bunx tsc --noEmit`:
- XcodeBuildMCP simulator build/run:
- `graphify update .`:

## Phase 2 Task Order

1. File Provider active implementation cleanup
2. Single camera-roll backup engine
3. Dynamic backup scheduler
4. Backup progress semantics
5. Files tab cache-first read path
6. Photos cache and thumbnail pipeline

## Blockers

Write `- No blockers found in Phase 1.` when there are no blockers. If a blocker exists, write one bullet per blocker with file or log evidence.
```

- [ ] **Step 2: Verify report has no placeholders**

Run:

```bash
rg -n "Write the|TBD|TODO|unknown|placeholder|None, or|Finding 1|Finding 2|Finding 3" docs/superpowers/reports/2026-05-19-phase-1-integration-report.md
```

Expected: no output.

## Plan Self-Review

Spec coverage:

- Baseline and instrumentation: Task 1, Task 2, Task 3, Task 4, Task 5.
- File Provider active implementation cleanup: Task 1 produces the evidence and exact Phase 2 task.
- Single backup engine: Task 2 produces the evidence and exact Phase 2 task.
- Dynamic backup scheduler: Task 4 adds native logs needed before implementation.
- Verification gates: each task has command expectations and reviewer gates through subagent-driven workflow.

Placeholder scan:

- This plan intentionally uses report templates. Workers must replace every bullet with evidence before their task is done.
- Reviewer agents must reject reports containing placeholder text matched by the specified `rg` commands.
