// @ts-nocheck — native modules explicitly mocked for this isolated process.
import { expect, mock, test } from 'bun:test';
const application = { nativeApplicationVersion: '1.0.1', nativeBuildVersion: '8' };
const platform = { OS: 'android' };
const constants = { expoConfig: { version: '0.9.0', android: { versionCode: 1 }, ios: { buildNumber: '2' } } };
mock.module('expo-application', () => ({
  get nativeApplicationVersion() { return application.nativeApplicationVersion; },
  get nativeBuildVersion() { return application.nativeBuildVersion; },
}));
mock.module('expo-constants', () => ({ default: constants }));
mock.module('react-native', () => ({ Platform: platform }));
const { appVersion } = await import('./app-version');
test('installed Android version and build override stale embedded config', () => {
  expect(appVersion()).toEqual({ version: '1.0.1', build: '8' });
});
test('installed iOS version and build override stale embedded config', () => {
  platform.OS = 'ios';
  expect(appVersion()).toEqual({ version: '1.0.1', build: '8' });
});
