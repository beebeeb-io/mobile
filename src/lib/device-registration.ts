/**
 * Device registration — registers this mobile device with the Beebeeb
 * clients API on every successful login/startup.
 *
 * The server upserts on (user_id, hostname, platform) so repeated calls
 * are cheap and keep `last_seen` + `bb_version` fresh.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerClientDevice } from './api';

let Device: {
  deviceName: string | null;
  modelName: string | null;
  isDevice: boolean;
} = {
  deviceName: null,
  modelName: null,
  isDevice: false,
};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Device = require('expo-device');
} catch {
  // expo-device unavailable in Expo Go — use defaults
}

const REGISTERED_DEVICE_ID_KEY = 'beebeeb_registered_device_id';

/** Get the stored device ID from the last successful registration. */
export async function getRegisteredDeviceId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(REGISTERED_DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * Register this device with the server.
 *
 * Safe to call on every startup — the server upserts. The returned
 * device_id is persisted in AsyncStorage for session creation.
 *
 * Silently no-ops if registration fails (network down, server not
 * upgraded yet, etc.) — the device just won't appear in the dashboard
 * until the next successful call.
 */
export async function registerDevice(): Promise<string | null> {
  try {
    const hostname =
      Device.deviceName?.trim() ||
      Device.modelName?.trim() ||
      (Platform.OS === 'ios' ? 'iPhone' : 'Android');

    const platform = Platform.OS === 'ios' ? 'ios' : 'android';
    const bbVersion = Constants.expoConfig?.version ?? '1.0.0';

    // Try to get the Expo push token for the push_token field.
    // We import lazily because expo-notifications may not be available.
    let pushToken: string | undefined;
    try {
      const Notifications = require('expo-notifications') as {
        getExpoPushTokenAsync: (opts: { projectId: string }) => Promise<{ data: string }>;
      };
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
      if (projectId && Device.isDevice) {
        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        pushToken = tokenData.data;
      }
    } catch {
      // Push token unavailable — register without it
    }

    const device = await registerClientDevice({
      hostname,
      platform,
      bb_version: bbVersion,
      push_token: pushToken,
    });

    if (device?.id) {
      await AsyncStorage.setItem(REGISTERED_DEVICE_ID_KEY, device.id).catch(() => {});
      return device.id;
    }

    return null;
  } catch (err) {
    // Registration is best-effort — a 404 means the server hasn't been
    // upgraded with the clients API yet. Silently skip.
    if (__DEV__) {
      console.warn('[DeviceRegistration] failed:', err);
    }
    return null;
  }
}
