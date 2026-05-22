export type ThumbnailVariant = 'small' | 'medium' | 'large';

export const THUMB_SMALL_WIDTH = 384;
export const THUMB_WIDTH = 768;
export const THUMB_LARGE_WIDTH = 1280;
export const MAX_THUMB_BYTES = 50 * 1024;
export const MAX_SMALL_THUMB_BYTES = 24 * 1024;
export const MAX_LARGE_THUMB_BYTES = 150 * 1024;

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
    { width: THUMB_LARGE_WIDTH, quality: 0.84 },
    { width: THUMB_LARGE_WIDTH, quality: 0.76 },
    { width: THUMB_LARGE_WIDTH, quality: 0.68 },
    { width: 1024, quality: 0.7 },
    { width: THUMB_WIDTH, quality: 0.74 },
    { width: 640, quality: 0.62 },
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
