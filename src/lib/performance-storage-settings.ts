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

const PROFILE_ESTIMATES: Record<PerformanceStorageProfile, Omit<PerformanceStorageEstimate, 'estimatedBytes'>> = {
  light: {
    thumbnailBytesPerFile: 20 * 1024,
    localPreviewBudgetBytes: 150 * 1024 * 1024,
    label: 'Light',
    description: 'Uses less storage. Thumbnails and previews are loaded more cautiously.',
  },
  balanced: {
    thumbnailBytesPerFile: 50 * 1024,
    localPreviewBudgetBytes: 500 * 1024 * 1024,
    label: 'Balanced',
    description: 'Keeps medium thumbnails and recent previews cached for normal use.',
  },
  smooth: {
    thumbnailBytesPerFile: 90 * 1024,
    localPreviewBudgetBytes: 1_500 * 1024 * 1024,
    label: 'Smooth',
    description: 'Keeps more thumbnails warm and reserves space for a larger local preview tier.',
  },
};

export function estimatePerformanceStorage(
  fileCount: number,
  profile: PerformanceStorageProfile,
): PerformanceStorageEstimate {
  const base = PROFILE_ESTIMATES[profile];
  return {
    ...base,
    estimatedBytes: Math.max(0, fileCount) * base.thumbnailBytesPerFile + base.localPreviewBudgetBytes,
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
