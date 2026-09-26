/**
 * PreviewBottomBar — the redesigned Preview screen's floating action bar
 * (task 1563 follow-up, "preview redesign", `design/preview-redesign-ios.html`
 * section 01, the `.bt` glass toolbar: Share / Save / Versions / Info).
 *
 * Replaces the two things it displaces: `DetailsSheet`'s always-visible
 * collapsed peek (the permanent bottom bar the redesign's "00 TODAY" section
 * flags — "Details ... takes permanent room at the bottom") and the ⋯ menu's
 * "Share Beebeeb Link" / "Save Original…" entries, which move up here as the
 * four actions people actually use (design: "The bottom bar holds the four
 * actions people actually use"). The ⋯ menu keeps everything else.
 *
 * Uses the SAME `GlassCapsule` control-layer primitive as the top title
 * pill and the header's round buttons (task 1311/1343/1344) rather than
 * inventing a new bar shape — one glass vocabulary for one screen's chrome.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassCapsule, type GlassScheme } from '../glass';

export interface PreviewBottomBarAction {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  disabled?: boolean;
  /** Amber-tinted icon+label, for a toggled-on state (design's `.bt i.on`
   * — not used by the base 4 actions today, kept for a future toggle). */
  active?: boolean;
  testID?: string;
}

interface PreviewBottomBarProps {
  scheme: GlassScheme;
  actions: PreviewBottomBarAction[];
  /** The caller (PreviewScreen) owns SCREEN positioning — this component's
   * own `bar` style is deliberately un-positioned (a normal in-flow row) so
   * a caller-supplied absolute wrapper (left/right/bottom + fade opacity)
   * fully determines where and whether it's visible, with no competing
   * position:absolute declaration here to leave top/bottom ambiguous. */
  style?: StyleProp<ViewStyle>;
}

export function PreviewBottomBar({ scheme, actions, style }: PreviewBottomBarProps) {
  const iconColor = scheme === 'dark' ? 'rgba(236,232,223,0.92)' : undefined;
  const labelColor = scheme === 'dark' ? 'rgba(207,201,190,0.92)' : undefined;

  return (
    <GlassCapsule scheme={scheme} style={[styles.bar, style]} contentStyle={styles.barContent}>
      {actions.map((action) => (
        <TouchableOpacity
          key={action.key}
          onPress={action.onPress}
          disabled={action.disabled}
          style={[styles.item, action.disabled && styles.itemDisabled]}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          testID={action.testID}
        >
          <Ionicons
            name={action.icon}
            size={22}
            color={action.active ? '#F5B800' : iconColor}
            style={!iconColor && !action.active ? styles.iconLight : undefined}
          />
          <Text
            style={[
              styles.label,
              action.active && styles.labelActive,
              labelColor ? { color: labelColor } : undefined,
            ]}
            numberOfLines={1}
          >
            {action.label}
          </Text>
        </TouchableOpacity>
      ))}
    </GlassCapsule>
  );
}

const styles = StyleSheet.create({
  bar: {
    marginHorizontal: 16,
  },
  barContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  item: {
    alignItems: 'center',
    gap: 3,
    minWidth: 56,
    paddingVertical: 2,
  },
  itemDisabled: {
    opacity: 0.4,
  },
  // GlassSurface's own scheme (light/dark/system) already tints icons in
  // `iconColor` for scheme='dark'; a light-scheme bar over unknown content
  // (rare — most callers pass 'dark', matching the media/doc grounds this
  // screen renders over) falls back to the theme's own ink token instead of
  // hardcoding a colour with no artboard to sample it from.
  iconLight: {},
  label: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  labelActive: {
    color: '#F5B800',
  },
});

export default PreviewBottomBar;
