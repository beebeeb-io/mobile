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

// Task 0552: thumbnails are always 768px @ ≤100 KB (the cap was bumped from
// 50 KB so complex photos don't degrade to 384px). The setting now controls
// DOWNLOAD BEHAVIOUR, not thumbnail size:
//   - light    → no prefetch, fetch on viewport entry only
//   - balanced → prefetch a 200-tile window around the viewport (default)
//   - smooth   → full-library prefetch on app launch
// Estimate adds the ~25-byte blurhash placeholder per file regardless of
// profile, since the placeholder is always cached locally.
const BLURHASH_BYTES_PER_FILE = 25;
const PROFILE_ESTIMATES: Record<PerformanceStorageProfile, Omit<PerformanceStorageEstimate, 'estimatedBytes'>> = {
  light: {
    thumbnailBytesPerFile: 100 * 1024,
    localPreviewBudgetBytes: 150 * 1024 * 1024,
    label: 'Data saver',
    description: 'Thumbnails fetch only when a tile scrolls into view. Lowest data use.',
  },
  balanced: {
    thumbnailBytesPerFile: 100 * 1024,
    localPreviewBudgetBytes: 500 * 1024 * 1024,
    label: 'Balanced',
    description: 'Prefetches a 200-tile window around the viewport so scrolling feels smooth.',
  },
  smooth: {
    thumbnailBytesPerFile: 100 * 1024,
    localPreviewBudgetBytes: 1_500 * 1024 * 1024,
    label: 'Smooth',
    description: 'Prefetches the entire library on launch. Uses the most data but no waits.',
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
