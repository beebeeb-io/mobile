/**
 * GlassSurface — the base every glass primitive renders through (task 1311).
 *
 * Layer order, bottom to top, matching the canvas `.lg` rule:
 *   1. BlurView            — backdrop-filter: blur(…)
 *   2. fill                — background: rgba(44,44,50,0.46)
 *   3. sheen               — .lg::after, the 118deg specular sweep
 *   4. rim                 — the inset 1px highlight that sells it as glass
 *   5. children
 * with the drop shadow on an outer, unclipped wrapper.
 *
 * Two RN limitations are handled here rather than in every primitive:
 *
 * · No `inset` box-shadow. The rim is a real hairline border with per-side
 *   colours. RN cannot vary border WIDTH per side once a border radius is
 *   present, so the canvas's 0.75px top rim renders at the same 0.5px as the
 *   sides. At 3× that is 1.5 physical pixels instead of 2.25 — the highlight
 *   is marginally finer than the artboard, and it is the one place the rim
 *   deviates. `rimTopWidth` stays in the recipe as the canvas's stated value.
 *
 * · A shadow cannot live on the same view that clips its children, so the
 *   shadow sits on an outer wrapper and the blur stack on an inner clipper.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '../../lib/theme-context';
import { bandColors, rotationForCssAngle, type Stop } from './gradient';
import {
  GLASS_RADII,
  glassMaterial,
  type GlassMaterial,
  type GlassRadiusName,
  type GlassScheme,
} from './glass-recipe';

/** Bands used to approximate the sheen. At alpha ≤ 0.10 banding is invisible. */
const SHEEN_BANDS = 14;

/** Resolve a radius name or a raw point value. */
export function resolveRadius(radius: number | GlassRadiusName): number {
  return typeof radius === 'number' ? radius : GLASS_RADII[radius];
}

/** The canvas sheen stops: 0% / 34% / 58%. */
function sheenStops(material: GlassMaterial): Stop[] {
  return [
    { pos: 0, color: material.sheen[0] },
    { pos: 0.34, color: material.sheen[1] },
    { pos: 0.58, color: material.sheen[2] },
  ];
}

function Sheen({ material }: { material: GlassMaterial }) {
  const colors = useMemo(() => bandColors(sheenStops(material), SHEEN_BANDS), [material]);
  const rotate = rotationForCssAngle(material.sheenAngle);

  // The band stack is oversized to 300% and centred so that, once rotated, it
  // still covers every corner of the surface whatever its aspect ratio.
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={{
          position: 'absolute',
          left: '-100%',
          top: '-100%',
          width: '300%',
          height: '300%',
          transform: [{ rotate }],
        }}
      >
        {colors.map((color, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: color }} />
        ))}
      </View>
    </View>
  );
}

export type GlassSurfaceProps = {
  /**
   * Colour scheme for the material. Defaults to the app's resolved theme —
   * pass it explicitly only to render both schemes at once (the dev gallery).
   */
  scheme?: GlassScheme;
  /** A concentric radius name from the canvas, or a raw point value. */
  radius?: number | GlassRadiusName;
  /** Style for the outer (shadow) wrapper — layout, position, size. */
  style?: StyleProp<ViewStyle>;
  /** Style for the inner (clipped) content box — padding, flex direction. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Drop the shadow, for glass that sits flush rather than floating. */
  elevated?: boolean;
  children?: React.ReactNode;
};

export function GlassSurface({
  scheme,
  radius = 'capsule',
  style,
  contentStyle,
  elevated = true,
  children,
}: GlassSurfaceProps) {
  const { resolved } = useTheme();
  const activeScheme = scheme ?? resolved;
  const material = glassMaterial(activeScheme);
  const r = resolveRadius(radius);

  return (
    <View style={[elevated ? material.shadow : null, { borderRadius: r }, style]}>
      <View style={[styles.clip, { borderRadius: r }, contentStyle]}>
        <BlurView
          intensity={material.blurIntensity}
          tint={material.tint}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: material.fill }]}
        />
        <Sheen material={material} />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: r,
              borderWidth: material.rimWidth,
              borderColor: material.rimSide,
              borderTopColor: material.rimTop,
              borderBottomColor: material.rimBottom,
            },
          ]}
        />
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});

export default GlassSurface;
