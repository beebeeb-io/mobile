import { BBLogo } from "../components/BBLogo";
import { BBWordmark } from "../components/BBWordmark";
import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { radii, spacing } from '../theme';
import {
  opaqueLoginStart,
  opaqueLoginFinish,
  friendlyError,
  TwoFactorRequiredError,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme-context';
import * as Haptics from 'expo-haptics';
import { markUnlocked } from '../lib/lock-state';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type RouteProps = NativeStackScreenProps<RootStackParamList, 'Login'>['route'];

export default function LoginScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProps>();
  const { refreshAuth } = useAuth();
  const { colors: c, resolved } = useTheme();
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    button: { height: 44, backgroundColor: c.ink, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: c.paper, fontSize: 14, fontWeight: '600' },
    footerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
    footerText: { fontSize: 13, color: c.ink3 },
    footerLink: { fontSize: 13, color: c.amberDeep, fontWeight: '600' },
    regionRow: { alignItems: 'center', marginTop: spacing['2xl'] },
    regionText: { fontSize: 11, color: c.ink4 },
  }), [c, resolved]);

  async function handleLogin() {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      setError('Email and password are required.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      // OPAQUE login — no fallback to password-based auth.
      // If OPAQUE fails the error is surfaced to the user.
      const { state, serverMessage, serverState } = await opaqueLoginStart(trimmedEmail, password);
      await opaqueLoginFinish(trimmedEmail, password, state, serverMessage, serverState);
      // Token is stored by opaqueLoginFinish. App.tsx auth state will pick it up.
      markUnlocked();
      // Token stored — tell App to refresh auth state
      await refreshAuth();
      if (route.params?.returnTo === 'DevicePairingScan') {
        setTimeout(() => navigation.navigate('DevicePairingScan'), 0);
      }
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) {
        // Navigate to the 2FA challenge screen with the partial token.
        // refreshAuth is deferred until after completeTwoFactor succeeds.
        setLoading(false);
        navigation.navigate('TwoFactorChallenge', { partialToken: err.partialToken });
        return;
      }
      setError(friendlyError(err));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      showsVerticalScrollIndicator={false}
    >
      <View>
        {/* Logo / brand */}
        <View style={styles.brandRow}>
          <BBLogo size={48} />
          <BBWordmark size={22} style={{ marginTop: 12 }} />
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
          accessibilityLabel="Login email field"
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
          placeholderTextColor={c.ink4}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={handleLogin}
          testID="password-input"
          accessibilityLabel="Login password field"
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
            <ActivityIndicator color={c.paper} size="small" />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>

        {/* Signup link */}
        <View style={styles.footerRow}>
          <Text style={styles.footerText}>No account yet? </Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('Signup')}
            disabled={loading}
            accessibilityLabel="Open create account"
            testID="create-account-link"
          >
            <Text style={styles.footerLink}>Create account</Text>
          </TouchableOpacity>
        </View>

        {/* Region */}
        <View style={styles.regionRow}>
          <Text style={styles.regionText}>Stored in Europe.</Text>
        </View>
      </View>
    </ScrollView>
  );
}
