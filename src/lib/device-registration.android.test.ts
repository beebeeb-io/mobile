// @ts-nocheck — isolated Bun process; every native dependency is mocked here.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const platform = { OS: 'android' };
const registered: unknown[] = [];
const persisted: unknown[] = [];
let tokenRequests = 0;

mock.module('react-native', () => ({ Platform: platform }));
mock.module('expo-device', () => ({ deviceName: 'Test device', modelName: 'Test model', isDevice: true }));
mock.module('expo-constants', () => ({
  default: { expoConfig: { version: '1.0.1', extra: { eas: { projectId: 'test-project' } } } },
}));
mock.module('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => null,
  setItem: async (...args: unknown[]) => { persisted.push(args); },
} }));
mock.module('./api', () => ({ registerClientDevice: async (params: unknown) => {
  registered.push(params);
  return { id: 'server-device-id' };
} }));
mock.module('expo-notifications', () => ({ getExpoPushTokenAsync: async () => {
  tokenRequests += 1;
  return { data: 'test-token' };
} }));

const { registerDevice } = await import('./device-registration');

beforeEach(() => {
  platform.OS = 'android';
  registered.length = 0;
  persisted.length = 0;
  tokenRequests = 0;
});

describe('Android device registration', () => {
  test('leaves Android token acquisition to the permission-aware push registration', async () => {
    expect(await registerDevice()).toBe('server-device-id');
    expect(tokenRequests).toBe(0);
    expect(registered).toEqual([{
      hostname: 'Test device', platform: 'android', bb_version: '1.0.1', push_token: undefined,
    }]);
  });

  test('still stores the server device ID for canonical push linkage', async () => {
    await registerDevice();
    expect(persisted).toEqual([['beebeeb_registered_device_id', 'server-device-id']]);
  });

  test('preserves the iOS device payload', async () => {
    platform.OS = 'ios';
    await registerDevice();
    expect(tokenRequests).toBe(1);
    expect(registered[0]).toEqual({
      hostname: 'Test device', platform: 'ios', bb_version: '1.0.1', push_token: 'test-token',
    });
  });
});
