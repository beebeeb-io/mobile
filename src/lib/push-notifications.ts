/**
 * Push notification helpers — token registration, handler setup, and
 * deep-link routing on notification tap.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { NavigationContainerRef } from '@react-navigation/native';
import { registerDeviceToken, unregisterDeviceToken } from './api';

// ── Notification handler ──────────────────────────────────────────────────────

/**
 * Configure how notifications are displayed while the app is foregrounded.
 * Call once at app startup (before any navigation is mounted).
 */
export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

// ── Token registration ────────────────────────────────────────────────────────

/**
 * Request notification permission, obtain the Expo push token, and register
 * it with the Beebeeb server.
 *
 * Safe to call on every login — the server is idempotent on the token.
 * Silently no-ops on simulator (Device.isDevice === false).
 */
export async function registerForPushNotifications(): Promise<void> {
  // Skip in simulator / web — push tokens don't exist there.
  if (!Device.isDevice) return;

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let final = existing;

    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      final = status;
    }

    if (final !== 'granted') {
      // User declined — no token to register.
      return;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;

    const deviceId =
      Device.deviceName ?? Device.modelName ?? Device.osInternalBuildId ?? 'unknown';

    await registerDeviceToken({
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      device_id: deviceId,
    });
  } catch {
    // Non-fatal — app works fine without push tokens.
  }
}

/**
 * Unregister the push token on logout so the server stops sending
 * notifications to this device.
 */
export async function unregisterPushToken(): Promise<void> {
  try {
    await unregisterDeviceToken();
  } catch {
    // Non-fatal.
  }
}

// ── Deep-link routing on notification tap ─────────────────────────────────────

type NotificationCategory =
  | 'share_received'
  | 'storage_warning'
  | 'new_device_login'
  | 'backup_complete'
  | string;

/**
 * Navigate to the relevant screen when the user taps a notification.
 * Pass the `navigationRef` from the root navigator.
 */
export function handleNotificationTap(
  response: Notifications.NotificationResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigationRef: NavigationContainerRef<any>,
): void {
  if (!navigationRef.isReady()) return;

  const category: NotificationCategory =
    response.notification.request.content.data?.category as string ?? '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = navigationRef.navigate as any;

  switch (category) {
    case 'share_received':
      nav('Tabs', { screen: 'Shared' });
      break;

    case 'storage_warning':
      nav('Tabs', { screen: 'Settings' });
      break;

    case 'new_device_login':
      nav('Tabs', { screen: 'Settings' });
      break;

    case 'backup_complete':
      nav('Tabs', { screen: 'Photos' });
      break;

    default:
      // Unknown category — open app at default tab.
      break;
  }
}
