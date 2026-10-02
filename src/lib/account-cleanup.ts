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
import { purgePlaintextStorage, type PlaintextStoragePurgeResult } from '../../modules/beebeeb-crypto';
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
import * as FileSystem from 'expo-file-system/legacy';
import { OFFLINE_DIR, offlineManager } from './offline-manager';

export type { PlaintextStoragePurgeResult };

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
  await Promise.allSettled([
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

export async function purgeAllPlaintextCaches(): Promise<PlaintextStoragePurgeResult> {
  const result = await plaintextGate
    .purge(async () => {
      const swept = await sweepDecryptedCaches();
      // True counts (task 1683d): compose the JS sweep's real outcome with the
      // native registry purge (iOS work; Android reports {removed:0} by
      // design — the JS sweep above IS the Android purge surface). Additive:
      // native counts registry paths, the sweep counts caches entries, the
      // sets are disjoint by construction (the native registry deliberately
      // excludes Library/Caches).
      const native = await purgePlaintextStorage().catch(() => ({ removed: 0, failed: 0 }) as PlaintextStoragePurgeResult);
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
