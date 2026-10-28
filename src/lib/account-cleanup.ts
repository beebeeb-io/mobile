import { clearAdopted } from './shared-folder-adoption';
import { clearSharedKeys } from './shared-folder-keys';
/**
 * Purges every on-disk plaintext cache this app writes, for BOTH regular
 * sign-out and account deletion.
 *
 * Task 1399 follow-up: Codex flagged that the generic `signOut()` cleared
 * credentials but left decrypted user data on disk (`thumbnail-cache.ts`'s
 * decrypted WebP thumbnails, `name-cache.ts`'s decrypted file names) —
 * recoverable plaintext left behind despite the app telling the user
 * everything was destroyed. 0300's own plaintext-lifecycle audit registry
 * (`PlaintextStorageProtection.swift`) already names every OTHER path this
 * app writes outside `Library/Caches/` (PhotoKit renders, offline blobs,
 * share-sheet staging, SQLite databases, the local-identifier map, the
 * thumbnail work queue, native backup staging, AsyncStorage, and the File
 * Provider extension's decrypted pinned/temp App Group directories) — a
 * zero-knowledge app must not leave any of it behind for whoever signs in
 * next on the same device.
 *
 * This combines both halves (+ every Library/Caches plaintext, task 1593 —
 * see `purgeDecryptedCaches`):
 * - `clearThumbnailCache()` / `clearNameCache()` — these ALSO reset
 *   in-memory JS state (the thumbnail path map, the name-cache save timer)
 *   that a native-only purge cannot reach, since that state lives in this
 *   JS process and would otherwise survive a sign-out within the same app
 *   session (no process restart happens between sign-out and the next
 *   sign-in).
 * - `purgePlaintextStorage()` (native) — sweeps every other registered path.
 *
 * Never throws — sign-out (and the account-deletion success path) must
 * never be blocked by a purge failure. A failed entry is safe to retry: the
 * native purge is idempotent and treats an already-absent path as clean.
 */
import {
  finishBackupManifestPurge,
  purgePlaintextStorage,
  type PlaintextStoragePurgeResult,
  type StoragePurgeMode,
} from '../../modules/beebeeb-crypto';
// Namespace import: a test's native mock without the gate leaves it undefined
// (no gate registered: BackupDatabase refuses to open), never a load error.
import * as NativeCrypto from '../../modules/beebeeb-crypto';
import { registerBackupManifestJsOpenGate } from './backup-manifest-js-open-gate';
import { purgeCachesPlaintext } from './caches-plaintext-registry';
import { clearLocalIdentifierMap } from './local-identifier-map';
// Task 1683f — sign-out sweeps the upload resume states (SecureStore keys that
// survive sign-out AND account switches otherwise; cross-account leak).
import { sweepAllUploadResumeStates } from './api';
import { clearNameCache } from './name-cache';
import { clearPreviewCache } from './native-decrypt';
import { clearPhotoCache } from './photo-cache';
import { clearThumbnailCache } from './thumbnail-cache';
import { plaintextGate } from './plaintext-gate';
import { withStoragePurgeParticipantsSuspended } from './storage-purge-participants';
import { clearBackupFolderCacheChecked, clearBackupFolderCacheForSignOut } from './backup-folder-cache';
import * as FileSystem from 'expo-file-system/legacy';
import { OFFLINE_DIR, offlineManager } from './offline-manager';

export type { PlaintextStoragePurgeResult, StoragePurgeMode };

// Task 1667 round 10 (review finding 7): BackupDatabase opens the manifest only
// through the native gate, which applies a sign-out reset still pending first.
// Registered here, at load (App.tsx imports this module at the top), because
// this module owns the other half of that protocol (the purge below and
// `finishBackupManifestPurge`). With no gate registered BackupDatabase refuses
// to open (fail closed).
registerBackupManifestJsOpenGate(NativeCrypto.admitBackupManifestJsOpen);

/**
 * Task 1667 round 9 (Codex P1 "Delete retained marks during permanent account
 * deletion", mobile#182 at dacc089d).
 *
 * Every purge says what it is for:
 * - `'sign-out'`: the account still exists. The native reset keeps its
 *   not-yet-marked camera-roll uploads as pending marks (30 days) so its next
 *   sign-in on this device does not upload them again.
 * - `'account-deleted'`: the account is gone for good. Nothing of it may stay
 *   on the device: its pending marks are deleted and none are kept, staged
 *   uploads, the manifest's rows and the backup folder cache go as on every
 *   purge, and a folder cache that cannot be confirmed gone counts as failed.
 *
 * An account deletion is STICKY for the rest of this signed-out stretch: the
 * deletion flow purges, then calls `signOut()`, which purges again, and the
 * signed-out surface purges once more (signed-out-purge.ts). Those later
 * purges pass no mode; they run as `'account-deleted'` for the same accounts
 * until a new session starts (`clearAccountDeletionPurge`, App.tsx
 * refreshAuth), so none of them can keep what the deletion removed. The
 * native side holds the same rule for the process (BackupManifestHandle).
 */
export interface PurgeAllOptions {
  /** Defaults to `'sign-out'`, or `'account-deleted'` while a deletion is pending. */
  mode?: StoragePurgeMode;
  /** The deleted account (`user.user_id`); added to the native outgoing account. */
  accountId?: string | null;
}

let deletedAccountIds: Set<string> | null = null;

/**
 * An account was deleted (here, or elsewhere: the 403 `account_deleted`
 * handler). Every purge until the next session runs as `'account-deleted'`.
 */
export function noteAccountDeleted(accountId: string | null | undefined): void {
  if (!deletedAccountIds) deletedAccountIds = new Set();
  if (accountId) deletedAccountIds.add(accountId);
}

/**
 * Task 1667 round 14 (review of mobile#182 at 18312919): the account a 403
 * `account_deleted` on a live session names. The signed-in user when App has
 * one; at a cold start (no user yet) the stored key's owner, read before
 * refreshAuth's getMe. null only when neither is known: the purge then
 * discards every kept mark on the device (fail closed).
 */
export function accountIdForDeletedElsewhere(
  signedInUserId: string | null | undefined,
  coldStartKeyOwner: string | null | undefined,
): string | null {
  return signedInUserId || coldStartKeyOwner || null;
}

/** A new session started: purges are ordinary sign-outs again. */
export function clearAccountDeletionPurge(): void {
  deletedAccountIds = null;
}

export function accountDeletionPurgePending(): boolean {
  return deletedAccountIds != null;
}

/** The mode and deleted accounts a purge runs with (exported for tests). */
export function resolvePurgeMode(options: PurgeAllOptions = {}): {
  mode: StoragePurgeMode;
  deletedAccountIds: string[];
} {
  // A deletion can never be downgraded: an explicit 'sign-out' while one is
  // pending still runs as a deletion.
  if (options.mode === 'account-deleted') noteAccountDeleted(options.accountId);
  if (!deletedAccountIds) return { mode: 'sign-out', deletedAccountIds: [] };
  return { mode: 'account-deleted', deletedAccountIds: [...deletedAccountIds] };
}

/**
 * Every decrypted-content cache this JS process owns, incl. all of
 * `Library/Caches/` that the native registry deliberately skips:
 * - `clearPreviewCache()` — `Library/Caches/preview/`; also aborts decrypts
 *   still in flight so none writes a file after the purge (task 1593).
 * - `clearPhotoCache()` — `Library/Caches/beebeeb-photo-cache/` (decrypted
 *   photo/video originals from the Photos pager) + its in-memory map
 *   (task 1593 round 2, P1-A: it had zero callers).
 * - `purgeCachesPlaintext()` — every other plaintext writer registered in
 *   `caches-plaintext-registry.ts` (task 1593 round 2, P2-E). Runs LAST so it
 *   also catches anything written while the two above were aborting.
 * Never throws.
 */
async function sweepDecryptedCaches(): Promise<{ removed: string[]; failed: string[] }> {
  clearSharedKeys();
  await Promise.allSettled([
    clearAdopted(),
    clearThumbnailCache(),
    clearNameCache(),
    clearPreviewCache(),
    clearPhotoCache(),
    // Task 1683d (ora-2 ruling) — the two documentDirectory plaintext leaves
    // no earlier sweep reached: the offline encrypted blobs + the identifier
    // map (PHAsset local ids are account-scoped). Both writers' in-memory
    // state resets inside these calls too (offlineManager.clearPersisted
    // OfflineState drops the SecureStore manifest + maps; the identifier map's
    // clear resets its hydration flag).
    FileSystem.deleteAsync(OFFLINE_DIR, { idempotent: true }).catch(() => {}),
    clearLocalIdentifierMap(),
    offlineManager.clearPersistedOfflineState(),
  ]);
  return purgeCachesPlaintext().catch(() => ({ removed: [], failed: [] }));
}

/**
 * Task 1593 round 3 (#141 Codex P1) — both purges run INSIDE
 * `plaintextGate.purge()`: the gate closes (no plaintext writer may start or
 * finish a write any more), every writer holding a lease is drained (bounded;
 * a writer past the bound discards its own output), and only then does the
 * sweep run. The gate stays closed until the next session opens it, so the
 * sweep cannot be followed by a write — a single sweep is a guarantee again.
 */
export async function purgeDecryptedCaches(): Promise<void> {
  await plaintextGate.purge(sweepDecryptedCaches).catch(() => undefined);
}

export async function purgeAllPlaintextCaches(options: PurgeAllOptions = {}): Promise<PlaintextStoragePurgeResult> {
  const purge = resolvePurgeMode(options);
  const result = await plaintextGate
    .purge(async () => {
      const swept = await sweepDecryptedCaches();
      // True counts (task 1683d): compose the JS sweep's real outcome with the
      // native registry purge (iOS work; Android reports {removed:0} by
      // design — the JS sweep above IS the Android purge surface). Additive:
      // native counts registry paths, the sweep counts caches entries, the
      // sets are disjoint by construction (the native registry deliberately
      // excludes Library/Caches).
      // Task 1667: JS work on files the native purge touches (the backup
      // manifest's expo-sqlite connection) is held until the native side has
      // emptied the manifest in place; the handle itself stays open.
      // Round 2 (Codex P1 "Reopen the JS database after a reset failure"):
      // when the native reset failed, the file was kept because this handle
      // is open on it. Close the handle (still under the hold), then let the
      // native side reset or replace the file with no connection open; the
      // next JS call reopens. Never unlink beneath an open handle.
      // Round 7 sweep: a native purge that throws is a FAILED purge. The catch
      // used to turn it into { failed: 0 }, so a sign-out whose native
      // registry sweep (and manifest reset) never ran reported a clean purge.
      const native = await withStoragePurgeParticipantsSuspended(async ({ closeHandles }) => {
        const purged = await purgePlaintextStorage({
          mode: purge.mode,
          deletedAccountIds: purge.deletedAccountIds,
        });
        if (!purged.backupManifestResetFailed) return purged;
        const closed = await closeHandles();
        // Round 10 (review finding 7): on `ok: 0` the reset stays pending
        // natively and the file may still hold the outgoing account's rows.
        // BackupDatabase reopens lazily after `resume`, but only through the
        // native gate (backup-manifest-js-open-gate.ts), which applies the
        // pending reset first and refuses while it cannot: JS never reads
        // those rows.
        const finished = await finishBackupManifestPurge(closed).catch(() => ({ ok: 0, unlinked: 0 }));
        return {
          removed: purged.removed + (finished.unlinked ? 1 : 0),
          failed: purged.failed + (finished.ok ? 0 : 1),
        };
      }).catch(() => ({ removed: 0, failed: 1 }) as PlaintextStoragePurgeResult);
      return {
        removed: native.removed + swept.removed.length,
        failed: native.failed + swept.failed.length,
      };
    })
    .catch(() => ({ removed: 0, failed: 1 }));
  // Task 1683f — sign-out sweeps the upload resume states (SecureStore keys
  // survive sign-out AND account switches otherwise; cross-account leak).
  // Best-effort: never breaks the sign-out flow, counted or not.
  await sweepAllUploadResumeStates().catch(() => {});
  // Task 1962 Bug 4: the backup folder ids are per account. Round 9: after an
  // account deletion a folder cache that is still there is a failed purge.
  if (purge.mode === 'account-deleted') {
    if (!(await clearBackupFolderCacheChecked())) {
      return { ...result, failed: result.failed + 1 };
    }
    return result;
  }
  await clearBackupFolderCacheForSignOut();
  return result;
}

export interface PurgeThenSignOutDeps {
  /** Injected for testability — production call sites pass purgeAllPlaintextCaches. */
  purge: () => Promise<PlaintextStoragePurgeResult>;
  signOut: () => Promise<void>;
}

/**
 * Order matters: purge every on-disk plaintext cache BEFORE signOut() runs.
 * `signOut()` also purges internally (so every ordinary sign-out gets this
 * for free), but the account-deletion flow calls this explicitly first —
 * defense in depth, so the deletion's own cleanup guarantee does not
 * silently depend on signOut()'s internal step order never changing.
 */
export async function purgeThenSignOut(deps: PurgeThenSignOutDeps): Promise<void> {
  await deps.purge();
  await deps.signOut();
}
