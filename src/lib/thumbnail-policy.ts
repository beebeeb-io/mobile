export type ThumbnailVariant = 'small' | 'medium' | 'large';

export const THUMB_SMALL_WIDTH = 384;
export const THUMB_WIDTH = 768;
export const THUMB_LARGE_WIDTH = 1600;
// Task 0552: bumped from 50KB to 100KB so complex photos don't get pushed down
// the degrade ladder to 384px @ q0.54 — at iPhone Pro 3x density the 2-col
// Photos grid renders tiles ~580px wide, so 384px upscales 1.5x and looks
// blurry. 768px @ ~q0.8 with a 100KB cap covers the realistic content range.
export const MAX_THUMB_BYTES = 100 * 1024;
export const MAX_SMALL_THUMB_BYTES = 24 * 1024;
export const MAX_LARGE_THUMB_BYTES = 480 * 1024;

export const THUMB_VARIANTS = [
  { width: THUMB_WIDTH, quality: 0.82 },
  { width: THUMB_WIDTH, quality: 0.74 },
  { width: THUMB_WIDTH, quality: 0.66 },
  { width: THUMB_WIDTH, quality: 0.58 },
  { width: THUMB_WIDTH, quality: 0.5 },
] as const;

export const THUMB_VARIANTS_BY_SIZE: Record<ThumbnailVariant, readonly { width: number; quality: number }[]> = {
  small: [
    { width: THUMB_SMALL_WIDTH, quality: 0.78 },
    { width: THUMB_SMALL_WIDTH, quality: 0.66 },
    { width: THUMB_SMALL_WIDTH, quality: 0.54 },
    { width: 320, quality: 0.5 },
    { width: 256, quality: 0.48 },
  ],
  medium: [
    ...THUMB_VARIANTS,
    { width: 640, quality: 0.58 },
    { width: 512, quality: 0.56 },
    { width: 384, quality: 0.54 },
  ],
  large: [
    { width: THUMB_LARGE_WIDTH, quality: 0.90 },
    { width: THUMB_LARGE_WIDTH, quality: 0.82 },
    { width: THUMB_LARGE_WIDTH, quality: 0.74 },
    { width: THUMB_LARGE_WIDTH, quality: 0.66 },
    { width: THUMB_LARGE_WIDTH, quality: 0.58 },
    { width: THUMB_LARGE_WIDTH, quality: 0.50 },
  ],
};

export const MAX_THUMB_BYTES_BY_SIZE: Record<ThumbnailVariant, number> = {
  small: MAX_SMALL_THUMB_BYTES,
  medium: MAX_THUMB_BYTES,
  large: MAX_LARGE_THUMB_BYTES,
};

export const THUMB_CACHE_DIR_NAME = 'beebeeb-thumbnails-v3';
export const LEGACY_THUMB_CACHE_DIR_NAMES = [
  'beebeeb-thumbnails-v2',
  'beebeeb-thumbnails',
] as const;
