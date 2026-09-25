// Task 1539 (finding 1, P0): shared "Lock file" enforcement for PreviewScreen.
//
// Bug: the ONLY place that ever checked `isFileLocked()` was FilesScreen's
// `openFile()`, at the moment of the tap (grep confirmed exactly one call
// site). PhotosScreen's `openPhoto()` built the same Preview navigation
// params directly and never imported `isFileLocked` at all, so opening a
// locked photo/video from the Photos tab skipped the Face ID gate entirely.
// Worse, PreviewScreen's own swipe pager (`photoList` / `handlePagerScroll`)
// never re-checked the lock per index, so swiping from an unlocked neighbor
// into a locked file bypassed the gate too, even when Preview WAS reached
// through Files. The app still showed the "is now locked" success toast,
// creating false security assurance.
//
// Fix: PreviewScreen now owns the check itself (this module), on mount AND
// on every pager index change — not just at the caller's tap handler.
// PhotosScreen additionally gets the same pre-navigation check FilesScreen
// already had, so a locked photo doesn't even flash unlocked content while
// Preview's own gate is still resolving the SecureStore read.
//
// Kept dependency-free of React/navigation (only wraps file-locks.ts),
// matching the repo's "pure logic in lib/, unit-tested directly" convention
// (phrase-confirmation-gate.ts, startup-auth.ts, two-factor-setup-gate.ts).

import { isFileLocked } from './file-locks';

/**
 * Check lock status for a batch of file ids in parallel (e.g. the bounded
 * photo-swipe window PhotosScreen hands to Preview, or just `[fileId]` for a
 * single non-swipe open) and return the subset that are locked.
 */
export async function checkLockedFileIds(ids: readonly string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(ids));
  const flags = await Promise.all(unique.map((id) => isFileLocked(id)));
  const locked = new Set<string>();
  flags.forEach((isLocked, i) => {
    if (isLocked) locked.add(unique[i]);
  });
  return locked;
}

/**
 * Whether content for `fileId` must be gated behind Face ID right now:
 * locked AND not already authenticated earlier in this same screen session.
 * `authenticatedIds` lets a user unlock a file once per Preview session
 * instead of re-prompting on every swipe back to a file they already
 * authenticated for — the lock check itself still runs on every index
 * change (this function is called fresh each time), it just isn't gated
 * again for an id already proven this session.
 */
export function isPreviewGated(
  fileId: string | null | undefined,
  lockedIds: ReadonlySet<string>,
  authenticatedIds: ReadonlySet<string>,
): boolean {
  if (!fileId) return false;
  return lockedIds.has(fileId) && !authenticatedIds.has(fileId);
}

/**
 * Task 1539 (Codex P1 follow-up, PR #109 review): combines `isPreviewGated`
 * with the async lock-check's readiness flag, for every per-page gate that
 * decides whether a swipe-pager page may start loading content.
 *
 * `lockedIds` starts as an EMPTY set while `checkLockedFileIds` is still in
 * flight, so `isPreviewGated` alone reports every page "unlocked" during
 * that startup window — a locked file's thumbnail/decrypt could start
 * before we even know it's locked. This fails closed instead: nothing may
 * be treated as unlocked until the lookup has actually resolved once.
 */
export function isPagerPageGated(
  fileId: string | null | undefined,
  lockedIds: ReadonlySet<string>,
  authenticatedIds: ReadonlySet<string>,
  lockCheckReady: boolean,
): boolean {
  if (!lockCheckReady) return true;
  return isPreviewGated(fileId, lockedIds, authenticatedIds);
}
