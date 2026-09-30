export function clampPhotoIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(total - 1, Math.round(index)));
}

/**
 * Task 1669 round 2 (lead ruling): how many pages either side of the current one keep their
 * full-resolution IMAGE / RAW resource loaded. 1 => at most 3 pages (current +-1), which matches
 * the pager's `windowSize={3}`; a swipe back to a neighbour then needs no re-download or
 * re-decrypt. VIDEO is deliberately NOT governed by this: an AVPlayer is bounded to the current
 * page only (see PhotoPage's `loadFull`).
 */
export const PHOTO_PAGE_LOAD_RADIUS = 1;

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
