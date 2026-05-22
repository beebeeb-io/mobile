# Mobile Backup Stabilization Plan

Date: 2026-05-22
Spec: `docs/superpowers/specs/2026-05-22-mobile-backup-stabilization-design.md`
Status: planned, no product code changed

## Operating Rule

Do not fix this one symptom at a time. The first three phases establish contracts. UI cleanup comes after state is trustworthy.

## Phase 0 — Instrument Before Changing Behavior

Goal: make every future claim verifiable.

Tasks:

- Add structured logs for unlock requests:
  - source
  - already unlocked vs prompt expected
  - in-flight wait vs new request
  - success/failure/cancel
- Add native backup diagnostic snapshot:
  - runtime flags
  - public state
  - queue counts
  - app state
  - network/backoff/free-space state
- Add script/runbook to pull physical iPhone backup DB and summarize queue counts.
- Add script/runbook to capture relevant device logs for `io.beebeeb.app`.

Acceptance:

- Before any behavior fix, we can reproduce the current flow and capture: repeated unlock sources, current backup state, and DB status counts.

Related task: `0423-mobile-backup-diagnostics-and-verification-harness.md`

## Phase 1 — Single-Flight Vault Unlock

Goal: repeated Face ID stops.

Implementation direction:

- Add an unlock coordinator in `src/lib/crypto-context.tsx`.
- Replace direct calls to `crypto.unlock()` from app flow with `ensureVaultUnlocked(source)`.
- Do not allow backup start/resume to independently call a prompt path while app is already unlocked.
- Audit native `BeebeebCryptoBridge.loadMasterKey()` calls in backup start/background paths.
- If native cannot access key without user interaction, return `waiting_for_unlock` instead of silently failing or prompting multiple times.

Acceptance:

- One app-open session produces at most one Face ID prompt.
- Pressing Files backup nudge after unlock does not prompt again.
- Opening Settings/Insights does not prompt again.
- Cancelling Face ID yields a stable locked state, not a retry loop.

Related task: `0419-mobile-single-flight-vault-unlock.md`

## Phase 2 — Formal Backup State Machine

Goal: one truth for backup state.

Implementation direction:

- Define native `BackupPublicState` enum.
- Replace `needsAppOpen` ambiguity with precise states:
  - `waiting_for_app`
  - `waiting_for_unlock`
  - `paused_by_user`
  - `waiting_for_wifi`
  - `waiting_for_storage`
  - `needs_attention`
- Make `triggerBackupNow()` request native work and then render native response only.
- Remove long-lived JS optimistic state mutation. Keep only local button spinner.
- Ensure `resume()` starts or restarts the engine when pending work exists, or returns a precise blocked state.

Acceptance:

- Files, Settings, Backup Insights, widget, Live Activity all receive the same state.
- When app is open, state cannot say `Open Beebeeb` unless the app truly cannot run because it needs unlock or user action.
- If pending work exists and backup is enabled, the engine either runs or exposes an explicit blocked reason.

Related task: `0420-mobile-backup-state-machine-owner.md`

## Phase 3 — Queue Semantics And PhotoKit Missing Assets

Goal: stale local photos do not look like catastrophic backup errors.

Implementation direction:

- Add terminal local statuses to native and JS DB surfaces:
  - `local_missing`
  - `permission_limited`
  - `waiting_storage`
  - `failed_retryable`
  - `failed_terminal`
- In `fetchAssetData`, map missing PhotoKit asset to `local_missing`.
- Do not increment retry forever for `local_missing`.
- If remote file exists, preserve remote link and classify as local missing.
- Update Insights to show `Skipped on this iPhone` counts.
- Add safe rescan/repair to re-activate assets if PhotoKit sees them again.

Acceptance:

- A deleted/local-missing photo does not keep retrying.
- It does not produce a front-page red error.
- It appears in diagnostics with count and explanation.

Related task: `0421-mobile-photokit-missing-asset-cleanup.md`

## Phase 4 — UI Simplification

Goal: one clean backup UX.

Implementation direction:

- Settings > Backup becomes the primary control center.
- Files banner becomes a compact route to Settings > Backup, not a separate backup command.
- Backup Insights becomes read-only diagnostics by default.
- Advanced Repair remains separate and progress-driven.
- Remove misleading controls:
  - "Clear failed" cannot retry while claiming to clear.
  - Full resync should be advanced/destructive only.
  - Duplicate "Backup now"/"Continue" actions route through one command.

Acceptance:

- User sees one primary backup action.
- No two screens use conflicting language for the same state.
- UI copy matches actual native state.

Related task: `0422-mobile-backup-ui-information-architecture.md`

## Phase 5 — Live Activity And Notifications

Goal: external surfaces never lie about backup progress.

Implementation direction:

- Live Activity mirrors `BackupPublicState`.
- End duplicate live activities on every update.
- Keep visible only for active work or actionable wait state.
- Suppress notifications while Live Activity is current.
- Completion/no-change summaries use existing notification policy, but only from native truth.

Acceptance:

- Background stopping changes Live Activity to `Open Beebeeb to continue`, not active backup.
- App-active state sends no backup notifications.
- Tapping Live Activity opens Settings > Backup without navigation errors.

Related task: `0424-mobile-live-activity-notification-state-alignment.md`

## Phase 6 — Release Gate

Goal: no TestFlight until the whole flow is stable.

Required physical iPhone matrix:

- Cold app open with Face ID Lock on.
- Face ID once, not repeated.
- Files backup nudge.
- Settings > Backup.
- Backup Insights.
- Background and foreground once.
- Disable camera roll backup and confirm it stays stopped.
- One missing/deleted local photo does not spam errors.
- Live Activity state changes when background work stops.
- DB snapshot before/after confirms queue transitions.

Build gates:

- `bunx tsc --noEmit`
- local Debug iPhone build
- physical iPhone install/launch
- scenario evidence attached to task `0425`

Related task: `0425-mobile-stabilization-release-gate.md`

## Suggested Ownership

- Engineer A: Phase 0 diagnostics + release-gate scripts.
- Engineer B: Phase 1 unlock coordinator.
- Engineer C: Phase 2 native state machine.
- Engineer D: Phase 3 queue semantics.
- Reviewer: verify each phase with physical-device evidence before next phase merges.

Do not let engineers independently touch UI copy before Phase 2 is merged.

