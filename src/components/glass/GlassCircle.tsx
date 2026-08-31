/**
 * GlassCircle — the round floating control (task 1311).
 *
 * The canvas uses two sizes: 42 for a top-chrome action (the amber `+` on
 * Drive) and 56 for the standalone search button beside the tab bar.
 */

import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { GlassSurface } from './GlassSurface';
import { type GlassScheme } from './glass-recipe';

/** The two circle sizes the canvas uses. */
export const GLASS_CIRCLE_SIZES = { action: 42, search: 56 } as const;

export type GlassCircleProps = {
  scheme?: GlassScheme;
  /** Diameter in points. Defaults to the canvas's 42pt chrome action. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
  children?: React.ReactNode;
};

export function GlassCircle({
  scheme,
  size = GLASS_CIRCLE_SIZES.action,
  style,
  elevated = true,
  children,
}: GlassCircleProps) {
  return (
    <GlassSurface
      scheme={scheme}
      radius={size / 2}
      style={[{ width: size, height: size }, style]}
      contentStyle={[styles.center, { width: size, height: size }]}
      elevated={elevated}
    >
      {children}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default GlassCircle;
