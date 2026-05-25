import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';

const STORAGE_KEY = 'beebeeb:thumbnail-quality:v1';

export interface ThumbnailQuality {
  width: number;
  quality: number;
  updatedAt: number;
}

export const DEFAULT_QUALITY: ThumbnailQuality = {
  width: 768,
  quality: 0.82,
  updatedAt: 0,
};

/**
 * Convert a continuous slider position [0, 1] to a {width, quality} object.
 *
 * Width: 256–1280 px, snapped to the nearest 32-px grid.
 * Quality: 0.65–0.95, rounded to 2 decimal places.
 */
export function fromSliderT(t: number): { width: number; quality: number } {
  const clamped = Math.max(0, Math.min(1, t));
  const widthRaw = 256 + clamped * (1280 - 256);
  const width = Math.max(256, Math.min(1280, Math.round(widthRaw / 32) * 32));
  const quality = 0.65 + clamped * (0.95 - 0.65);
  return { width, quality: Math.round(quality * 100) / 100 };
}

/**
 * Inverse of `fromSliderT`. Averages the t-value implied by width and quality
 * to give a single representative slider position in [0, 1].
 */
export function toSliderT(q: { width: number; quality: number }): number {
  const tFromWidth = (q.width - 256) / (1280 - 256);
  const tFromQuality = (q.quality - 0.65) / (0.95 - 0.65);
  return Math.max(0, Math.min(1, (tFromWidth + tFromQuality) / 2));
}

/**
 * Encode quality parameters as a compact preset string, e.g. "w768q082".
 * Width is 3–4 digits (zero-padded to 3); quality is the integer percentage
 * (zero-padded to 3, e.g. 82% → "082").
 */
export function toPreset(q: { width: number; quality: number }): string {
  const widthStr = String(q.width).padStart(3, '0');
  const qualStr = String(Math.round(q.quality * 100)).padStart(3, '0');
  return `w${widthStr}q${qualStr}`;
}

/**
 * Parse a preset string back to {width, quality}. Returns null if the format
 * does not match.
 */
export function fromPreset(s: string): { width: number; quality: number } | null {
  const m = /^w(\d{3,4})q(\d{2,3})$/.exec(s);
  if (!m) return null;
  return { width: parseInt(m[1], 10), quality: parseInt(m[2], 10) / 100 };
}

/**
 * Load the persisted thumbnail quality setting from AsyncStorage.
 * Falls back to DEFAULT_QUALITY on any error or missing value.
 */
export async function getThumbnailQuality(): Promise<ThumbnailQuality> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUALITY;
    const parsed = JSON.parse(raw) as ThumbnailQuality;
    if (typeof parsed.width !== 'number' || typeof parsed.quality !== 'number') return DEFAULT_QUALITY;
    return parsed;
  } catch {
    return DEFAULT_QUALITY;
  }
}

/**
 * Persist the thumbnail quality setting.
 * On iOS, also mirrors width + quality into the App Group shared defaults so
 * the native worker pool can read them without going through JS.
 */
export async function setThumbnailQuality(input: { width: number; quality: number }): Promise<ThumbnailQuality> {
  const next: ThumbnailQuality = { width: input.width, quality: input.quality, updatedAt: Date.now() };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (Platform.OS === 'ios') {
    const userDefaults = (NativeModules as Record<string, unknown> & { BeebeebSharedDefaults?: { setNumber?: (key: string, val: number) => Promise<void> } }).BeebeebSharedDefaults;
    if (userDefaults?.setNumber) {
      try {
        await userDefaults.setNumber('beebeeb_thumbnail_quality_width', next.width);
        await userDefaults.setNumber('beebeeb_thumbnail_quality_jpeg', next.quality);
      } catch {
        // Best-effort; native defaults mirror is non-critical.
      }
    }
  }
  return next;
}

/**
 * Convenience: load the current quality and return it as a preset string.
 */
export async function getCurrentPreset(): Promise<string> {
  const q = await getThumbnailQuality();
  return toPreset(q);
}
