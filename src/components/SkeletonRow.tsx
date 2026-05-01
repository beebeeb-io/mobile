import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useTheme } from '../lib/theme-context';
import { radii, spacing } from '../theme';

const PULSE_MIN = 0.3;
const PULSE_MAX = 0.7;
const PULSE_DURATION_MS = 900;

export default function SkeletonRow() {
  const { colors: c } = useTheme();
  const opacity = useRef(new Animated.Value(PULSE_MIN)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: PULSE_MAX,
          duration: PULSE_DURATION_MS,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: PULSE_MIN,
          duration: PULSE_DURATION_MS,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  const bg = c.line;

  return (
    <Animated.View style={[styles.row, { borderBottomColor: c.line, opacity }]}>
      {/* File icon placeholder */}
      <View style={[styles.icon, { backgroundColor: bg, borderRadius: radii.sm }]} />

      {/* Text lines */}
      <View style={styles.lines}>
        <View style={[styles.nameLine, { backgroundColor: bg }]} />
        <View style={[styles.metaLine, { backgroundColor: bg }]} />
      </View>

      {/* Chevron placeholder */}
      <View style={[styles.chevron, { backgroundColor: bg }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    gap: 12,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
  },
  lines: {
    flex: 1,
    gap: 7,
  },
  nameLine: {
    height: 13,
    borderRadius: 4,
    width: '65%',
  },
  metaLine: {
    height: 10,
    borderRadius: 4,
    width: '40%',
  },
  chevron: {
    width: 8,
    height: 14,
    borderRadius: 3,
  },
});
