/**
 * TS-side wrapper for the Swift-owned backup state bridge (task 0437).
 *
 * The Swift `NativeBackupEngine` owns runtime upload state — per-asset status,
 * progress counts, retry queue. JS reads from it through this module. JS must
 * NOT write runtime state directly any more; the legacy `BackupDatabase.ts`
 * mutators are slated for deletion once every call site here has migrated.
 *
 * **Status:** the corresponding Swift methods on `BeebeebCryptoModule` do not
 * exist yet — this file is dead code until `ios-engineer` ships them. The
 * runtime probe `isBridgeReady()` returns `false` until then; consumers should
 * fall back to a "backup state unavailable" UI instead of crashing.
 *
 * Coordination notes + final API in `.claude/tasks/in-development/0437-single-owner-backup-state.md`.
 */

import * as BeebeebCrypto from '../../modules/beebeeb-crypto';

// ---------------------------------------------------------------------------
// Snapshot shape — must stay in lock-step with Swift's emitted payload.
// ---------------------------------------------------------------------------

export type BackupRunState = 'idle' | 'running' | 'paused' | 'error';

export interface BackupStatusSnapshot {
  totalAssets: number;
  completedAssets: number;
  inProgressAssets: number;
  failedAssets: number;
  bytesUploaded: number;
  bytesTotal: number;
  state: BackupRunState;
  /** Most recent user-actionable error from the engine. null when healthy. */
  lastErrorMessage: string | null;
  /** Epoch milliseconds. The engine will retry no earlier than this time. */
  backoffUntil: number | null;
}

export type BackupAssetRuntimeStatus =
  | 'queued'
  | 'uploading'
  | 'completed'
  | 'failed';

/** Counts derivable from a snapshot — convenience for consumers. */
export interface BackupStatusCounts extends BackupStatusSnapshot {
  /** Derived: total - completed - inProgress - failed. Never negative. */
  pendingAssets: number;
}

export function withDerivedCounts(snapshot: BackupStatusSnapshot): BackupStatusCounts {
  const pendingAssets = Math.max(
    0,
    snapshot.totalAssets
      - snapshot.completedAssets
      - snapshot.inProgressAssets
      - snapshot.failedAssets,
  );
  return { ...snapshot, pendingAssets };
}

// ---------------------------------------------------------------------------
// Legacy migration payload — Swift side is idempotent; safe to re-invoke.
// ---------------------------------------------------------------------------

export interface LegacyBackupRow {
  localAssetId: string;
  remoteFileId: string | null;
  contentHash: string;
  fileSize: number;
  createdAt: string;
  uploadedAt: string | null;
  assetType: 'photo' | 'video' | 'contact' | 'calendar';
  status: string;
  retryCount: number;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Bridge surface (probed at runtime — Swift methods may not exist yet)
// ---------------------------------------------------------------------------

/**
 * Shape of the future native methods on `BeebeebCryptoModule`. Kept as an
 * interface here so this file type-checks today even though the Swift side
 * hasn't shipped the methods yet — we cast at the boundary.
 */
interface BackupBridgeNative {
  getBackupStatus(): Promise<BackupStatusSnapshot>;
  getAssetStatus(localId: string): Promise<BackupAssetRuntimeStatus | null>;
  migrateLegacyBackupState(rows: LegacyBackupRow[]): Promise<void>;
  /** Subscribe to snapshot updates; returns an unsubscribe function. */
  addBackupStatusListener?: (
    listener: (snapshot: BackupStatusSnapshot) => void,
  ) => { remove: () => void };
}

let bridgeOverride: Partial<BackupBridgeNative> | null = null;

/**
 * Test-only injection point. Lets unit tests swap the native bridge surface
 * without going through the `modules/beebeeb-crypto` namespace (whose mutations
 * aren't visible across `import *` namespace freezing). Production code never
 * calls this; pass `null` to restore the real bridge.
 */
export function __setBridgeForTest(bridge: Partial<BackupBridgeNative> | null): void {
  bridgeOverride = bridge;
}

function nativeBridge(): Partial<BackupBridgeNative> {
  if (bridgeOverride) return bridgeOverride;
  return BeebeebCrypto as unknown as Partial<BackupBridgeNative>;
}

/** True once Swift has shipped the runtime store and exposed it via JSI. */
export function isBridgeReady(): boolean {
  const m = nativeBridge();
  return typeof m.getBackupStatus === 'function';
}

const EMPTY_SNAPSHOT: BackupStatusSnapshot = {
  totalAssets: 0,
  completedAssets: 0,
  inProgressAssets: 0,
  failedAssets: 0,
  bytesUploaded: 0,
  bytesTotal: 0,
  state: 'idle',
  lastErrorMessage: null,
  backoffUntil: null,
};

export async function getBackupStatus(): Promise<BackupStatusSnapshot> {
  const m = nativeBridge();
  if (typeof m.getBackupStatus !== 'function') return EMPTY_SNAPSHOT;
  return m.getBackupStatus();
}

export async function getAssetStatus(
  localId: string,
): Promise<BackupAssetRuntimeStatus | null> {
  const m = nativeBridge();
  if (typeof m.getAssetStatus !== 'function') return null;
  return m.getAssetStatus(localId);
}

/**
 * One-shot migration of legacy SQLite rows into the Swift store. Safe to
 * invoke more than once — Swift no-ops when native state already exists.
 */
export async function migrateLegacyBackupState(
  rows: LegacyBackupRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const m = nativeBridge();
  if (typeof m.migrateLegacyBackupState !== 'function') {
    // Bridge not yet shipped — the migration helper will retry on the next
    // launch once Swift catches up.
    return;
  }
  await m.migrateLegacyBackupState(rows);
}

export interface BackupStatusSubscription {
  remove(): void;
}

/**
 * Subscribe to live snapshots from the native engine. Swift coalesces at
 * ≤ 2 Hz during active upload, edge-triggered on state transitions, so
 * subscribers won't be flooded by per-asset events.
 *
 * Returns a no-op subscription when the bridge is not yet ready, which lets
 * consumers wire `useEffect` without conditionals.
 */
export function subscribeBackupStatus(
  listener: (snapshot: BackupStatusSnapshot) => void,
): BackupStatusSubscription {
  const m = nativeBridge();
  if (typeof m.addBackupStatusListener !== 'function') {
    return { remove: () => {} };
  }
  return m.addBackupStatusListener(listener);
}
