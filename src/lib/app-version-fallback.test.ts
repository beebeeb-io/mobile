// @ts-nocheck — isolated process with no installed native identity.
import { expect, mock, test } from 'bun:test';
const application = { nativeApplicationVersion: null, nativeBuildVersion: null };
const platform = { OS: 'android' };
const constants = { expoConfig: { version: '0.9.0', android: { versionCode: 1 }, ios: { buildNumber: '2' } } };
mock.module('expo-application', () => application);
mock.module('expo-constants', () => ({ default: constants }));
mock.module('react-native', () => ({ Platform: platform }));
const { appVersion } = await import('./app-version');
test('missing native values fall back to the matching platform config', () => {
  application.nativeApplicationVersion = null;
  application.nativeBuildVersion = null;
  platform.OS = 'android';
  expect(appVersion()).toEqual({ version: '0.9.0', build: '1' });
  platform.OS = 'ios';
  expect(appVersion()).toEqual({ version: '0.9.0', build: '2' });
});
test('absent config remains defined without making a native claim', () => {
  constants.expoConfig = null;
  expect(appVersion()).toEqual({ version: '1.0.0', build: '1' });
});
