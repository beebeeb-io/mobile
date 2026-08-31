/**
 * GlassSegment — the iOS 26 segmented control (task 1311).
 *
 * A glass capsule whose ACTIVE item sits in its own brighter bubble, rather
 * than the flat sliding pill of the older iOS control. Values are the canvas
 * Shared-screen segment verbatim:
 *
 *   container  border-radius: 999px; padding: 4px;
 *   item       flex: 1; text-align: center; padding: 8px 0; border-radius: 999px;
 *   active     font-size: 14px; font-weight: 600; color: #F2F1EE;  (+ .bubble)
 *   inactive   font-size: 14px; font-weight: 500; color: rgba(240,238,233,0.62);
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassSurface } from './GlassSurface';
import { GLASS_RADII, glassMaterial, type GlassScheme } from './glass-recipe';
import { useTheme } from '../../lib/theme-context';

export type GlassSegmentOption<T extends string> = {
  value: T;
  label: string;
};

export type GlassSegmentProps<T extends string> = {
  options: readonly GlassSegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  scheme?: GlassScheme;
  style?: StyleProp<ViewStyle>;
  /** Accessibility label for the whole control. */
  accessibilityLabel?: string;
};

export function GlassSegment<T extends string>({
  options,
  value,
  onChange,
  scheme,
  style,
  accessibilityLabel,
}: GlassSegmentProps<T>) {
  const { resolved } = useTheme();
  const material = glassMaterial(scheme ?? resolved);

  return (
    <GlassSurface
      scheme={scheme}
      radius="capsule"
      style={style}
      contentStyle={styles.track}
    >
      <View style={styles.row} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.item,
                selected
                  ? [
                      material.bubbleShadow,
                      {
                        backgroundColor: material.bubbleFill,
                        borderTopColor: material.bubbleRim,
                      },
                    ]
                  : null,
              ]}
              onPress={() => onChange(option.value)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  {
                    color: selected ? material.label : material.labelMuted,
                    fontWeight: selected ? '600' : '500',
                  },
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  track: { padding: 4 },
  row: { flexDirection: 'row' },
  item: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: GLASS_RADII.capsule,
    // The active bubble's specular rim; transparent on inactive items.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  label: { fontSize: 14, letterSpacing: -0.1 },
});

export default GlassSegment;
