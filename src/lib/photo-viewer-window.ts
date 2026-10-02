export function clampPhotoIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(total - 1, Math.round(index)));
}

export function activePhotoPageIndices(
  currentIndex: number,
  total: number,
  radius = 1,
): Set<number> {
  const current = clampPhotoIndex(currentIndex, total);
  const indexes = new Set<number>();
  for (let offset = -radius; offset <= radius; offset += 1) {
    const index = current + offset;
    if (index >= 0 && index < total) indexes.add(index);
  }
  return indexes;
}

/**
 * Task 1669 Issue 1 — bounds how many swipe-pager pages may keep a fully
 * loaded resource (a real AVPlayer for a video entry, a full-resolution
 * decoded image otherwise) alive at once.
 *
 * Before this, `PreviewScreen`'s `PhotoPage` set `uri` (and, for a video
 * entry, therefore the `useVideoPlayer` source) once a page's
 * `shouldLoadFull` gate fired, and never cleared it again when that gate
 * turned back off — the page component stays mounted (FlatList's
 * `windowSize={3}`) well after it stops being the active page, so `uri`
 * and its live `AVPlayer` just sat there. Scrolling through N video
 * entries left N live players simultaneously alive with no bound at all:
 * the device log immediately before the 08:41 jetsam kill on build 229
 * (`_qa-evidence/1667/iphone-live-0838.log`) shows 14 `AVPlayer ... Player
 * deallocated` pairs go out together, all created moments earlier while
 * Guus was "scrolling old photos and opening one" — 14 simultaneously
 * live full-resolution loads, not one.
 *
 * `reconcileLoadedPages` is the pure release decision: given the set of
 * page indexes that currently hold loaded state and the set that
 * `activePhotoPageIndices` says should be active right now, it returns
 * every loaded index that is no longer active and must release its
 * resources. `PhotoPage`'s effect calls this (indirectly, via its own
 * `shouldLoadFull` prop) to clear `uri`/`originalUri` the instant a page
 * leaves the active window, which drops `useVideoPlayer`'s source to
 * `null` and lets expo-video release the underlying `AVPlayer`.
 */
export function reconcileLoadedPages(
  loadedIndexes: ReadonlySet<number>,
  activeIndexes: ReadonlySet<number>,
): number[] {
  const toRelease: number[] = [];
  for (const index of loadedIndexes) {
    if (!activeIndexes.has(index)) toRelease.push(index);
  }
  return toRelease;
}

export function photoPrefetchOrder(
  currentIndex: number,
  total: number,
  radius = 2,
): number[] {
  if (total <= 0) return [];
  const current = clampPhotoIndex(currentIndex, total);
  const order = [current];

  for (let offset = 1; offset <= radius; offset += 1) {
    const next = current + offset;
    const previous = current - offset;
    if (next < total) order.push(next);
    if (previous >= 0) order.push(previous);
  }

  return order;
}
