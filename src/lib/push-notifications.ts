/**
 * Push notification helpers — token registration, handler setup, and
 * deep-link routing on notification tap.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import type { NavigationContainerRef } from '@react-navigation/native';
import { registerDeviceToken, unregisterDeviceToken } from './api';

export const NOTIFICATIONS_OPT_OUT_KEY = 'beebeeb_notifications_opt_out';
const PUSH_DEVICE_ID_KEY = 'beebeeb_push_device_id';

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
async function getPushDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(PUSH_DEVICE_ID_KEY).catch(() => null);
  if (existing) return existing;
  const generated = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await SecureStore.setItemAsync(PUSH_DEVICE_ID_KEY, generated).catch(() => {});
  return generated;
}

function getProjectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export async function registerForPushNotifications(): Promise<void> {
  // Skip in simulator / web — push tokens don't exist there.
  if (!Device.isDevice) return;

  try {
    const optedOut = await SecureStore.getItemAsync(NOTIFICATIONS_OPT_OUT_KEY).catch(() => null);
    if (optedOut === 'true') return;

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

    const projectId = getProjectId();
    if (!projectId) return;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    const deviceId = await getPushDeviceId();

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
    const deviceId = await getPushDeviceId();
    await unregisterDeviceToken(deviceId);
  } catch {
    // Non-fatal.
  }
}

// ── Deep-link routing on notification tap ─────────────────────────────────────

type NotificationCategory =
  | 'file_updated'
  | 'share_received'
  | 'storage_warning'
  | 'new_device_login'
  | 'backup_complete'
  | 'backup_action_needed'
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
    case 'file_updated':
      nav('Tabs', { screen: 'Files' });
      break;

    case 'share_received':
      nav('Tabs', { screen: 'Shared' });
      break;

    case 'storage_warning':
      nav('Tabs', { screen: 'Settings' });
      break;

    case 'new_device_login':
      nav('Tabs', { screen: 'Settings' });
      break;

    case 'backup_action_needed':
      nav('Tabs', { screen: 'Settings' });
      break;

    case 'backup_complete':
      nav('Tabs', { screen: 'Settings' });
      break;

    default:
      // Unknown category — open app at default tab.
      break;
  }
}
