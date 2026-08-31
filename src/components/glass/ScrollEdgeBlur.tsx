/**
 * ScrollEdgeBlur — progressive blur under the top chrome (task 1311).
 *
 * The canvas runs content edge-to-edge UNDERNEATH the title and chrome, and
 * keeps it readable with a strip that is fully blurred at the top and fades to
 * nothing part-way down (`.topfade`):
 *
 *   height: 128px;
 *   backdrop-filter: blur(18px) saturate(1.6);
 *   mask-image: linear-gradient(#000 0%, #000 52%, transparent 100%);
 *   background: rgba(12,12,13,0.30);
 *
 * React Native has no `mask-image`, so the fade is built rather than masked:
 * `SCROLL_EDGE.bands` blur layers are stacked top-anchored with decreasing
 * heights, so blur ACCUMULATES towards the top and thins out towards the
 * bottom. The tint is a matching stepped gradient. The seam between bands is
 * invisible because each layer's contribution is small and the blur of a blur
 * is still a blur — but this is an approximation of a mask, not a mask.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '../../lib/theme-context';
import { bandColors, formatRgba, parseColor } from './gradient';
import {
  SCROLL_EDGE,
  scrollEdgeBandHeights,
  scrollEdgeBandIntensity,
  type GlassScheme,
} from './glass-recipe';

/** Steps used for the tint fade. More than the blur bands: flat colour bands. */
const TINT_STEPS = 14;

export type ScrollEdgeBlurProps = {
  scheme?: GlassScheme;
  /** Strip height in points. Defaults to the canvas's 128. */
  height?: number;
  style?: StyleProp<ViewStyle>;
};

export function ScrollEdgeBlur({
  scheme,
  height = SCROLL_EDGE.height,
  style,
}: ScrollEdgeBlurProps) {
  const { resolved } = useTheme();
  const activeScheme = scheme ?? resolved;
  const tint = activeScheme === 'dark' ? SCROLL_EDGE.darkTint : SCROLL_EDGE.lightTint;

  const heights = useMemo(() => scrollEdgeBandHeights(height), [height]);
  const tintBands = useMemo(
    () =>
      bandColors(
        [
          { pos: 0, color: tint },
          { pos: SCROLL_EDGE.solidStop, color: tint },
          { pos: 1, color: formatRgba({ ...parseColor(tint), a: 0 }) },
        ],
        TINT_STEPS,
      ),
    [tint],
  );

  return (
    <View pointerEvents="none" style={[styles.root, { height }, style]}>
      {heights.map((bandHeight, i) => (
        <BlurView
          key={i}
          intensity={scrollEdgeBandIntensity(i, heights.length)}
          tint={activeScheme}
          style={[styles.band, { height: bandHeight }]}
          pointerEvents="none"
        />
      ))}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {tintBands.map((color, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: color }} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 },
  band: { position: 'absolute', top: 0, left: 0, right: 0 },
});

export default ScrollEdgeBlur;
