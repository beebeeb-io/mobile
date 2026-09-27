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
 * This combines both halves (+ the preview cache, task 1593):
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
import { clearNameCache } from './name-cache';
import { clearPreviewCache } from './native-decrypt';
import { clearThumbnailCache } from './thumbnail-cache';

export type { PlaintextStoragePurgeResult };

export async function purgeAllPlaintextCaches(): Promise<PlaintextStoragePurgeResult> {
  // Task 1593 (P1): `clearPreviewCache()` — the decrypted full-file previews
  // in `Library/Caches/preview/`. The native registry below deliberately
  // excludes `Library/Caches/`, so without this every file opened this
  // session stayed on disk in the clear after sign-out.
  await Promise.allSettled([clearThumbnailCache(), clearNameCache(), clearPreviewCache()]);
  return purgePlaintextStorage();
}

/**
 * Task 1593 — nobody is signed in (a cold launch with no stored session, a
 * rejected token, a session that expired or an account deleted elsewhere):
 * whatever the last session decrypted into the preview cache must not stay
 * on disk — the previous session may have ended in a crash or a forced
 * sign-out that never reached `signOut()`'s purge. Never throws.
 */
export async function purgePreviewPlaintextWhileSignedOut(): Promise<void> {
  await clearPreviewCache().catch(() => {});
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
