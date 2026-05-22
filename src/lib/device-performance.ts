import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'beebeeb.devicePerformance.v1';
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export interface DevicePerformanceProfile {
  decryptBytesPerSecond: number;
  encryptionBytesPerSecond?: number;
  measuredAt: string;
  source: 'speedtest' | 'background';
}

interface CryptoBenchmark {
  isUnlocked: boolean;
  encryptChunk: (fileId: string, bytes: Uint8Array) => Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;
  decryptChunk: (fileId: string, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<Uint8Array>;
}

let calibrationPromise: Promise<DevicePerformanceProfile | null> | null = null;

export async function getDevicePerformanceProfile(): Promise<DevicePerformanceProfile | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DevicePerformanceProfile;
    if (!Number.isFinite(parsed.decryptBytesPerSecond) || parsed.decryptBytesPerSecond <= 0) return null;
    return parsed;
  } catch {
    await AsyncStorage.removeItem(KEY).catch(() => {});
    return null;
  }
}

export async function saveDevicePerformanceProfile(profile: DevicePerformanceProfile): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(profile));
}

export function estimatedDecryptSeconds(sizeBytes: number | null | undefined, profile: DevicePerformanceProfile | null): number | null {
  if (!sizeBytes || sizeBytes <= 0 || !profile?.decryptBytesPerSecond) return null;
  return Math.max(1, Math.ceil(sizeBytes / profile.decryptBytesPerSecond));
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export async function ensureDevicePerformanceProfile(crypto: CryptoBenchmark): Promise<DevicePerformanceProfile | null> {
  const existing = await getDevicePerformanceProfile();
  if (existing) {
    const measured = Date.parse(existing.measuredAt);
    if (Number.isFinite(measured) && Date.now() - measured < STALE_AFTER_MS) return existing;
  }
  return runBackgroundDecryptCalibration(crypto);
}

export function runBackgroundDecryptCalibration(crypto: CryptoBenchmark): Promise<DevicePerformanceProfile | null> {
  if (calibrationPromise) return calibrationPromise;
  calibrationPromise = (async () => {
    if (!crypto.isUnlocked) return null;
    const size = 2 * 1024 * 1024;
    const fileId = 'device-performance-calibration';
    const bytes = new Uint8Array(size);
    for (let i = 0; i < Math.min(bytes.length, 4096); i++) {
      bytes[i] = (i * 31) % 251;
    }

    const encrypted = await crypto.encryptChunk(fileId, bytes);
    const start = performance.now();
    await crypto.decryptChunk(fileId, encrypted.nonce, encrypted.ciphertext);
    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    const profile: DevicePerformanceProfile = {
      decryptBytesPerSecond: size / elapsedSeconds,
      measuredAt: new Date().toISOString(),
      source: 'background',
    };
    await saveDevicePerformanceProfile(profile);
    return profile;
  })().finally(() => {
    calibrationPromise = null;
  });
  return calibrationPromise;
}
