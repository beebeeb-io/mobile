import { BBLogo } from "../components/BBLogo";
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radii, spacing } from '../theme';
import { useAuth } from '../lib/auth';
import {
  signup,
  opaqueRegistrationStart,
  opaqueRegistrationFinish,
  ApiError,
  friendlyError,
} from '../lib/api';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import type { RootStackParamList } from '../App';

const MASTER_KEY_LABEL = 'io.beebeeb.master-key';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function SignupScreen() {
  const navigation = useNavigation<Nav>();
  const { refreshAuth } = useAuth();
  const passwordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validate(): string | null {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return 'Email is required.';
    if (!trimmedEmail.includes('@')) return 'Please enter a valid email address.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirmPassword) return 'Passwords do not match.';
    if (!acknowledged) return 'You must acknowledge the recovery warning to continue.';
    return null;
  }

  async function handleSignup() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    setError(null);
    setLoading(true);
    try {
      // Attempt OPAQUE registration (3-round flow)
      let opaqueDone = false;
      try {
        const { state, serverMessage } = await opaqueRegistrationStart(trimmedEmail, password);
        await opaqueRegistrationFinish(trimmedEmail, state, serverMessage);
        opaqueDone = true;
      } catch (opaqueErr) {
        // Fall back to legacy signup when OPAQUE endpoints are not deployed yet
        if (
          opaqueErr instanceof ApiError &&
          (opaqueErr.status === 404 || opaqueErr.status === 0)
        ) {
          await signup(trimmedEmail, password);
          await refreshAuth();
          return;
        }
        throw opaqueErr;
      }

      if (opaqueDone) {
        // Generate recovery phrase and derive master key from it
        let phrase: string[] = [];
        try {
          const result = await BeebeebCrypto.generateRecoveryPhrase();
          phrase = result.phrase.split(' ');
          await BeebeebCrypto.storeKeyInKeychain(result.masterKey, MASTER_KEY_LABEL);
        } catch {
          // Native module not yet linked — proceed without phrase storage
        }
        // Refresh auth state so the authenticated stack is available before navigating
        await refreshAuth();
        navigation.navigate('RecoveryPhrase', { phrase: phrase.length > 0 ? phrase : undefined });
      }
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
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo / brand */}
        <View style={styles.brandRow}>
          <BBLogo size={48} />
        </View>

        <Text style={styles.heading}>Create account</Text>
        <Text style={styles.subheading}>
          Your files, encrypted before they leave your device.
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
          blurOnSubmit={false}
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
          placeholder="At least 8 characters"
          placeholderTextColor={colors.ink4}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => confirmPasswordRef.current?.focus()}
          testID="password-input"
          editable={!loading}
        />

        {/* Confirm password */}
        <Text style={styles.label}>Confirm password</Text>
        <TextInput
          ref={confirmPasswordRef}
          style={styles.input}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Repeat your password"
          placeholderTextColor={colors.ink4}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          returnKeyType="go"
          onSubmitEditing={handleSignup}
          testID="confirm-password-input"
          editable={!loading}
        />

        {/* Acknowledge checkbox */}
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setAcknowledged(!acknowledged)}
          activeOpacity={0.7}
          disabled={loading}
        >
          <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
            {acknowledged && <Text style={styles.checkmark}>{'✓'}</Text>}
          </View>
          <Text style={styles.checkLabel}>
            I understand that Beebeeb cannot recover my password. If I lose it, my data is gone.
          </Text>
        </TouchableOpacity>

        {/* Signup button */}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSignup}
          activeOpacity={0.8}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.paper} size="small" />
          ) : (
            <Text style={styles.buttonText}>Create account</Text>
          )}
        </TouchableOpacity>

        {/* Login link */}
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <TouchableOpacity onPress={() => navigation.goBack()} disabled={loading}>
            <Text style={styles.footerLink}>Sign in</Text>
          </TouchableOpacity>
        </View>

        {/* Region + legal */}
        <View style={styles.regionRow}>
          <Text style={styles.regionText}>Stored in Falkenstein.</Text>
          <Text style={styles.regionText}>
            Operated by Initlabs B.V., Wijchen, Netherlands.
          </Text>
        </View>
      </ScrollView>
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
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 40,
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

  // Checkbox
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: spacing.lg,
    gap: 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.line2,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: colors.amber,
    borderColor: colors.amber,
  },
  checkmark: {
    fontSize: 12,
    color: colors.paper,
    fontWeight: '700',
  },
  checkLabel: {
    flex: 1,
    fontSize: 12,
    color: colors.ink2,
    lineHeight: 17,
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
    gap: 2,
  },
  regionText: {
    fontSize: 11,
    color: colors.ink4,
    textAlign: 'center',
  },
});
