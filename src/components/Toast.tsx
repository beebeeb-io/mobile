import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import type { ToastMessage, ToastType } from '../lib/toast-context';

// ---------------------------------------------------------------------------
// Config per toast type
// ---------------------------------------------------------------------------

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TYPE_CONFIG: Record<ToastType, { icon: IoniconName; getColor: (c: ReturnType<typeof useTheme>['colors']) => string }> = {
  success: { icon: 'checkmark-circle',   getColor: (c) => c.green },
  error:   { icon: 'close-circle',        getColor: (c) => c.red },
  info:    { icon: 'information-circle',  getColor: (c) => c.amber },
};

const DISMISS_AFTER_MS = 2500;
const SLIDE_IN_MS = 220;
const SLIDE_OUT_MS = 180;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  toast: ToastMessage;
  onDismiss: () => void;
}

export default function ToastOverlay({ toast, onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const translateY = useRef(new Animated.Value(-80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const cfg = TYPE_CONFIG[toast.type];
  const accentColor = cfg.getColor(c);

  useEffect(() => {
    // Slide in
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: SLIDE_IN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: SLIDE_IN_MS,
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-dismiss
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: -80,
          duration: SLIDE_OUT_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: SLIDE_OUT_MS,
          useNativeDriver: true,
        }),
      ]).start(() => onDismiss());
    }, DISMISS_AFTER_MS);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top: insets.top + 8,
          backgroundColor: c.paper,
          borderColor: c.line,
          transform: [{ translateY }],
          opacity,
          shadowColor: c.ink,
        },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${toast.type}: ${toast.message}`}
    >
      <Ionicons name={cfg.icon} size={20} color={accentColor} />
      <Text style={[styles.message, { color: c.ink }]} numberOfLines={2}>
        {toast.message}
      </Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
  },
  message: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 19,
  },
});
