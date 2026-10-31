import { getPreferenceValue, getPreferenceValueStrict, setPreferenceValue } from './api';

export type PreviewFormat = 'heic' | 'jpeg';
export type PreviewPx = 1280 | 1920 | 2560 | 3840;

export interface PhotoPreviewSetting {
  enabled: boolean;
  format: PreviewFormat;
  px: PreviewPx;
}

export const DEFAULT_PHOTO_PREVIEW_SETTING: PhotoPreviewSetting = { enabled: false, format: 'heic', px: 2560 };

export const PREVIEW_SIZE_OPTIONS: { label: '720p' | '1080p' | '2K' | '4K'; px: PreviewPx }[] = [
  { label: '720p', px: 1280 },
  { label: '1080p', px: 1920 },
  { label: '2K', px: 2560 },
  { label: '4K', px: 3840 },
];

const PREFERENCE_KEY = 'photo_previews';

/** Lenient parse: every invalid field falls back to its default. */
export function parsePhotoPreviewSetting(raw: unknown): PhotoPreviewSetting {
  const d = DEFAULT_PHOTO_PREVIEW_SETTING;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    format: o.format === 'heic' || o.format === 'jpeg' ? o.format : d.format,
    px: PREVIEW_SIZE_OPTIONS.some((s) => s.px === o.px) ? (o.px as PreviewPx) : d.px,
  };
}

function settingFromStored(stored: unknown): PhotoPreviewSetting {
  if (typeof stored === 'string') {
    try {
      return parsePhotoPreviewSetting(JSON.parse(stored));
    } catch {
      return { ...DEFAULT_PHOTO_PREVIEW_SETTING };
    }
  }
  return parsePhotoPreviewSetting(stored);
}

/** Lenient: any read failure answers the default. Use the strict loader when Off must mean Off. */
export async function loadPhotoPreviewSetting(): Promise<PhotoPreviewSetting> {
  return settingFromStored(await getPreferenceValue(PREFERENCE_KEY));
}

/** Throws when the server cannot be asked; the default only when the value is unset. */
export async function loadPhotoPreviewSettingStrict(): Promise<PhotoPreviewSetting> {
  return settingFromStored(await getPreferenceValueStrict(PREFERENCE_KEY));
}

export async function savePhotoPreviewSetting(setting: PhotoPreviewSetting): Promise<void> {
  await setPreferenceValue(PREFERENCE_KEY, {
    enabled: setting.enabled,
    format: setting.format,
    px: setting.px,
  });
}

/** Long edge becomes min(px, longEdge); aspect kept; never upscales. */
export function previewTargetSize(width: number, height: number, px: PreviewPx): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= px) return { width: Math.round(width), height: Math.round(height) };
  const scale = px / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
