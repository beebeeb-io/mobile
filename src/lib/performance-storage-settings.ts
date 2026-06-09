import AsyncStorage from '@react-native-async-storage/async-storage';

export type PerformanceStorageProfile = 'light' | 'balanced' | 'smooth';

export interface PerformanceStorageSettings {
  profile: PerformanceStorageProfile;
}

export interface PerformanceStorageEstimate {
  thumbnailBytesPerFile: number;
  localPreviewBudgetBytes: number;
  estimatedBytes: number;
  label: string;
  description: string;
}

const SETTINGS_KEY = 'beebeeb:performance-storage-settings:v1';

export const DEFAULT_PERFORMANCE_STORAGE_SETTINGS: PerformanceStorageSettings = {
  profile: 'balanced',
};

// Task 0552: normal thumbnails use the user's Thumbnail Quality setting. This
// setting controls fetch behaviour and whether Preview uses an extra large tier:
//   - light    → remote thumbnails fetch only when a tile scrolls into view
//   - balanced → normal thumbnails prefetch around the viewport (default)
//   - smooth   → balanced grid behaviour plus large preview thumbnails on tap
// Estimate adds the ~25-byte blurhash placeholder per file regardless of
// profile, since the placeholder is always cached locally.
const BLURHASH_BYTES_PER_FILE = 25;
const PROFILE_ESTIMATES: Record<PerformanceStorageProfile, Omit<PerformanceStorageEstimate, 'estimatedBytes'>> = {
  light: {
    thumbnailBytesPerFile: 100 * 1024,
    localPreviewBudgetBytes: 150 * 1024 * 1024,
    label: 'Data saver',
    description: 'Loads remote thumbnails only when they scroll into view. Photo taps reuse the normal thumbnail.',
  },
  balanced: {
    thumbnailBytesPerFile: 100 * 1024,
    localPreviewBudgetBytes: 500 * 1024 * 1024,
    label: 'Balanced',
    description: 'Prefetches normal thumbnails around the viewport. Photo taps reuse the normal thumbnail.',
  },
  smooth: {
    thumbnailBytesPerFile: 100 * 1024,
    localPreviewBudgetBytes: 1_500 * 1024 * 1024,
    label: 'Smooth',
    description: 'Prefetches normal thumbnails around the viewport and loads a larger preview thumbnail on photo tap.',
  },
};

/** Public-facing label for each profile (used by the Settings segmented
 *  control). Source of truth — do NOT capitalize the profile id at the
 *  render site; look it up here. */
export const PROFILE_LABELS: Record<PerformanceStorageProfile, string> = {
  light: PROFILE_ESTIMATES.light.label,
  balanced: PROFILE_ESTIMATES.balanced.label,
  smooth: PROFILE_ESTIMATES.smooth.label,
};

export function estimatePerformanceStorage(
  fileCount: number,
  profile: PerformanceStorageProfile,
): PerformanceStorageEstimate {
  const base = PROFILE_ESTIMATES[profile];
  return {
    ...base,
    // task 0552: 100 KB thumbnail cap + ~25 byte blurhash per file
    estimatedBytes:
      Math.max(0, fileCount) * (base.thumbnailBytesPerFile + BLURHASH_BYTES_PER_FILE)
      + base.localPreviewBudgetBytes,
  };
}

export function profileEstimateInputs(profile: PerformanceStorageProfile): Omit<PerformanceStorageEstimate, 'estimatedBytes'> {
  return PROFILE_ESTIMATES[profile];
}

function normalizeSettings(value: Partial<PerformanceStorageSettings> | null): PerformanceStorageSettings {
  const profile = value?.profile;
  return {
    profile: profile === 'light' || profile === 'balanced' || profile === 'smooth'
      ? profile
      : DEFAULT_PERFORMANCE_STORAGE_SETTINGS.profile,
  };
}

export async function getPerformanceStorageSettings(): Promise<PerformanceStorageSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY).catch(() => null);
  if (!raw) return DEFAULT_PERFORMANCE_STORAGE_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<PerformanceStorageSettings>);
  } catch {
    await AsyncStorage.removeItem(SETTINGS_KEY).catch(() => {});
    return DEFAULT_PERFORMANCE_STORAGE_SETTINGS;
  }
}

export async function setPerformanceStorageSettings(
  next: PerformanceStorageSettings,
): Promise<PerformanceStorageSettings> {
  const normalized = normalizeSettings(next);
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}
