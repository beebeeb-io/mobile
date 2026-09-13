/**
 * tab-bar-inset — single source of truth for the floating GlassTabBar's own
 * height (task 1394).
 *
 * GlassTabBar became an absolute overlay in 1394 — previously it rendered IN
 * FLOW and react-navigation's `BottomTabView` reserved its height for every
 * tab screen automatically (a flex sibling with intrinsic height shrinks the
 * `flex: 1` screen container next to it). An absolutely-positioned sibling is
 * removed from that flex flow, so the screen container now expands to the
 * FULL height of the tab — every scrollable list, FAB, progress card and
 * bottom-pinned control has to reserve the bar's footprint itself or it
 * renders clipped behind the glass capsule.
 *
 * This collapses three different ad-hoc numbers that predate 1394:
 *   - PhotosScreen: `TAB_BAR_RESERVED = 96`
 *   - Files/Shared/Settings: `insets.bottom + 120`
 *   - The Files FAB: a bare `bottom: 16`, not insets-aware at all (it worked
 *     only because the screen's own bottom edge already excluded the bar)
 *
 * Geometry mirrors GlassTabBar.tsx's own layout exactly — read/change both
 * files together:
 *   - `paddingTop: 6` on the bar's outer row (`TAB_BAR_TOP_PADDING`)
 *   - the capsule's content height: 5pt track padding (top+bottom) + a 50pt
 *     item (7 top padding + 23 icon + 2 gap + ~13 label line + 5 bottom
 *     padding) = 60pt total (`TAB_BAR_CAPSULE_HEIGHT`). Canvas pt sizes are
 *     fixed, not Dynamic-Type-scaled, so this is a constant, not something
 *     that needs to be measured at runtime.
 *   - `paddingBottom: (insets.bottom || 12) + 22 - 12` — the bar's own
 *     safe-area clearance (`TAB_BAR_BOTTOM_OFFSET` = GlassTabBar's old local
 *     `BAR_BOTTOM`).
 * Cross-checked against on-device screenshots in docs/_qa-evidence/1394/.
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const TAB_BAR_TOP_PADDING = 6;
export const TAB_BAR_CAPSULE_HEIGHT = 60;
/** Mirrors GlassTabBar's own bottom-offset constant. Keep both in sync. */
export const TAB_BAR_BOTTOM_OFFSET = 22;
/** Small clearance so scrollable content doesn't touch the capsule's edge. */
const CONTENT_CLEARANCE = 12;

/** The bar's own bottom padding — GlassTabBar uses this directly. */
export function tabBarSafeAreaPadding(insetsBottom: number): number {
  return (insetsBottom || 12) + TAB_BAR_BOTTOM_OFFSET - 12;
}

/** The bar's total rendered height, from the screen's bottom edge up. */
export function tabBarTotalHeight(insetsBottom: number): number {
  return TAB_BAR_TOP_PADDING + TAB_BAR_CAPSULE_HEIGHT + tabBarSafeAreaPadding(insetsBottom);
}

/**
 * What every tab screen's scrollable content — and any bottom-pinned control
 * that isn't already `position: 'absolute'` relative to the bar itself, e.g.
 * a FAB, a Live-Activity-style progress card, a batch action bar — must
 * reserve at its own bottom edge so it never renders behind the overlaid
 * GlassTabBar.
 */
export function useTabBarBottomInset(): number {
  const insets = useSafeAreaInsets();
  return tabBarTotalHeight(insets.bottom) + CONTENT_CLEARANCE;
}
