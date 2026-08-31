/**
 * GlassCapsule — the pill-shaped floating control (task 1311).
 *
 * The canvas's tab bar, filter pills and Live-Activity-style upload card are
 * all this shape. Radius 999 (`GLASS_RADII.capsule`); the canvas tab bar wraps
 * its items in 5px of padding, a filter pill in 4px.
 */

import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import { GlassSurface } from './GlassSurface';
import { type GlassRadiusName, type GlassScheme } from './glass-recipe';

export type GlassCapsuleProps = {
  scheme?: GlassScheme;
  /** Defaults to the full capsule radius; override for a softer pill. */
  radius?: number | GlassRadiusName;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  elevated?: boolean;
  children?: React.ReactNode;
};

export function GlassCapsule({
  scheme,
  radius = 'capsule',
  style,
  contentStyle,
  elevated = true,
  children,
}: GlassCapsuleProps) {
  return (
    <GlassSurface
      scheme={scheme}
      radius={radius}
      style={style}
      contentStyle={contentStyle}
      elevated={elevated}
    >
      {children}
    </GlassSurface>
  );
}

export default GlassCapsule;
