/**
 * GlassSheet — the floating bottom sheet (task 1311).
 *
 * Radius 38 (`GLASS_RADII.sheet`), from the canvas share sheet: a sheet that
 * FLOATS inset from the screen edges rather than being pinned flush to the
 * bottom, which is why all four corners are rounded.
 */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassSurface } from './GlassSurface';
import { glassMaterial, type GlassRadiusName, type GlassScheme } from './glass-recipe';
import { useTheme } from '../../lib/theme-context';

export type GlassSheetProps = {
  scheme?: GlassScheme;
  radius?: number | GlassRadiusName;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Show the drag grabber at the top of the sheet. */
  grabber?: boolean;
  children?: React.ReactNode;
};

export function GlassSheet({
  scheme,
  radius = 'sheet',
  style,
  contentStyle,
  grabber = true,
  children,
}: GlassSheetProps) {
  const { resolved } = useTheme();
  const material = glassMaterial(scheme ?? resolved);

  return (
    <GlassSurface scheme={scheme} radius={radius} style={style} contentStyle={contentStyle}>
      {grabber ? (
        <View style={styles.grabberRow} pointerEvents="none">
          <View style={[styles.grabber, { backgroundColor: material.labelMuted }]} />
        </View>
      ) : null}
      {children}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  grabberRow: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  grabber: { width: 36, height: 5, borderRadius: 3, opacity: 0.5 },
});

export default GlassSheet;
