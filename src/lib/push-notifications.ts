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
import { getDeviceId } from './device-identity';

export const NOTIFICATIONS_OPT_OUT_KEY = 'beebeeb_notifications_opt_out';
/** Legacy per-store push id (task 0863): replaced by the canonical device id.
 *  Retained only so the one-time migration can find + clean up a stale server
 *  token row registered under the old value. */
const PUSH_DEVICE_ID_KEY = 'beebeeb_push_device_id';
/** Set once the old-id → canonical-id push migration has run (idempotency). */
const PUSH_ID_MIGRATED_KEY = 'beebeeb_push_device_id_migrated_v1';

// ── Notification handler ──────────────────────────────────────────────────────

/**
 * Configure how notifications are displayed while the app is foregrounded.
 * Call once at app startup (before any navigation is mounted).
 */
export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

// ── Token registration ────────────────────────────────────────────────────────

/**
 * The push-token id is now the canonical device id (task 0863) — one device,
 * one id everywhere.
 *
 * One-time migration: an existing install may have a token registered under the
 * old per-store `beebeeb_push_device_id`. The server keys register/unregister by
 * `device_id`, so we unregister that stale row once (idempotent, gated by
 * PUSH_ID_MIGRATED_KEY) before returning the canonical id; the caller then
 * re-registers the live token under the canonical id via registerDeviceToken.
 */
async function getPushDeviceId(): Promise<string> {
  const canonical = await getDeviceId();
  await migrateLegacyPushId(canonical);
  return canonical;
}

/** Unregister a stale push-token row registered under the legacy per-store id,
 *  so the server doesn't keep a duplicate registration for this device after we
 *  re-register the token under the canonical id. Runs at most once. */
async function migrateLegacyPushId(canonicalId: string): Promise<void> {
  try {
    const done = await SecureStore.getItemAsync(PUSH_ID_MIGRATED_KEY).catch(() => null);
    if (done === 'true') return;

    const legacy = await SecureStore.getItemAsync(PUSH_DEVICE_ID_KEY).catch(() => null);
    if (legacy && legacy !== canonicalId) {
      // Best-effort: clear the old server-side token row. If it fails (offline,
      // already gone), the migration flag is NOT set so it retries next launch.
      await unregisterDeviceToken(legacy);
    }
    // Mark done (covers both "had a stale legacy id, cleaned it" and "fresh
    // install / legacy already equals canonical" — nothing more to do).
    await SecureStore.setItemAsync(PUSH_ID_MIGRATED_KEY, 'true').catch(() => {});
  } catch {
    // Never let migration break push registration — retried next launch.
  }
}

function getProjectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/**
 * Request notification permission, obtain the Expo push token, and register
 * it with the Beebeeb server.
 *
 * Safe to call on every login — the server is idempotent on the token.
 * Silently no-ops on simulator (Device.isDevice === false).
 */
export async function registerForPushNotifications(
  /** Canonical client_devices UUID from registerDevice(), if available.
   * When provided, the server links the push token to the device row so
   * "forget device" cascades it and per-device mute works.
   * Field is optional server-side — registration proceeds without it. */
  clientDeviceId?: string | null,
): Promise<void> {
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
      ...(clientDeviceId ? { client_device_id: clientDeviceId } : {}),
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
