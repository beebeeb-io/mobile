/**
 * Task 2233 round 2 (P1-1) — a cancelled / dropped thumbnail load is NOT the
 * same outcome as "this file has no thumbnail".
 *
 * The queue and `fetchDecryptedThumbnailUri` resolve this sentinel when the
 * load was withdrawn (unmount, viewport change, account switch, cap overflow).
 * Callers ignore it: no `setState`, never `failed`, never `onUnavailable`.
 * Only a real 404 / missing thumbnail / decrypt failure resolves `null`.
 *
 * Kept in its own dependency-free module so the hook, the queue and the
 * fetch pipeline share ONE identity and tests can import it without pulling
 * in the native modules.
 */
export const THUMBNAIL_LOAD_CANCELLED = Symbol('thumbnail-load-cancelled');

export type ThumbnailLoadResult = string | null | typeof THUMBNAIL_LOAD_CANCELLED;

export function isThumbnailLoadCancelled(value: unknown): value is typeof THUMBNAIL_LOAD_CANCELLED {
  return value === THUMBNAIL_LOAD_CANCELLED;
}
