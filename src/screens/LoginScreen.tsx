import { BBLogo } from "../components/BBLogo";
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radii, spacing } from '../theme';
import { login, opaqueLoginStart, opaqueLoginFinish, ApiError, friendlyError } from '../lib/api';
import { useAuth } from '../lib/auth';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import type { RootStackParamList } from '../App';

const MASTER_KEY_LABEL = 'io.beebeeb.master-key';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function LoginScreen() {
  const navigation = useNavigation<Nav>();
  const { refreshAuth } = useAuth();
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      setError('Email and password are required.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      // Attempt OPAQUE login (3-round flow)
      try {
        const { state, serverMessage } = await opaqueLoginStart(trimmedEmail);
        const { masterKey } = await opaqueLoginFinish(trimmedEmail, state, serverMessage);
        // Store master key in Secure Enclave for biometric unlock on future opens
        try {
          await BeebeebCrypto.storeKeyInKeychain(masterKey, MASTER_KEY_LABEL);
        } catch {
          // Native module not yet linked — ignore until xcframework is wired
        }
        // Token is stored by opaqueLoginFinish. App.tsx auth state will pick it up.
      } catch {
        // Fall back to legacy login — OPAQUE may fail because:
        // - native crypto module not linked yet (throws native error)
        // - OPAQUE endpoints not deployed (404)
        // - network issue (status 0)
        await login(trimmedEmail, password);
      }
      // Token stored — tell App to refresh auth state
      await refreshAuth();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.container}>
        {/* Logo / brand */}
        <View style={styles.brandRow}>
          <BBLogo size={48} />
        </View>

        <Text style={styles.heading}>Sign in</Text>
        <Text style={styles.subheading}>
          End-to-end encrypted cloud storage.
        </Text>

        {/* Error banner */}
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Email */}
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={colors.ink4}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          testID="email-input"
          editable={!loading}
        />

        {/* Password */}
        <Text style={styles.label}>Password</Text>
        <TextInput
          ref={passwordRef}
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          placeholderTextColor={colors.ink4}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password"
          returnKeyType="go"
          onSubmitEditing={handleLogin}
          testID="password-input"
          editable={!loading}
        />

        {/* Login button */}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          activeOpacity={0.8}
          disabled={loading}
          accessibilityLabel="Sign in"
          testID="sign-in-button"
        >
          {loading ? (
            <ActivityIndicator color={colors.paper} size="small" />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>

        {/* Signup link */}
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>No account yet? </Text>
          <TouchableOpacity onPress={() => navigation.navigate('Signup')} disabled={loading}>
            <Text style={styles.footerLink}>Create account</Text>
          </TouchableOpacity>
        </View>

        {/* Region */}
        <View style={styles.regionRow}>
          <Text style={styles.regionText}>Stored in Frankfurt. Hetzner.</Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: 40,
  },

  // Brand
  brandRow: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  logoMark: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    color: colors.amber,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  // Headings
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 4,
  },
  subheading: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },

  // Error
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: {
    fontSize: 12,
    color: colors.red,
    lineHeight: 17,
  },

  // Form
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink2,
    marginBottom: 4,
    marginTop: spacing.md,
  },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    color: colors.ink,
    backgroundColor: colors.paper,
  },

  // Button
  button: {
    height: 44,
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.paper,
    fontSize: 14,
    fontWeight: '600',
  },

  // Footer
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  footerText: {
    fontSize: 13,
    color: colors.ink3,
  },
  footerLink: {
    fontSize: 13,
    color: colors.amberDeep,
    fontWeight: '600',
  },

  // Region
  regionRow: {
    alignItems: 'center',
    marginTop: spacing['2xl'],
  },
  regionText: {
    fontSize: 11,
    color: colors.ink4,
  },
});
