import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { useRoute } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { BBLogo } from '../components/BBLogo';
import { SixDigitInput, type SixDigitInputHandle } from '../components/SixDigitInput';
import { radii, spacing } from '../theme';
import { completeTwoFactor, friendlyError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme-context';
import { markUnlocked } from '../lib/lock-state';
import type { RootStackParamList } from '../App';

type RouteProps = NativeStackScreenProps<RootStackParamList, 'TwoFactorChallenge'>['route'];

export default function TwoFactorChallengeScreen() {
  const route = useRoute<RouteProps>();
  const { partialToken } = route.params;
  const { refreshAuth } = useAuth();
  const { colors: c, resolved } = useTheme();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backupRef = useRef<TextInput>(null);
  const sixBoxRef = useRef<SixDigitInputHandle>(null);
  // Re-entrancy guard so an auto-submit on the 6th digit can't double-fire
  // if React batches the onChange + onComplete into the same tick.
  const submittingRef = useRef(false);

  useEffect(() => {
    if (useBackup) {
      const id = setTimeout(() => backupRef.current?.focus(), 200);
      return () => clearTimeout(id);
    }
    // SixDigitInput handles its own first-mount focus.
    return undefined;
  }, [useBackup]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: c.paper },
        scrollContent: {
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: spacing.xl,
          paddingVertical: 40,
        },
        brandRow: { alignItems: 'center', marginBottom: spacing.xl },
        heading: {
          fontSize: 24,
          fontWeight: '700',
          color: c.ink,
          textAlign: 'center',
          marginBottom: 4,
        },
        subheading: {
          fontSize: 13,
          color: c.ink3,
          textAlign: 'center',
          marginBottom: spacing.xl,
        },
        errorBanner: {
          backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
          borderWidth: 1,
          borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
          borderRadius: radii.md,
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          marginBottom: spacing.lg,
        },
        errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
        label: {
          fontSize: 12,
          fontWeight: '600',
          color: c.ink2,
          marginBottom: 4,
          marginTop: spacing.md,
        },
        input: {
          height: 44,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: radii.md,
          paddingHorizontal: spacing.md,
          fontSize: 14,
          color: c.ink,
          backgroundColor: c.paper,
        },
        button: {
          height: 44,
          backgroundColor: c.ink,
          borderRadius: radii.md,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: spacing.xl,
        },
        buttonDisabled: { opacity: 0.6 },
        buttonText: { color: c.paper, fontSize: 14, fontWeight: '600' },
        footerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
        footerLink: { fontSize: 13, color: c.amberDeep, fontWeight: '600' },
      }),
    [c, resolved],
  );

  async function handleSubmit(explicitCode?: string) {
    if (submittingRef.current) return;
    const trimmed = (explicitCode ?? code).trim();
    if (!trimmed) {
      setError(
        useBackup ? 'Enter a backup code.' : 'Enter the 6-digit code from your authenticator.',
      );
      return;
    }
    submittingRef.current = true;
    setError(null);
    setLoading(true);
    try {
      await completeTwoFactor(partialToken, trimmed);
      markUnlocked();
      await refreshAuth();
      // App.tsx auth state will react to the new token and reset to Tabs.
    } catch (err) {
      setError(friendlyError(err));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (!useBackup) {
        // Wrong code — clear the boxes so the user can retype without
        // having to backspace 6 times.
        setCode('');
        sixBoxRef.current?.clear();
      }
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandRow}>
          <BBLogo size={48} />
        </View>
        <Text style={styles.heading}>Two-factor verification</Text>
        <Text style={styles.subheading}>
          {useBackup
            ? 'Enter one of your backup codes.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </Text>
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        <Text style={styles.label}>{useBackup ? 'Backup code' : 'Authenticator code'}</Text>
        {useBackup ? (
          <TextInput
            ref={backupRef}
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="XXXX-XXXX"
            placeholderTextColor={c.ink4}
            keyboardType="default"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={20}
            returnKeyType="go"
            onSubmitEditing={() => handleSubmit()}
            editable={!loading}
            accessibilityLabel="Backup code"
            testID="two-factor-code-input"
          />
        ) : (
          <SixDigitInput
            ref={sixBoxRef}
            value={code}
            onChange={(next) => {
              setCode(next);
              if (error) setError(null);
            }}
            onComplete={(full) => {
              void handleSubmit(full);
            }}
            disabled={loading}
            invalid={!!error}
            testID="two-factor-code-input"
            accessibilityLabel="Authenticator code"
          />
        )}
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={() => handleSubmit()}
          activeOpacity={0.8}
          disabled={loading}
          accessibilityLabel="Verify"
          testID="two-factor-submit"
        >
          {loading ? (
            <ActivityIndicator color={c.paper} size="small" />
          ) : (
            <Text style={styles.buttonText}>Verify</Text>
          )}
        </TouchableOpacity>
        <View style={styles.footerRow}>
          <TouchableOpacity
            onPress={() => {
              setUseBackup(!useBackup);
              setCode('');
              setError(null);
            }}
            disabled={loading}
            accessibilityLabel="Toggle backup code"
            testID="two-factor-toggle-backup"
          >
            <Text style={styles.footerLink}>
              {useBackup ? 'Use authenticator code instead' : 'Use a backup code instead'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
