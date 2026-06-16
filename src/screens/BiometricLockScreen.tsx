import { BBLogo } from "../components/BBLogo";
import { BBWordmark } from "../components/BBWordmark";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { requestConfirmation } from '../lib/confirm-action';
import { markUnlocked } from '../lib/lock-state';

interface Props {
  /**
   * Perform the actual vault unlock (load the master key + warm caches) and
   * report whether the app may transition past the lock screen. On real
   * release builds the key load itself triggers the Secure-Enclave Face ID
   * prompt — that is THE biometric gate, so `requireExplicitBiometric` is
   * false and we do NOT prompt separately. Resolves `{ ok: false }` when the
   * biometric was cancelled / the key could not be loaded, so we stay locked.
   * `fallbackUnlock` is set by the password path to preserve best-effort
   * unlock when the key load fails.
   */
  onUnlocked: (opts?: { fallbackUnlock?: boolean }) => Promise<{ ok: boolean }>;
  /**
   * When true, the key load will NOT raise a biometric prompt (simulator /
   * Debug build, or the vault is already warm from a foreground re-lock), so
   * this screen must run its own `LocalAuthentication.authenticateAsync()` to
   * enforce a biometric. When false, the Secure-Enclave decrypt inside
   * `onUnlocked()` is the single biometric — prompting here too would produce
   * the double Face ID prompt (task 0792).
   */
  requireExplicitBiometric: boolean;
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

export default function BiometricLockScreen({ onUnlocked, requireExplicitBiometric }: Props) {
  // Block screenshots/screen recording while the app is locked — the lock
  // screen covers any sensitive content that was on-screen at lock time.
  usePreventScreenCapture('biometric-lock');
  const insets = useSafeAreaInsets();
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoPromptedRef = useRef(false);
  // Guards against a second concurrent prompt — the auto-prompt effect and a
  // user tap can otherwise both call authenticate(), stacking two Face ID
  // sheets. Cleared in the finally block once the first one settles.
  const inFlightRef = useRef(false);

  const authenticate = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setAuthenticating(true);
    try {
      // EXACTLY ONE biometric evaluation must occur (task 0792). Two cases:
      //
      //   1. requireExplicitBiometric — the vault key load will NOT prompt
      //      (simulator / Debug build, or the vault is already warm from a
      //      foreground re-lock). We must prompt here, and this is the gate.
      //   2. otherwise — the key load (`onUnlocked`) performs the
      //      Secure-Enclave Face ID decrypt; that IS the single prompt, so we
      //      do NOT prompt here. Prompting in both places is what produced the
      //      "succeeds but app doesn't open, then prompts again" double prompt.
      if (requireExplicitBiometric) {
        // disableDeviceFallback: true keeps iOS from offering the device
        // passcode sheet on a Face ID failure. That sheet drops the app into
        // `inactive` long enough to confuse the AppState lock-trigger; the
        // in-app password button below is the explicit fallback path instead.
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock Beebeeb',
          cancelLabel: 'Cancel',
          disableDeviceFallback: true,
        });
        if (!result.success) {
          if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
            setError('Authentication failed. Tap to try again.');
          }
          return;
        }
        // Bridge the lock-state grace window across the inactive→active churn
        // around the prompt and the subsequent key load, so the AppState
        // listener doesn't re-arm the lock under us.
        markUnlocked();
      }

      const outcome = await onUnlocked();
      if (!outcome.ok) {
        // Key load failed (e.g. the Secure-Enclave biometric was cancelled).
        // Fail closed — stay locked and let the user retry. Never transition
        // without a successful biometric.
        setError('Authentication failed. Tap to try again.');
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setError('Could not access biometrics. Tap to try again.');
    } finally {
      setAuthenticating(false);
      inFlightRef.current = false;
    }
  }, [onUnlocked, requireExplicitBiometric]);

  const unlockWithPassword = useCallback(async () => {
    const token = await requestConfirmation({
      title: 'Use your Beebeeb password',
      message: 'Enter your password to unlock Beebeeb on this device.',
    });
    if (!token) return;
    markUnlocked();
    // Password is the fallback when biometrics aren't working — allow the app
    // through even if the (biometric-gated) key load can't complete here.
    await onUnlocked({ fallbackUnlock: true });
  }, [onUnlocked]);

  // Auto-trigger on mount
  useEffect(() => {
    if (autoPromptedRef.current) return;
    autoPromptedRef.current = true;
    authenticate();
  }, [authenticate]);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Center section */}
      <View style={styles.center}>
        {/* Logo — wordmark omitted here because `styles.logo` is a fixed
            52x52 ink-colored frame that would clip the wordmark. */}
        <View style={styles.logo}>
          <BBLogo size={48} />
        </View>
        <BBWordmark size={22} style={{ marginTop: 12 }} />

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
        <Text style={styles.footerText} onPress={authenticate}>
          Try Face ID again
        </Text>
        {error && (
          <TouchableOpacity
            onPress={unlockWithPassword}
            accessibilityRole="button"
            accessibilityLabel="Use Beebeeb password"
            style={styles.passwordButton}
          >
            <Text style={styles.passwordButtonText}>Use Beebeeb password</Text>
          </TouchableOpacity>
        )}
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
