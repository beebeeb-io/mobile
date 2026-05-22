# Mobile Backup Stabilization Design

Date: 2026-05-22
Status: draft, no product code changed

## Problem

The current mobile backup experience is not failing because of one broken button. It is failing because unlock, backup execution, backup state rendering, background/live-activity state, and diagnostic repair all partially own truth.

The user-visible result is:

- repeated Face ID prompts in one session
- `Continue` in Files can prompt again
- Settings can show `Open Beebeeb to continue backup` while the app is open
- Backup Insights can show `Photo asset not found in library`
- too many backup buttons, cards, banners, and status phrases

This must be treated as a system stabilization project. Do not patch individual screens until the contracts below exist.

## Current Evidence

### Unlock Paths

- `src/App.tsx:384-389` silently calls `crypto.unlock()` on cold launch.
- `src/App.tsx:392-395` calls `crypto.unlock()` again after the biometric lock screen unlocks.
- `src/App.tsx:742-774` can lock again on background-to-active transitions.
- `src/lib/crypto-context.tsx:231-276` prevents redundant unlock only after `masterKeyHandleId.current` is already set.
- `src/lib/crypto-context.tsx:388-406` has a separate background unlock path.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:599-614` starts backup by loading the master key directly from Keychain via `BeebeebCryptoBridge.loadMasterKey()`.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:753-760` background task can also load the master key directly.

There is no single-flight unlock coordinator. Multiple callers can reach Keychain before one caller stores the native handle.

### Backup State Paths

- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:231-236` holds native runtime state: `isRunning`, `isPaused`, `drainTask`, wake reason.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:399-423` derives the public state string.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:451-458` writes status, updates Live Activity, and ends background grace.
- `src/lib/backup-context.tsx:116-130` maps native progress into JS state.
- `src/lib/backup-context.tsx:323-334` sets JS state optimistically to `running` before native truth returns.
- `src/screens/FilesScreen.tsx:1556-1568` Files calls `triggerBackupNow()`.
- `src/screens/FilesScreen.tsx:2635-2641` Files renders a continue banner when global state is `needsAppOpen`.
- `src/screens/BackupInsightsScreen.tsx:350-365` polls while pending exists, and `:634-653` renders an active card.
- `ios/BeebeebWidget/BeebeebWidget.swift:338-353` independently interprets the same state for Live Activity.

There is no one normalized UI contract. Every layer can reinterpret state.

### Queue / PhotoKit Paths

- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:831-867` scans PhotoKit and inserts pending rows.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:1739-1743` throws `assetNotFound` when a local PhotoKit identifier cannot resolve.
- `modules/beebeeb-crypto/ios/NativeBackupEngine.swift:1315-1327` catches any upload failure, increments retry, and surfaces it as `Upload failed`.
- `src/services/BackupDatabase.ts:23-33` does not include a terminal local-missing/skipped status.
- `src/services/BackupDatabase.ts:288-294` treats retry-exhausted rows as failed assets.

Missing local photos are handled as retrying upload errors instead of a normal terminal local state.

### Repair / Advanced Paths

- `src/screens/AdvancedSettingsScreen.tsx:196-285` contains thumbnail repair controls and progress.
- `src/lib/ThumbnailRepairWorker.tsx:96-322` runs repair while active/unlocked and updates AsyncStorage status.
- `src/screens/BackupInsightsScreen.tsx:429-453` full resync clears backup state and triggers backup again.
- `src/screens/BackupInsightsScreen.tsx:455-484` "Clear failed" actually retries failed rows.

Repair and diagnostics exist, but they are not designed as one operational surface. Some controls are misleading.

## Root Causes

### RC1: Unlock Is Not Single-Flight

The app has at least four ways to request a master-key handle. Because unlock is not serialized, a cold start, a backup start, a settings state refresh, or a background task can each cause Keychain access. On biometric-protected keys, that means repeated Face ID.

### RC2: Native Backup Engine Has Runtime State But Not a Formal Public State Machine

`isRunning`, `isPaused`, app state, background grace, pending rows, failed rows, network status, and backoff all influence user-facing state. They are combined into ad hoc strings. `needsAppOpen` currently means both "iOS background limit" and "pending work but engine is not running".

### RC3: JS UI Mutates State Instead Of Rendering Native Truth

`triggerBackupNow()` sets JS to `running` before native confirms whether the engine can run. Screens then render from that mixed truth.

### RC4: One Queue Status Enum Is Serving Too Many Concepts

The queue mixes:

- pending local work
- staging/encryption work
- resumable remote upload work
- retryable failures
- terminal local conditions
- remote deletion/orphan states

No explicit `local_missing`, `permission_limited`, `waiting_storage`, or `blocked_unlock` states exist.

### RC5: UI Has Multiple Primary Controls

Files, Settings, Backup Insights, Advanced, Live Activity, and notifications all try to tell the user what to do. That causes duplicate buttons and conflicting copy.

## Target Architecture

### 1. Vault Unlock Coordinator

Create one unlock coordinator owned by `CryptoProvider`.

Contract:

- `ensureVaultUnlocked(source, options)` is the only JS entry point for vault unlock.
- Concurrent calls share one in-flight promise.
- Callers receive one of:
  - `unlocked`
  - `already_unlocked`
  - `requires_user_unlock`
  - `failed`
  - `cancelled`
- It logs source labels: `cold_launch`, `lock_screen`, `backup_continue`, `preview`, `file_provider`, `background_attempt`.
- It never auto-retries after a failed biometric prompt.

Native backup must not independently prompt. It should receive a master-key handle/session capability from app unlock where possible. If iOS background execution cannot access the key without prompting, it must report `waitingForUnlock` / `waitingForAppOpen`.

### 2. Native Backup Supervisor

Native owns backup execution and public backup state.

The public state must be a structured object, not a free-form string:

```ts
type BackupPublicState =
  | { kind: 'idle'; actionable: false }
  | { kind: 'preparing'; actionable: false }
  | { kind: 'encrypting'; actionable: false }
  | { kind: 'uploading'; actionable: false }
  | { kind: 'waiting_for_app'; actionable: true }
  | { kind: 'waiting_for_wifi'; actionable: false }
  | { kind: 'paused_by_user'; actionable: true }
  | { kind: 'waiting_for_storage'; actionable: false }
  | { kind: 'waiting_for_unlock'; actionable: true }
  | { kind: 'needs_attention'; actionable: true }
  | { kind: 'complete'; actionable: false }
```

Every state payload must include:

- `totalTracked`
- `uploaded`
- `pending`
- `waitingToEncrypt`
- `encryptedPendingUpload`
- `uploading`
- `failedRetryable`
- `failedTerminal`
- `localMissing`
- `lastBackupAt`
- `lastStateChangeAt`
- `canRunNow`
- `reasonCode`
- `userMessageKey`

Do not expose long-lived UI state that JS can override.

### 3. Queue Status Taxonomy

Backup DB statuses should distinguish retryable work from terminal local conditions.

Required statuses:

- `pending_upload`
- `staging`
- `staged_upload`
- `uploading`
- `uploaded`
- `pending_reupload`
- `waiting_storage`
- `waiting_unlock`
- `waiting_wifi`
- `failed_retryable`
- `failed_terminal`
- `local_missing`
- `permission_limited`
- `remote_deleted`
- `orphaned`

Rules:

- `local_missing` is terminal until a rescan finds the asset again.
- `local_missing` does not increment retry forever.
- `waiting_storage` does not count as upload failure.
- Retry cap only applies to retryable upload/network/server failures.
- If a remote backup already exists, local-missing state preserves the remote file.

### 4. UI Information Architecture

One primary control surface:

- Settings > Backup is the backup home.

Secondary surfaces:

- Files may show one compact nudge only when `actionable=true`.
- Backup Insights is read-only diagnostics first.
- Advanced is for repair/debug tools with progress.
- Live Activity mirrors state, not separate state.
- Notifications only fire when no live activity is actively representing the state.

Recommended Settings > Backup layout:

1. Header status row:
   - `Backing up`, `Waiting for Beebeeb to stay open`, `Paused`, `Needs attention`, `Up to date`
   - one primary action if actionable
2. Backup sources:
   - Camera Roll
   - Contacts
   - Calendar
3. Behavior:
   - Include videos
   - Wi-Fi only
   - When removed from iPhone
4. Progress:
   - `2,849 of 9,341 backed up`
   - `6,452 waiting to encrypt`
   - `0 encrypted waiting to upload`
5. Advanced link:
   - Backup Insights
   - Repair & Diagnostics

Files tab:

- No large card by default.
- If `waiting_for_app` and pending is high: compact one-line row below Recent:
  - `Backup waiting · 6,452 items`
  - action: `Open`
- Tapping routes to Settings > Backup, not an independent trigger.

Backup Insights:

- No primary `Backup now` unless explicitly in diagnostics mode.
- Show counts and explanation.
- Missing local assets are under `Skipped on this iPhone`, not an error banner.

### 5. Live Activity And Notifications

Live Activity must show actual state:

- `encrypting`: `Encrypting 120 of 6,452`
- `uploading`: `Uploading encrypted photos`
- `waiting_for_app`: `Open Beebeeb to continue`
- `waiting_for_unlock`: `Unlock Beebeeb to continue`
- `waiting_for_wifi`: `Waiting for Wi-Fi`
- `paused_by_user`: `Backup paused`

Live Activity should be kept visible only for:

- active backup work
- actionable wait state with pending work

Notifications:

- No milestone spam.
- No notification while app is active.
- No action-needed notification if a live activity is visible and current.
- Completion summary at most once per 24h: `Beebeeb backed up 37 new photos in the last 24 hours`.
- No-change check-in at most once per 7 days.

### 6. Diagnostics Contract

Add an exportable diagnostic snapshot:

```json
{
  "timestamp": "...",
  "appState": "active",
  "vault": {
    "isUnlocked": true,
    "unlockInFlight": false,
    "lastUnlockSource": "lock_screen"
  },
  "backup": {
    "publicState": "...",
    "isRunning": true,
    "isPaused": false,
    "drainTaskActive": true,
    "backgroundGraceActive": false,
    "networkAvailable": true,
    "backoffUntil": null
  },
  "queue": {
    "pending_upload": 6452,
    "staging": 0,
    "staged_upload": 0,
    "uploading": 0,
    "uploaded": 2849,
    "local_missing": 1
  }
}
```

Verification must include this snapshot before and after the physical-device scenario.

## Non-Goals

- Do not redesign photo grid performance in this batch.
- Do not change server upload protocol unless diagnostics prove a server contract gap.
- Do not add new backup features.
- Do not ship TestFlight until the stabilization release gate passes.

