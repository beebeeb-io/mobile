export const PHOTO_GRID_COLUMN_STEPS = [2, 4, 7, 12] as const;
export const DEFAULT_PHOTO_GRID_COLUMNS = 4;

export function columnsForPinchScale(startColumns: number, scale: number): number {
  const startIdx = PHOTO_GRID_COLUMN_STEPS.indexOf(startColumns as (typeof PHOTO_GRID_COLUMN_STEPS)[number]);
  const currentIdx = startIdx >= 0
    ? startIdx
    : PHOTO_GRID_COLUMN_STEPS.indexOf(DEFAULT_PHOTO_GRID_COLUMNS);
  let nextIdx = currentIdx;

  if (scale < 0.48) {
    nextIdx = currentIdx + 3;
  } else if (scale < 0.68) {
    nextIdx = currentIdx + 2;
  } else if (scale < 0.9) {
    nextIdx = currentIdx + 1;
  } else if (scale > 2.1) {
    nextIdx = currentIdx - 3;
  } else if (scale > 1.55) {
    nextIdx = currentIdx - 2;
  } else if (scale > 1.12) {
    nextIdx = currentIdx - 1;
  }

  nextIdx = Math.max(0, Math.min(PHOTO_GRID_COLUMN_STEPS.length - 1, nextIdx));
  return PHOTO_GRID_COLUMN_STEPS[nextIdx] ?? DEFAULT_PHOTO_GRID_COLUMNS;
}
