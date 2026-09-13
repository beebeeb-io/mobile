// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, it, mock } from 'bun:test';

// The module under test also exports the `useTabBarBottomInset` hook, which
// imports `useSafeAreaInsets` from 'react-native-safe-area-context' at module
// load time — that package pulls in RN's real Flow-typed source, which bun's
// test runner can't parse (same fix as useKeyboardLayoutAnimation.test.ts).
// Mock it so this file can import the two pure functions below directly.
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const {
  TAB_BAR_BOTTOM_OFFSET,
  TAB_BAR_CAPSULE_HEIGHT,
  TAB_BAR_TOP_PADDING,
  tabBarSafeAreaPadding,
  tabBarTotalHeight,
} = await import('./tab-bar-inset');

describe('tabBarSafeAreaPadding', () => {
  it('mirrors GlassTabBar.tsx own pre-1394 inline formula exactly', () => {
    // (insets.bottom || 12) + BAR_BOTTOM - 12, for a real home-indicator device
    expect(tabBarSafeAreaPadding(34)).toBe(34 + TAB_BAR_BOTTOM_OFFSET - 12);
    expect(tabBarSafeAreaPadding(34)).toBe(44);
  });

  it('falls back to 12 when insets.bottom is 0 (no home indicator)', () => {
    expect(tabBarSafeAreaPadding(0)).toBe(12 + TAB_BAR_BOTTOM_OFFSET - 12);
    expect(tabBarSafeAreaPadding(0)).toBe(TAB_BAR_BOTTOM_OFFSET);
  });
});

describe('tabBarTotalHeight', () => {
  it('adds the fixed top padding + capsule height to the safe-area padding', () => {
    expect(tabBarTotalHeight(34)).toBe(TAB_BAR_TOP_PADDING + TAB_BAR_CAPSULE_HEIGHT + 44);
    expect(tabBarTotalHeight(34)).toBe(110);
  });

  it('never returns less than the fixed geometry, even at insets.bottom = 0', () => {
    expect(tabBarTotalHeight(0)).toBe(TAB_BAR_TOP_PADDING + TAB_BAR_CAPSULE_HEIGHT + TAB_BAR_BOTTOM_OFFSET);
    expect(tabBarTotalHeight(0)).toBe(88);
  });
});
