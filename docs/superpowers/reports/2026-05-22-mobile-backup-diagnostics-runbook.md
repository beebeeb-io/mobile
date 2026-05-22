# Mobile Backup Diagnostics Runbook

Task: `.claude/tasks/in-development/0423-mobile-backup-diagnostics-and-verification-harness.md`

Bundle ID: `io.beebeeb.app`

## Capture Device Logs

Run this before reproducing the backup stall or Face ID prompt sequence:

```sh
cd repos/mobile
scripts/capture-backup-device-logs.sh --device <IPHONE_UDID> --duration 180 --out diagnostics/backup-logs-before
```

Physical-device capture uses `idevicesyslog` when installed. If `idevicesyslog`
is unavailable but `xcrun devicectl` is available, the script falls back to app
console capture with:

```sh
xcrun devicectl device process launch --device <IPHONE_UDID> --console --terminate-existing io.beebeeb.app
```

That fallback terminates and relaunches the app to attach console output, so use
Xcode Console instead when the reproduction must preserve the current app
process.

Simulator fallback:

```sh
cd repos/mobile
scripts/capture-backup-device-logs.sh --simulator booted --duration 60 --out diagnostics/backup-logs-sim
```

Review:

- `beebeeb-backup-filtered.log`
- `[BeebeebDiagnostics] vault.unlock`
- `[BeebeebDiagnostics] backup.snapshot`
- `[BeebeebPerf] backup.native.*`
- `NativeBackupEngine`
- `LocalAuthentication`

## Pull And Summarize Backup DB

Preferred direct physical-device path:

```sh
cd repos/mobile
scripts/backup-db-diagnostics.sh --device <IPHONE_UDID> --bundle-id io.beebeeb.app --out diagnostics/backup-db-before
```

The script first runs the known-working app-data copy:

```sh
xcrun devicectl device copy from --device <IPHONE_UDID> --domain-type appDataContainer --domain-identifier io.beebeeb.app --source Documents/SQLite/beebeeb-backup.db --destination diagnostics/backup-db-before/beebeeb-backup.db
```

`ios-deploy` is used only as a fallback when the `devicectl` copy is unavailable
or fails.

Fallback when direct pull is unavailable:

1. Open Xcode > Window > Devices and Simulators.
2. Select the physical iPhone.
3. Select the Beebeeb app for bundle `io.beebeeb.app`.
4. Download/export the app container.
5. Summarize the exported database:

```sh
cd repos/mobile
scripts/backup-db-diagnostics.sh --db '<exported-container>/AppData/Documents/SQLite/beebeeb-backup.db' --out diagnostics/backup-db-before
```

Review:

- `backup-db-summary.txt`
- `summary-work.db` (local copy used for SQLite reporting so copied WAL-mode device DBs can be summarized reliably)
- `Task 0423 Queue Contract Counts`
- `PhotoKit Missing Evidence`
- `Retry Buckets`
- `Top Error Buckets`
- `Upload Chunk Status Counts`

## Snapshot Sources

JS vault diagnostics are recorded in `src/lib/crypto-context.tsx` and exposed through:

- `getLastVaultUnlockDiagnostics()`
- `useCrypto().getUnlockDiagnostics()`

Native backup diagnostics are emitted to device logs as JSON with:

- `[BeebeebDiagnostics] backup.snapshot`

In development builds, Settings > Advanced also has **Copy diagnostics JSON**.
It copies one JSON object containing:

- current vault unlock diagnostics
- native backup diagnostic snapshot
- generated timestamp and platform

Each native snapshot includes:

- `timestamp`
- `appState`
- `backup.publicState`
- `backup.isRunning`
- `backup.isPaused`
- `backup.drainTaskActive`
- `backup.backgroundTaskActive`
- `backup.backgroundGraceActive`
- `backup.networkAvailable`
- `backup.backoffUntil`
- `backup.freeBytesAvailable`
- `backup.stagedBytesOnDisk`
- `queue.pending_upload`
- `queue.staging`
- `queue.staged_upload`
- `queue.uploading`
- `queue.uploaded`
- `queue.local_missing`
- `photoKit.missingCount`

## Report Template

Date:

Device:

iOS version:

App build:

Scenario:

Commands run:

```sh

```

Log artifact paths:

- 

DB artifact paths:

- 

Vault unlock diagnostics observed:

```json

```

Native backup snapshot observed:

```json

```

Queue summary:

| Bucket | Count |
| --- | ---: |
| pending_upload | |
| staging | |
| staged_upload | |
| uploading | |
| uploaded | |
| local_missing | |
| failed_retryable | |
| failed_terminal | |

PhotoKit missing count:

Network/backoff/free-space state:

Observed failure or blocker:

Next action:
