/**
 * GlassTabBar — the iOS 26 floating tab bar (task 1312).
 *
 * Replaces the stock opaque bottom bar with the canvas layout: a glass
 * CAPSULE holding the four tabs, the active one lifted into its own brighter
 * bubble, and search pulled out into a SEPARATE round glass button beside it.
 *
 * Geometry lifted from `design/ios26-canvas/ios26.py` (`tabbar()`):
 *
 *   container   left/right 18, bottom 22, gap 12
 *   capsule     border-radius 999, padding 5, item gap 2
 *   item        flex 1, radius 999, padding 7px 0 5px, icon 23, label 10px
 *   active      label + icon AMBER at weight 600, item wearing `.bubble`
 *   inactive    weight 500
 *   search      56x56 glass circle, icon 22
 *
 * ── Why a custom `tabBar` is a testID hazard ──────────────────────────────
 * With a custom bar, react-navigation stops rendering the buttons, so NOTHING
 * applies `tabBarButtonTestID` or `tabBarBadge` for us — they are just entries
 * in `descriptors[key].options` that a custom bar has to honour by hand. Miss
 * one and Maestro stops finding the tab, which fails silently as "element not
 * found" rather than as a build error. Both are wired through explicitly
 * below, and there is a Maestro tab-switch run in the task's evidence proving
 * all four still resolve.
 *
 * The bar renders IN FLOW rather than absolutely positioned, so the navigator
 * still reserves its height. PhotosScreen and SharedScreen only set
 * `contentContainerStyle` when their lists are EMPTY, so an absolute bar would
 * hide their last row — and restyling their lists belongs to 1313–1315. The
 * capsule still floats visually inside its reserved band; what it gives up is
 * list rows showing through the glass, which the canvas does have.
 */

import React from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassCapsule, GlassCircle, GLASS_CIRCLE_SIZES, glassMaterial } from './glass';
import { useTheme } from '../lib/theme-context';
import { colors } from '../theme';

/** Canvas: the bar sits 22pt above the bottom edge, inset 18pt either side. */
const BAR_INSET_X = 18;
const BAR_BOTTOM = 22;
const BAR_GAP = 12;

export function GlassTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { resolved } = useTheme();
  const material = glassMaterial(resolved);

  // 1357 — Guus's layout ruling: while Files search is active, the bottom
  // search bar REPLACES this bar in its own footprint rather than floating
  // above it, so this bar must not render at all (not just be covered) —
  // its space has to be reclaimed by the screen for the search bar to
  // "fill the menu bar at the bottom completely" (Guus, verbatim). A custom
  // `tabBar` render prop (this whole component) means react-navigation does
  // NOT interpret `tabBarStyle` for us the way its default bar would — see
  // this file's own doc comment above on `tabBarButtonTestID`/badges being
  // the same story — so `navigation.setOptions({ tabBarStyle: { display:
  // 'none' } })` (FilesScreen.tsx) only does anything because this checks
  // for it by hand, against the FOCUSED route's own options.
  const focusedOptions = descriptors[state.routes[state.index].key].options;
  // `tabBarStyle`'s declared type allows an Animated value, which is never
  // actually passed here (FilesScreen.tsx only ever sets a plain
  // `{ display: 'none' }` object) — narrowed for the one field this reads.
  const focusedBarStyle = StyleSheet.flatten(focusedOptions.tabBarStyle) as ViewStyle | undefined;
  if (focusedBarStyle?.display === 'none') {
    return null;
  }

  const openSearch = () => {
    // Same contract the beebeeb://search shortcut uses: Files reads the param
    // and clears it, so re-tapping search re-focuses the bar. The tab
    // navigator's navigate() is not statically typed from inside a tabBar, so
    // this takes the same permissive escape hatch App.tsx uses for deep links.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigation.navigate as any)('Files', { action: 'search' });
  };

  return (
    <View
      style={[
        styles.bar,
        {
          paddingLeft: BAR_INSET_X,
          paddingRight: BAR_INSET_X,
          paddingBottom: (insets.bottom || 12) + BAR_BOTTOM - 12,
          paddingTop: 6,
        },
      ]}
      pointerEvents="box-none"
    >
      <GlassCapsule scheme={resolved} style={styles.capsule} contentStyle={styles.track}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const focused = state.index === index;

          const activeColor = options.tabBarActiveTintColor ?? colors.amber;
          // The stock inactive tint (ink4) was picked for an OPAQUE bar and is
          // too dark to read on glass; labelMuted is the on-glass ink.
          const inactiveColor = material.labelMuted;
          const tint = focused ? activeColor : inactiveColor;

          const label =
            typeof options.tabBarLabel === 'string'
              ? options.tabBarLabel
              : (options.title ?? route.name);

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (navigation.navigate as any)(route.name, route.params);
            }
          };

          const onLongPress = () => {
            navigation.emit({ type: 'tabLongPress', target: route.key });
          };

          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? String(label)}
              // Preserved verbatim from the stock bar — Maestro depends on these.
              testID={options.tabBarButtonTestID}
              onPress={onPress}
              onLongPress={onLongPress}
              activeOpacity={0.75}
              style={[
                styles.item,
                focused
                  ? [material.bubbleShadow, { backgroundColor: material.bubbleFill }]
                  : null,
              ]}
            >
              <View>
                {options.tabBarIcon?.({ focused, color: tint, size: 23 })}
                <TabBadge badge={options.tabBarBadge} badgeStyle={options.tabBarBadgeStyle} />
              </View>
              <Text
                numberOfLines={1}
                style={[styles.label, { color: tint, fontWeight: focused ? '600' : '500' }]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </GlassCapsule>

      <GlassCircle
        scheme={resolved}
        size={GLASS_CIRCLE_SIZES.search}
        style={{ marginLeft: BAR_GAP }}
      >
        <TouchableOpacity
          onPress={openSearch}
          accessibilityRole="button"
          accessibilityLabel="Search"
          testID="tab-search"
          style={styles.searchHit}
          activeOpacity={0.75}
        >
          {SEARCH_ICON(material.label)}
        </TouchableOpacity>
      </GlassCircle>
    </View>
  );
}

/**
 * The stock bar's badge, reproduced.
 *
 * `tabBarBadgeStyle` is a TextStyle carrying BOTH the pill's box (background,
 * minWidth, maxHeight, radius) and its glyph (fontSize, color), so it has to
 * be split across the two views. App.tsx uses ' ' with fontSize 1 to mean a
 * bare dot and '!' at fontSize 9 for the storage warning; both fall out of
 * this without special-casing.
 */
function TabBadge({
  badge,
  badgeStyle,
}: {
  badge?: number | string;
  badgeStyle?: StyleProp<TextStyle>;
}) {
  if (badge === undefined || badge === null) return null;
  const s = (StyleSheet.flatten(badgeStyle) ?? {}) as TextStyle;

  // The box needs an EXPLICIT height. App.tsx draws its dot as a blank ' ' at
  // fontSize 1 capped by maxHeight, which is the stock badge's idiom — but the
  // stock badge also fixes its own size. Letting a 1pt glyph drive the height
  // collapses the dot into a 2pt red BAR (caught on the simulator, not by any
  // test). So: height comes from the caller's maxHeight when it set one, else
  // from the font size, and never from the content.
  const fontSize = s.fontSize ?? 10;
  const height = (s.maxHeight as number | undefined) ?? fontSize + 5;
  const minWidth = (s.minWidth as number | undefined) ?? 16;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.badge,
        {
          backgroundColor: (s.backgroundColor as string) ?? colors.red,
          height,
          minWidth,
          borderRadius: (s.borderRadius as number) ?? height / 2,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.badgeText, { fontSize, color: (s.color as string) ?? colors.white }]}
      >
        {String(badge)}
      </Text>
    </View>
  );
}

/** Canvas search glyph, drawn with the Feather-style stroke the app uses. */
const SEARCH_ICON = (color: string) => (
  <View style={styles.searchGlyph}>
    <View style={[styles.searchRing, { borderColor: color }]} />
    <View style={[styles.searchTail, { backgroundColor: color }]} />
  </View>
);

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center' },
  capsule: { flex: 1 },
  track: { flexDirection: 'row', padding: 5, gap: 2 },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingTop: 7,
    paddingBottom: 5,
    borderRadius: 999,
  },
  label: {
    fontSize: 10,
    // The canvas sets no tracking here; keep the platform default.
    ...Platform.select({ ios: {}, default: {} }),
  },
  badge: {
    position: 'absolute',
    top: -3,
    left: 14,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontWeight: '700', textAlign: 'center' },
  searchHit: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  searchGlyph: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  searchRing: { width: 15, height: 15, borderRadius: 8, borderWidth: 2, marginTop: -2, marginLeft: -2 },
  searchTail: {
    position: 'absolute',
    width: 2,
    height: 7,
    borderRadius: 1,
    right: 3,
    bottom: 2,
    transform: [{ rotate: '-45deg' }],
  },
});

export default GlassTabBar;
