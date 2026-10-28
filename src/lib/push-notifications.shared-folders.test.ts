// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { expect, mock, test } from 'bun:test';
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo-device', () => ({})); mock.module('expo-notifications', () => ({}));
mock.module('expo-constants', () => ({ default: {} })); mock.module('expo-secure-store', () => ({}));
mock.module('./device-identity', () => ({ getDeviceId() {} }));
mock.module('./api', () => ({ registerDeviceToken() {}, unregisterDeviceToken() {} }));
const { handleNotificationTap } = await import('./push-notifications');
test('push_tap_routes_both_categories_to_the_activity_screen', () => {
  const calls: any[] = []; const navigation = { isReady: () => true, navigate: (...args) => calls.push(args) };
  for (const category of ['shared_folder_files_added', 'shared_folder_items_deleted']) {
    handleNotificationTap({ notification: { request: { content: { data: { category } } } } }, navigation);
  }
  expect(calls).toEqual([['SharedFolderActivity'], ['SharedFolderActivity']]);
});
test('a_push_waits_for_navigation_readiness', () => {
  let calls = 0; handleNotificationTap({ notification: { request: { content: { data: { category: 'shared_folder_files_added' } } } } }, { isReady: () => false, navigate: () => calls++ }); expect(calls).toBe(0);
});
