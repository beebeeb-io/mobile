// @ts-nocheck
import { expect, mock, test } from 'bun:test';
let barHeight = 104;
const platform = { OS: 'android' };
mock.module('react-native', () => ({ Platform: platform }));
mock.module('react-native-bottom-tabs', () => ({ useBottomTabBarHeight: () => barHeight }));
const { useTabBarBottomInset } = await import('./tab-bar-inset');
test('Android scene already excludes the real bar and its system inset', () => {
  expect(useTabBarBottomInset()).toBe(12);
  barHeight = 128;
  expect(useTabBarBottomInset()).toBe(12);
});
test('iOS remains measured bar plus existing clearance', () => {
  platform.OS = 'ios';
  barHeight = 128;
  expect(useTabBarBottomInset()).toBe(140);
  barHeight = 83;
  expect(useTabBarBottomInset()).toBe(95);
});
