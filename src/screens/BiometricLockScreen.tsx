import { BBLogo } from "../components/BBLogo";
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { requestConfirmation } from '../lib/confirm-action';
import { markUnlocked } from '../lib/lock-state';

interface Props {
  onUnlocked: () => void;
}

function FaceIdIcon() {
  return (
    <View style={styles.svgContainer}>
      {/* Outer circle */}
      <View style={styles.faceCircle}>
        {/* Eyes */}
        <View style={styles.eyes}>
          <View style={styles.eye} />
          <View style={styles.eye} />
        </View>
        {/* Smile arc — approximated with a border */}
        <View style={styles.smile} />
      </View>
    </View>
  );
}

export default function BiometricLockScreen({ onUnlocked }: Props) {
  const insets = useSafeAreaInsets();
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authenticate = useCallback(async () => {
    setError(null);
    setAuthenticating(true);
    try {
      // disableDeviceFallback: true keeps iOS from offering the device passcode
      // sheet on a Face ID failure. That sheet drops the app into `inactive`
      // long enough to confuse the AppState lock-trigger; the in-app password
      // button below is the explicit fallback path instead.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Beebeeb',
        cancelLabel: 'Cancel',
        disableDeviceFallback: true,
      });
      if (result.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        markUnlocked();
        onUnlocked();
      } else if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
        setError('Authentication failed. Tap to try again.');
      }
    } catch {
      setError('Could not access biometrics. Tap to try again.');
    } finally {
      setAuthenticating(false);
    }
  }, [onUnlocked]);

  const unlockWithPassword = useCallback(async () => {
    const token = await requestConfirmation({
      title: 'Use your Beebeeb password',
      message: 'Enter your password to unlock Beebeeb on this device.',
    });
    if (!token) return;
    markUnlocked();
    onUnlocked();
  }, [onUnlocked]);

  // Auto-trigger on mount
  useEffect(() => {
    authenticate();
  }, [authenticate]);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Center section */}
      <View style={styles.center}>
        {/* Logo */}
        <View style={styles.logo}>
          <BBLogo size={48} />
        </View>

        <Text style={styles.title}>Beebeeb is locked</Text>
        <Text style={styles.subtitle}>
          Your vault key lives only on this device. Use Face ID to unlock it locally — nothing leaves the phone.
        </Text>

        {/* Face ID button */}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={authenticate}
          disabled={authenticating}
          style={styles.faceIdOuter}
        >
          <View style={styles.faceIdInner}>
            {authenticating ? (
              <ActivityIndicator size="large" color={colors.ink} />
            ) : (
              <FaceIdIcon />
            )}
          </View>
        </TouchableOpacity>

        <Text style={styles.lookToUnlock}>
          {authenticating ? 'Authenticating...' : 'Look to unlock'}
        </Text>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        {error && (
          <TouchableOpacity onPress={authenticate} style={styles.errorRow}>
            <Text style={styles.errorText}>{error}</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.footerText}>
          Or{' '}
          <Text style={styles.footerLink} onPress={authenticate}>
            try again
          </Text>
        </Text>
        <TouchableOpacity
          onPress={unlockWithPassword}
          accessibilityRole="button"
          accessibilityLabel="Use Beebeeb password"
          style={styles.passwordButton}
        >
          <Text style={styles.passwordButtonText}>Use Beebeeb password</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.amberBg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  // Logo
  logo: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
    transform: [{ scale: 1.2 }],
  },
  logoText: {
    color: colors.amber,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    maxWidth: 240,
    lineHeight: 19,
  },

  // Face ID button — ring with fill
  faceIdOuter: {
    marginTop: 40,
    width: 96,
    height: 96,
    borderRadius: 24,
    // Double ring via shadow (amber rings)
    shadowColor: colors.amber,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 8,
  },
  faceIdInner: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // SVG-style face icon via pure RN views
  svgContainer: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyes: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
    marginTop: -2,
  },
  eye: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.ink,
  },
  smile: {
    width: 14,
    height: 7,
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderWidth: 2,
    borderTopWidth: 0,
    borderColor: colors.ink,
  },

  lookToUnlock: {
    marginTop: 14,
    fontSize: 12,
    color: colors.ink3,
  },

  // Footer
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    alignItems: 'center',
    gap: 8,
  },
  errorRow: {
    paddingVertical: 4,
  },
  errorText: {
    fontSize: 12,
    color: colors.red,
    textAlign: 'center',
  },
  footerText: {
    fontSize: 12,
    color: colors.ink3,
  },
  footerLink: {
    color: colors.amberDeep,
    fontWeight: '500',
  },
  passwordButton: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  passwordButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
});
