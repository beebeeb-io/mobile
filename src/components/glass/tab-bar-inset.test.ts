// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, it, mock } from 'bun:test';

// 1308a rewrite: the geometry this file used to compute by hand (for the
// now-deleted GlassTabBar) is gone — `useTabBarBottomInset` just adds a
// small clearance on top of the native bar's own measured height.
// `addTabBarClearance` itself is pure and never calls the native hook, but
// the MODULE still has a top-level `import { useBottomTabBarHeight } from
// 'react-native-bottom-tabs'` that runs on load regardless of which export
// a test actually calls — that package pulls in RN's real Flow-typed
// source, which bun's test runner can't parse (same fix as
// useKeyboardLayoutAnimation.test.ts / the pre-1308a version of this file).
mock.module('react-native-bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

const { addTabBarClearance } = await import('./tab-bar-inset');

describe('addTabBarClearance', () => {
  it('adds the fixed content clearance on top of the measured native bar height', () => {
    expect(addTabBarClearance(83)).toBe(95);
    expect(addTabBarClearance(49)).toBe(61);
  });

  it('still adds clearance at zero bar height (e.g. a mid-measurement frame)', () => {
    expect(addTabBarClearance(0)).toBe(12);
  });
});
