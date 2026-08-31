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

import React, { useMemo, useState } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '../../lib/theme-context';
import {
  bandColorsAcross,
  rotatedGradientGeometry,
  rotationForCssAngle,
  type Stop,
} from './gradient';
import {
  GLASS_RADII,
  glassMaterial,
  type GlassMaterial,
  type GlassRadiusName,
  type GlassScheme,
} from './glass-recipe';

/** Bands used to approximate the sheen. At alpha ≤ 0.10 banding is invisible. */
const SHEEN_BANDS = 20;

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
  // The overlay has to be measured: its correct size depends on the surface's
  // aspect ratio, and a percentage of one dimension does not cover a rotated
  // rectangle (see `rotatedGradientGeometry`).
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev && prev.w === width && prev.h === height ? prev : { w: width, h: height },
    );
  };

  const geometry = useMemo(
    () => (size ? rotatedGradientGeometry(size.w, size.h, material.sheenAngle) : null),
    [size, material.sheenAngle],
  );

  const colors = useMemo(
    () =>
      geometry
        ? bandColorsAcross(sheenStops(material), SHEEN_BANDS, geometry.size, geometry.extent)
        : [],
    [geometry, material],
  );

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {geometry ? (
        <View
          style={{
            position: 'absolute',
            left: geometry.left,
            top: geometry.top,
            width: geometry.size,
            height: geometry.size,
            transform: [{ rotate: rotationForCssAngle(material.sheenAngle) }],
          }}
        >
          {colors.map((color, i) => (
            <View key={i} style={{ flex: 1, backgroundColor: color }} />
          ))}
        </View>
      ) : null}
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
  /**
   * Style for the outer (shadow) wrapper — layout, position, size.
   *
   * Do NOT put `flexDirection` here. The wrapper's single child is the clipped
   * content box, so making the wrapper a row container sizes that child to its
   * content and the surface collapses to a sliver. Row/column layout for the
   * CONTENT goes in `contentStyle`.
   */
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

  // The specular rim sits just inside the structural outline, so the two read
  // as one edge rather than two stacked lines. In dark mode the outline is
  // zero-width, which puts the rim exactly where it has always been.
  const inset = material.rimOuterWidth;

  const inner = (
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
      {inset > 0 ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: r, borderWidth: inset, borderColor: material.rimOuter },
          ]}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: inset,
          left: inset,
          right: inset,
          bottom: inset,
          borderRadius: Math.max(0, r - inset),
          borderWidth: material.rimWidth,
          borderColor: material.rimSide,
          borderTopColor: material.rimTop,
          borderBottomColor: material.rimBottom,
        }}
      />
      {children}
    </View>
  );

  if (!elevated) {
    return <View style={[{ borderRadius: r }, style]}>{inner}</View>;
  }

  // A view carries only one shadow, so the wider ambient layer needs its own
  // wrapper: ambient outside, contact shadow inside. `style` stays on the
  // outermost view so callers keep controlling layout. Dark mode has no
  // ambient layer and renders exactly the single-wrapper tree it always did.
  if (material.ambientShadow) {
    return (
      <View style={[material.ambientShadow, { borderRadius: r }, style]}>
        <View style={[material.shadow, { borderRadius: r }]}>{inner}</View>
      </View>
    );
  }

  return <View style={[material.shadow, { borderRadius: r }, style]}>{inner}</View>;
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});

export default GlassSurface;
