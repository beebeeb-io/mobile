# Mobile Native Smoothness Phase 1 Integration Report

Date: 2026-05-19
Status: Completed

## Status Summary

Phase 1 established the baseline evidence needed before the native-smoothness rebuild. The design and Phase 1 plan are committed in `2af19d6 docs(mobile): plan native smoothness rebuild` and `ad101d6 docs(mobile): plan smoothness phase 1`. The active File Provider audit is committed in `98bd80d docs(mobile): audit file provider active path`. The active camera-roll backup audit is committed in `ab438c6 docs(mobile): audit backup active path`. The low-overhead performance instrumentation is committed in `bba6aac chore(mobile): add phase 1 performance instrumentation`.

The repo instructions require reading Graphify before exploration and running `graphify update .` after code changes (`CLAUDE.md:62` through `CLAUDE.md:68`). The current Graphify snapshot is large enough to be useful, with `16565` nodes and `22206` edges in `graphify-out/GRAPH_REPORT.md:7` through `graphify-out/GRAPH_REPORT.md:10`. This report does not change code, does not run Graphify, and creates only this integration report.

Important scope note: the worktree was already dirty before this report was written. Pre-existing unrelated changes included `graphify-out/GRAPH_REPORT.md`, `graphify-out/graph.json`, `ios/Beebeeb.xcodeproj/project.pbxproj`, native crypto files, File Provider files, app screens, and untracked helper/test files. Phase 1 claims in this report are limited to the committed changes above plus the two committed audits; they do not validate unrelated dirty worktree state.

## What Was Verified

- File Provider active path: the current Xcode target uses the plugin implementation under `plugins/file-provider/*`, not the cache-first duplicate under `targets/file-provider/*`. The audit cites active source membership in `ios/Beebeeb.xcodeproj/project.pbxproj` and resolves the compiled files to plugin paths at `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:8` through `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:11`.
- Camera-roll backup active path: the current `src/App.tsx` app tree mounts `BackupProvider`, which starts the native backup path, and does not mount `PhotoBackupBridge`; therefore JS and native cannot both run in the current checked tree unless `PhotoBackupBridge` is mounted later. Evidence is in `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:8` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:12` and `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:23` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:27`.
- RN instrumentation: commit `bba6aac` added `src/lib/perf-mark.ts`, `src/lib/perf-mark.test.ts`, and instrumentation in `src/screens/FilesScreen.tsx`, `src/screens/PhotosScreen.tsx`, and `src/lib/PhotoBackupBridge.tsx`. Stable labels use the `[BeebeebPerf]` prefix in `src/lib/perf-mark.ts:28` and `src/lib/perf-mark.ts:34` as committed in `bba6aac`.
- Native backup instrumentation: commit `bba6aac` added `[BeebeebPerf] backup.native.*` logging to `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`, including start/stop, batch start/finish, and asset start/finish/fail events. The committed helper and native labels are at `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:74` through `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:84` in `bba6aac`.
- Task 3/4 evidence boundary: no durable in-repo reviewer report, simulator log, or command transcript was found for the instrumentation checkpoint. The durable repo evidence is the committed `bba6aac` diff plus the command gates required by `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:419` through `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:438` and `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:549` through `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:563`. Session-local handoff said `bun test src/lib/perf-mark.test.ts`, `bunx tsc --noEmit`, and `graphify update .` passed, but that handoff is not independently evidenced in committed repo files.

## Findings

### Task 1: File Provider

The active iOS File Provider target uses `plugins/file-provider/*`; the cache-first implementation under `targets/file-provider/*` exists but is inactive. The active target membership and inactive duplicate are documented in `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:8` through `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:11`.

The active plugin enumeration is API-backed and slow by design: `enumerateItems` loads files through API list endpoints, then maps each returned row into `FileProviderItem(metadata:crypto:)`. The audit cites this path in `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:17`, and the root-cause section ties slow iOS Files enumeration to network listing plus per-row filename crypto at `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:29`.

Filename rendering performs per-row crypto and can fall back to `Encrypted file`. The audit records `FileProviderItem.filename` calling `decryptFilename` and returning encrypted-label fallbacks at `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:19` and `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:27`.

Opening files has provider error risks because the active `fetchContents` path validates access, fetches metadata, downloads ciphertext, decrypts it, decrypts the display filename, and writes a temporary plaintext file. The materialization path is documented in `docs/superpowers/reports/2026-05-19-file-provider-active-path-audit.md:21`. It does not happen during enumeration, but it is still a network/decrypt/provider boundary that must be verified on device.

### Task 2: Backup

The current `src/App.tsx` tree mounts `BackupProvider`, so the active startup/toggle/manual path is native backup. `PhotoBackupBridge` exists and contains JS camera-roll backup logic, but it is not mounted in the current app tree. The audit documents app startup, toggle, manual trigger, app foreground, and photo-library change paths in `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:8` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:12`.

JS and native cannot both run from the current checked app tree, but they can both run in one app session if `PhotoBackupBridge` is mounted inside the provider tree. The duplicate-runner risk and shared database/table evidence are recorded in `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:23` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:27`.

Toggle-off stops native foreground draining and clears RN-visible state. Native stop cancels the drain loop and stops adding batch work at task boundaries, while the active native upload path uses Rust `uploadEncryptedFile(...)`. This is documented in `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:16` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:19` and `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:31` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:39`.

JS in-flight uploads can continue only if `PhotoBackupBridge` is mounted. Its abort path is cooperative and does not pass an abort signal into `encryptedUpload`, so the active upload can continue until that await resolves. Evidence is in `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:19` and `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:37`.

Progress semantics are aggregate, not current-asset. Native produces total/completed/failed/in-progress counters, the TypeScript bridge narrows that model, JS computes remaining counters from status snapshots, and current asset/current filename/current bytes are not delivered to `BackupProvider`. Evidence is in `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:41` through `docs/superpowers/reports/2026-05-19-backup-active-path-audit.md:47`.

### Tasks 3 and 4: Instrumentation

Commit `bba6aac` instrumented these files:

- `src/lib/perf-mark.ts`
- `src/lib/perf-mark.test.ts`
- `src/screens/FilesScreen.tsx`
- `src/screens/PhotosScreen.tsx`
- `src/lib/PhotoBackupBridge.tsx`
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`

The RN marker emits stable `[BeebeebPerf]` labels and filters null/undefined fields. The committed test asserts the exact label format `[BeebeebPerf] files.open 242ms folder=root count=12` in `src/lib/perf-mark.test.ts:15` through `src/lib/perf-mark.test.ts:21` as committed in `bba6aac`.

Files fetch instrumentation is in `src/screens/FilesScreen.tsx:59` and `src/screens/FilesScreen.tsx:1341` through `src/screens/FilesScreen.tsx:1352` as committed in `bba6aac`. Photos fetch instrumentation is in `src/screens/PhotosScreen.tsx:41` and `src/screens/PhotosScreen.tsx:561` through `src/screens/PhotosScreen.tsx:595` as committed in `bba6aac`. JS backup bridge instrumentation is in `src/lib/PhotoBackupBridge.tsx:38` and `src/lib/PhotoBackupBridge.tsx:238` through `src/lib/PhotoBackupBridge.tsx:255`, plus final/error reporting at `src/lib/PhotoBackupBridge.tsx:300` through `src/lib/PhotoBackupBridge.tsx:341`, as committed in `bba6aac`.

Native backup instrumentation is low-sensitivity: it logs event names, counts, durations, bytes, chunk counts, retry counts, and asset type, while the Phase 1 plan explicitly forbids filenames, local asset IDs, tokens, encrypted names, and file IDs in those logs at `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:518` through `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:547`.

## Commands And Verification

- `bun test src/lib/perf-mark.test.ts`: reported passed for Task 3/4 instrumentation handoff; the committed test file exists in `bba6aac`.
- `bunx tsc --noEmit`: reported passed for Task 3/4 instrumentation handoff; this is the required gate for TypeScript changes in `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:35`.
- XcodeBuildMCP simulator build/run: Task 4 required it for Swift changes in `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:549` through `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:553`; no separate local simulator log/report was found during Task 5 report creation.
- `graphify update .`: session-local handoff reported a pass and this command is required after code changes in `CLAUDE.md:66` and `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:430` through `docs/superpowers/plans/2026-05-19-mobile-native-smoothness-phase-1.md:438`. Graphify output was not committed in `bba6aac`; `graphify-out/GRAPH_REPORT.md` and `graphify-out/graph.json` remain dirty/uncommitted in the observed worktree.

## Phase 2 Recommendations

1. Native File Provider should be switched or ported to cache-first metadata-only enumeration. Keep the `targets/file-provider/*` cache-first behavior active, disconnect the slow plugin enumeration path from the extension target, and verify iOS Files root/subfolder enumeration from SQLite with no network, body download, or per-row crypto. The design requires SQLite-only enumeration and body download only in `fetchContents` at `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:131` through `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:145`.
2. Backup scheduler should become dynamic with thermal, power, user-active, network, cellular, server-backoff, and backpressure controls. The design states scheduler modes and inputs in `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:77` through `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:127`.
3. Backup progress should use absolute current/total semantics, with current-asset detail as secondary. The design requires absolute user-facing progress at `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:115` through `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:129`.
4. Photo and Files screens should use paged/windowed data and thumbnail-first progressive rendering. Files must be metadata-first with no recursive full-vault scan or body download on open, per `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:153` through `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:172`. Photos should render cached thumbnails first and keep scroll/pinch free of full downloads or decrypt bursts, per `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:173` through `docs/superpowers/specs/2026-05-19-mobile-native-smoothness-design.md:192`.
5. Notification policy should be milestone, summary, and user-settings based, but it is not part of Phase 1 implementation. Treat notification behavior as Phase 2+ policy work after the single backup engine and progress model are stable.

## Next Task Breakdown

1. File Provider engineer: update Xcode target membership so only the cache-first File Provider path is active. Owned files should be limited to the Xcode project and the selected File Provider source set. Required evidence: target membership scan, simulator build/run, and physical iPhone iOS Files trace showing SQLite-only enumeration.
2. File Provider reviewer: read-only verify target membership, no active plugin API/crypto-per-row enumeration, and no file-body materialization during enumeration. Reject if `plugins/file-provider/FileProviderEnumerator.swift` remains compiled into the extension.
3. Backup single-engine engineer: keep `BackupProvider` as the RN control surface and make `NativeBackupEngine` the only camera-roll runner. Add guardrails so `PhotoBackupBridge` cannot silently become active for camera roll. Required evidence: trace command from the audit, `bunx tsc --noEmit`, and device logs showing no `PhotoSyncEngine` uploads.
4. Backup single-engine reviewer: read-only verify no mounted JS runner, no duplicate photo-library listener for camera roll, and toggle-off prevents new native work after the current safe boundary.
5. Dynamic scheduler engineer: implement native scheduler modes, concurrency/pacing policy, thermal/low-power/network/server-backoff handling, and RN user-active signal. Required evidence: `[BeebeebPerf] backup.native.*` logs from foreground active, foreground idle, low power, thermal/backoff where available, and background/locked behavior where iOS permits.
6. Progress semantics engineer: extend native and TypeScript progress to absolute uploaded/total plus failed, pending, current ordinal/name/bytes, mode, and reason. Required evidence: screenshots from Settings/Backup Insights/Photos banner showing the same absolute totals.
7. Files/Photos data engineer: make Files and Photos screens read paged/windowed cache data first, refresh in the background, and render thumbnail-first progressive content. Required evidence: `[BeebeebPerf] files.fetch` and `[BeebeebPerf] photos.fetch` traces on a large library and proof that scroll/pinch does not trigger body downloads.
8. Notification policy engineer: after single-engine/progress work lands, move backup notifications to milestone/summary/user-settings policy. Required evidence: notification settings state, no per-file spam, and summary behavior under active backup.

## Blockers

- No Phase 1 implementation blocker found in the committed audit/instrumentation sequence.
- Evidence gap: no separate local reviewer report, command transcript, or simulator log artifact was found under `docs/superpowers/reports/` or committed repo files for Task 3/4. This report therefore treats `bba6aac` as the durable instrumentation evidence and treats reviewer/command pass status as session-local, not independently evidenced in the repo.
