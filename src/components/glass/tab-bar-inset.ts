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
import { Platform } from 'react-native';
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
 * Bottom-anchored chrome in either coordinate space. Android tab scenes
 * already exclude the tab bar AND system navigation area: pass 0 there.
 * Full-window surfaces pass their live safe-area bottom instead. Keep the
 * background flush; apply this to content padding or the control's anchor.
 * iOS retains the caller's existing geometry exactly.
 */
export function bottomAnchorInset(remainingSafeBottom: number, iosInset: number): number {
  return Platform.OS === 'android'
    ? Math.max(remainingSafeBottom, CONTENT_CLEARANCE)
    : iosInset;
}

/**
 * What every tab screen's scrollable content — and any bottom-pinned control
 * that isn't already positioned relative to the bar itself, e.g. a FAB, a
 * Live-Activity-style progress card, a batch action bar — must reserve at
 * its own bottom edge so it never renders behind the native tab bar.
 */
export function useTabBarBottomInset(): number {
  const nativeBarHeight = useBottomTabBarHeight();
  // Android lays the scene and bar out as vertical siblings. Its measured
  // scene already excludes the complete bar, including the system inset.
  // iOS overlays the bar on the scene and still needs its full height.
  return bottomAnchorInset(0, addTabBarClearance(nativeBarHeight));
}
