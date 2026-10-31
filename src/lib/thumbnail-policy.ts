export type ThumbnailVariant = 'small' | 'medium' | 'large';

export const THUMB_SMALL_WIDTH = 384;
export const THUMB_WIDTH = 768;
export const THUMB_LARGE_WIDTH = 1600;
// Grid thumbnails use one fixed quality (q0.35, WebP), measured on real camera
// photos: no visible loss at grid size, far smaller than the old q0.8. Small and
// medium keep the same quality and only degrade by width under the byte cap.
// Keep in sync with `ThumbnailGenerator.swift` (guarded by a test).
export const MAX_THUMB_BYTES = 100 * 1024;
export const MAX_SMALL_THUMB_BYTES = 24 * 1024;
export const MAX_LARGE_THUMB_BYTES = 480 * 1024;

export const THUMB_VARIANTS = [
  { width: THUMB_WIDTH, quality: 0.35 },
  { width: 640, quality: 0.35 },
  { width: 512, quality: 0.35 },
] as const;

export const THUMB_VARIANTS_BY_SIZE: Record<ThumbnailVariant, readonly { width: number; quality: number }[]> = {
  small: [
    { width: THUMB_SMALL_WIDTH, quality: 0.35 },
    { width: 320, quality: 0.35 },
    { width: 256, quality: 0.35 },
  ],
  medium: THUMB_VARIANTS,
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
