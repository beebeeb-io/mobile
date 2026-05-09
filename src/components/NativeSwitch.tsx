import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { Colors } from '../theme';

type Props = {
  colors: Colors;
  value?: boolean;
  disabled?: boolean;
  onValueChange?: (value: boolean) => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

const TRACK_WIDTH = 51;
const TRACK_HEIGHT = 31;
const THUMB_SIZE = 27;
const THUMB_OFFSET = 2;
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - THUMB_OFFSET * 2;

export function NativeSwitch({
  colors,
  value = false,
  disabled = false,
  onValueChange,
  accessibilityLabel,
  style,
}: Props) {
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [progress, value]);

  const animatedStyles = useMemo(() => {
    const backgroundColor = progress.interpolate({
      inputRange: [0, 1],
      outputRange: ['#E9E9EA', colors.amber],
    });
    const translateX = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [0, THUMB_TRAVEL],
    });
    return { backgroundColor, thumbTransform: [{ translateX }] };
  }, [colors.amber, progress]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange?.(!value)}
      style={[styles.pressable, disabled && styles.disabled, style]}
    >
      <Animated.View style={[styles.track, { backgroundColor: animatedStyles.backgroundColor }]}>
        <Animated.View style={[styles.thumb, { transform: animatedStyles.thumbTransform }]} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
  },
  disabled: {
    opacity: 0.5,
  },
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    padding: THUMB_OFFSET,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 2.5,
    elevation: 2,
  },
});
