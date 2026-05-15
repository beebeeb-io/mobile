import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { markUnlocked } from './lock-state';

export type DeviceOwnerAuthResult =
  | { ok: true; method: 'biometric' | 'device_passcode' | 'device_owner'; platform: 'ios' | 'android' }
  | { ok: false; reason: 'cancelled' | 'unavailable' | 'failed'; message: string };

interface DeviceOwnerAuthMessages {
  unavailable?: string;
  cancelled?: string;
  failed?: string;
}

const CANCEL_ERRORS = new Set(['user_cancel', 'system_cancel', 'app_cancel']);

export async function requestDeviceOwnerAuth(
  promptMessage: string,
  messages: DeviceOwnerAuthMessages = {},
): Promise<DeviceOwnerAuthResult> {
  const platform = Platform.OS === 'android' ? 'android' : 'ios';

  let level = LocalAuthentication.SecurityLevel.NONE;
  let types: LocalAuthentication.AuthenticationType[] = [];
  try {
    [level, types] = await Promise.all([
      LocalAuthentication.getEnrolledLevelAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Device authentication is unavailable on this device.',
    };
  }

  if (level === LocalAuthentication.SecurityLevel.NONE) {
    return {
      ok: false,
      reason: 'unavailable',
      message: messages.unavailable ?? 'Set up Face ID or a device passcode before permanently deleting files.',
    };
  }

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });

    if (!result.success) {
      if (CANCEL_ERRORS.has(result.error)) {
        return { ok: false, reason: 'cancelled', message: messages.cancelled ?? 'Authentication cancelled. Nothing was deleted.' };
      }
      return { ok: false, reason: 'failed', message: messages.failed ?? 'Authentication failed. Nothing was deleted.' };
    }
  } catch {
    return {
      ok: false,
      reason: 'failed',
      message: messages.failed ?? 'Could not complete device authentication. Nothing was deleted.',
    };
  }

  markUnlocked();

  const hasBiometric =
    level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG ||
    level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK ||
    types.length > 0;

  return {
    ok: true,
    method: hasBiometric ? 'biometric' : 'device_passcode',
    platform,
  };
}
