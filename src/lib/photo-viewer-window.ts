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
