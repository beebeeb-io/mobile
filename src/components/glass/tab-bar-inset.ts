/**
 * tab-bar-inset — single source of truth for the space every tab screen
 * must reserve at its own bottom edge so content/controls don't render
 * behind the tab bar (task 1394, rewritten for 1308a).
 *
 * 1394 introduced this file to compute `GlassTabBar`'s height by hand from
 * its own drawn geometry (padding, capsule dimensions, a Dynamic-Type
 * font-scaling cap) because that bar was a custom-drawn absolute overlay —
 * nothing else knew its real size. 1308a replaced `GlassTabBar` with the
 * SYSTEM tab bar via `createNativeBottomTabNavigator`
 * (`@bottom-tabs/react-navigation`), so that hand-computed geometry is gone
 * along with the component it described. The native bar's real height —
 * whatever iOS actually renders, including safe-area inset, Liquid Glass
 * sizing and Dynamic Type — is available directly as a LIVE measurement via
 * `useBottomTabBarHeight()` (`react-native-bottom-tabs`): traced to
 * `TabView.tsx`'s `handleTabBarMeasured`, fed by a real native
 * `onTabBarMeasured` event, not something to approximate ourselves.
 */
import { useBottomTabBarHeight } from 'react-native-bottom-tabs';

/** Small clearance so scrollable content doesn't touch the bar's edge. */
const CONTENT_CLEARANCE = 12;

/**
 * Pure half of `useTabBarBottomInset`, split out so it's unit-testable
 * without a React render context — `useBottomTabBarHeight()` reads a
 * context value via `useContext`, which (correctly) throws outside of one,
 * the same reason `useKeyboardLayoutAnimation.ts` keeps its own arithmetic
 * (`computeSearchStackBottomPadding`) as a separate plain export.
 */
export function addTabBarClearance(nativeBarHeight: number): number {
  return nativeBarHeight + CONTENT_CLEARANCE;
}

/**
 * What every tab screen's scrollable content — and any bottom-pinned control
 * that isn't already positioned relative to the bar itself, e.g. a FAB, a
 * Live-Activity-style progress card, a batch action bar — must reserve at
 * its own bottom edge so it never renders behind the native tab bar.
 */
export function useTabBarBottomInset(): number {
  return addTabBarClearance(useBottomTabBarHeight());
}
