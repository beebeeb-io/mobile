import { BBLogo } from "../components/BBLogo";
import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
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
import { radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useAuth } from '../lib/auth';
import { useCrypto } from '../lib/crypto-context';
import { useKeyboardLayoutAnimation } from '../lib/useKeyboardLayoutAnimation';
import * as Haptics from 'expo-haptics';
import {
  opaqueRegistrationStart,
  opaqueRegistrationFinish,
  friendlyError,
} from '../lib/api';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import { markUnlocked } from '../lib/lock-state';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function SignupScreen() {
  const navigation = useNavigation<Nav>();
  const { refreshAuth, skipOnboarding } = useAuth();
  const crypto = useCrypto();
  const { colors: c, resolved } = useTheme();
  useKeyboardLayoutAnimation();
  const passwordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    scrollContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.xl, paddingVertical: 40 },
    brandRow: { alignItems: 'center', marginBottom: spacing.xl },
    heading: { fontSize: 24, fontWeight: '700', color: c.ink, textAlign: 'center', marginBottom: 4 },
    subheading: { fontSize: 13, color: c.ink3, textAlign: 'center', marginBottom: spacing.xl },
    errorBanner: { backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2', borderWidth: 1, borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca', borderRadius: radii.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.lg },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    label: { fontSize: 12, fontWeight: '600', color: c.ink2, marginBottom: 4, marginTop: spacing.md },
    input: { height: 44, borderWidth: 1, borderColor: c.line, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 14, color: c.ink, backgroundColor: c.paper },
    checkRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.lg, gap: 10 },
    checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: c.line2, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    checkboxChecked: { backgroundColor: c.amber, borderColor: c.amber },
    checkmark: { fontSize: 12, color: c.paper, fontWeight: '700' },
    checkLabel: { flex: 1, fontSize: 12, color: c.ink2, lineHeight: 17 },
    button: { height: 44, backgroundColor: c.ink, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: c.paper, fontSize: 14, fontWeight: '600' },
    footerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
    footerText: { fontSize: 13, color: c.ink3 },
    footerLink: { fontSize: 13, color: c.amberDeep, fontWeight: '600' },
    regionRow: { alignItems: 'center', marginTop: spacing['2xl'], gap: 2 },
    regionText: { fontSize: 11, color: c.ink4, textAlign: 'center' },
    legalText: { fontSize: 11, textAlign: 'center', marginTop: 12, lineHeight: 16, paddingHorizontal: spacing.md },
    legalLink: { color: c.amber, textDecorationLine: 'underline' },
  }), [c, resolved]);

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
      let phrase: string[] = [];
      try {
        const { state, serverMessage } = await opaqueRegistrationStart(trimmedEmail, password);
        const recovery = await BeebeebCrypto.generateRecoveryPhrase();
        phrase = recovery.phrase.split(' ');
        const [recoveryCheck, x25519PublicKey] = await Promise.all([
          BeebeebCrypto.computeRecoveryCheck(recovery.masterKey),
          BeebeebCrypto.deriveX25519PublicKey(recovery.masterKey),
        ]);
        await opaqueRegistrationFinish(
          trimmedEmail,
          password,
          state,
          serverMessage,
          recoveryCheck,
          x25519PublicKey,
        );
        try {
          await crypto.unlock(recovery.phrase);
        } catch {
          // Keychain unavailable — phrase is still shown once so the user can
          // provision this device on the next login.
        }
        opaqueDone = true;
      } catch (opaqueErr) {
        throw opaqueErr;
      }

      if (opaqueDone) {
        markUnlocked();
        // Dismiss onboarding overlay + mark phrase as pending before refreshAuth
        // so the phrase screens are visible (not covered by the welcome overlay).
        skipOnboarding(phrase);
        // Refresh auth state so the authenticated stack is available before navigating
        await refreshAuth();
      }
    } catch (err) {
      setError(friendlyError(err));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
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
          placeholderTextColor={c.ink4}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => passwordRef.current?.focus()}
          testID="email-input"
          accessibilityLabel="Signup email field"
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
          placeholderTextColor={c.ink4}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules="minlength: 8;"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => confirmPasswordRef.current?.focus()}
          testID="password-input"
          accessibilityLabel="Signup password field"
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
          placeholderTextColor={c.ink4}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules="minlength: 8;"
          returnKeyType="go"
          onSubmitEditing={handleSignup}
          testID="confirm-password-input"
          accessibilityLabel="Signup confirm password field"
          editable={!loading}
        />

        {/* Acknowledge checkbox */}
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setAcknowledged(!acknowledged)}
          activeOpacity={0.7}
          disabled={loading}
          accessibilityLabel="Acknowledge recovery warning"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
          testID="recovery-warning-checkbox"
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
          accessibilityLabel="Submit create account"
          testID="create-account-button"
        >
          {loading ? (
            <ActivityIndicator color={c.paper} size="small" />
          ) : (
            <Text style={styles.buttonText}>Create account</Text>
          )}
        </TouchableOpacity>

        {/* Login link */}
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            disabled={loading}
            accessibilityLabel="Sign in"
            testID="sign-in-link"
          >
            <Text style={styles.footerLink}>Sign in</Text>
          </TouchableOpacity>
        </View>

        {/* Legal — GDPR Article 13 */}
        <Text style={[styles.legalText, { color: c.ink3 }]}>
          By creating an account, you agree to our{' '}
          <Text
            style={styles.legalLink}
            onPress={() => Linking.openURL('https://beebeeb.io/terms').catch(() => {})}
          >
            Terms of Service
          </Text>
          {' '}and{' '}
          <Text
            style={styles.legalLink}
            onPress={() => Linking.openURL('https://beebeeb.io/privacy').catch(() => {})}
          >
            Privacy Policy
          </Text>
          . Your data is processed by Initlabs B.V. under GDPR.
        </Text>

        {/* Region + legal */}
        <View style={styles.regionRow}>
          <Text style={styles.regionText}>Stored in Europe.</Text>
          <Text style={styles.regionText}>
            Operated by Beebeeb.io, Netherlands.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
