// @ts-nocheck — this file runs in its own Bun process, per the mobile test contract.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const calls: string[] = [];
const platform = { OS: 'android' };
const constants = { expoConfig: { extra: { eas: { projectId: 'test-project' } } } };
let optedOut = false;
let permission = 'undetermined';
let requestedPermission = 'granted';
let channelFails = false;

mock.module('react-native', () => ({ Platform: platform }));
mock.module('expo-device', () => ({ isDevice: true }));
mock.module('expo-constants', () => ({ default: constants }));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => key === 'beebeeb_notifications_opt_out'
    ? (optedOut ? 'true' : null) : 'true',
  setItemAsync: async () => {},
}));
mock.module('./device-identity', () => ({ getDeviceId: async () => 'test-device' }));
mock.module('./api', () => ({
  registerDeviceToken: async () => { calls.push('register'); },
  unregisterDeviceToken: async () => {},
}));
mock.module('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: async (id: string, config: unknown) => {
    calls.push('channel');
    expect(id).toBe('default');
    expect(config).toEqual({ name: 'Beebeeb', importance: 3 });
    if (channelFails) throw new Error('channel unavailable');
  },
  getPermissionsAsync: async () => { calls.push('permissions'); return { status: permission }; },
  requestPermissionsAsync: async () => {
    calls.push('request');
    return { status: requestedPermission };
  },
  getExpoPushTokenAsync: async () => { calls.push('token'); return { data: 'test-token' }; },
}));

const { registerForPushNotifications } = await import('./push-notifications');

beforeEach(() => {
  calls.length = 0;
  platform.OS = 'android';
  mock.module('expo-device', () => ({ isDevice: true }));
  optedOut = false;
  permission = 'undetermined';
  requestedPermission = 'granted';
  channelFails = false;
});

describe('Android push notification registration', () => {
  test('prebuild assigns server pushes to the channel created by the app', () => {
    const config = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8'));
    expect(config.expo.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-notifications'))
      .toEqual(['expo-notifications', { defaultChannel: 'default' }]);
  });

  test('the checked-in Android project uses the same default channel', () => {
    const manifest = readFileSync(new URL('../../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
    expect(manifest).toMatch(/<meta-data\s+android:name="com\.google\.firebase\.messaging\.default_notification_channel_id"\s+android:value="default"\s*\/>/);
  });

  test('creates the default channel before permission and token requests', async () => {
    await registerForPushNotifications();
    expect(calls).toEqual(['channel', 'permissions', 'request', 'token', 'register']);
  });

  test('rechecks the channel when permission was already granted', async () => {
    permission = 'granted';
    await registerForPushNotifications();
    expect(calls).toEqual(['channel', 'permissions', 'token', 'register']);
  });

  test('does not create an Android channel on iOS', async () => {
    platform.OS = 'ios';
    await registerForPushNotifications();
    expect(calls).toEqual(['permissions', 'request', 'token', 'register']);
  });

  test('honours opt-out before creating a channel or prompting', async () => {
    optedOut = true;
    await registerForPushNotifications();
    expect(calls).toEqual([]);
  });

  test('does nothing on a simulator', async () => {
    mock.module('expo-device', () => ({ isDevice: false }));
    await registerForPushNotifications();
    expect(calls).toEqual([]);
  });

  test('does not register a token after permission is denied', async () => {
    requestedPermission = 'denied';
    await registerForPushNotifications();
    expect(calls).toEqual(['channel', 'permissions', 'request']);
  });

  test('a channel failure is non-fatal and does not attempt registration', async () => {
    channelFails = true;
    await expect(registerForPushNotifications()).resolves.toBeUndefined();
    expect(calls).toEqual(['channel']);
  });
});
