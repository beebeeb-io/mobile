import { BBLogo } from "../components/BBLogo";
import { BBWordmark } from "../components/BBWordmark";
import React, { useMemo, useState } from 'react';
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
import { CommonActions, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { fonts, radii, spacing } from '../theme';
import { useAuth } from '../lib/auth';
import { useCrypto } from '../lib/crypto-context';
import { useTheme } from '../lib/theme-context';
import { useKeyboardLayoutAnimation } from '../lib/useKeyboardLayoutAnimation';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

function normalizePhrase(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export default function RecoveryUnlockScreen() {
  // Block screenshots/screen recording — user types their recovery phrase here.
  usePreventScreenCapture('recovery-unlock');
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const crypto = useCrypto();
  const { colors: c, resolved } = useTheme();
  useKeyboardLayoutAnimation();
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const words = normalizePhrase(phrase).split(' ').filter(Boolean);
  const canSubmit = words.length === 12 && !loading;

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
    logoRow: { alignItems: 'center', marginBottom: spacing.xl },
    heading: { fontSize: 24, fontWeight: '700', color: c.ink, textAlign: 'center', marginBottom: 6 },
    subheading: { fontSize: 13, color: c.ink3, textAlign: 'center', lineHeight: 19, marginBottom: spacing.xl },
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
    label: { fontSize: 12, fontWeight: '600', color: c.ink2, marginBottom: 6 },
    input: {
      minHeight: 116,
      borderWidth: 1,
      borderColor: c.line,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      fontSize: 14,
      lineHeight: 21,
      color: c.ink,
      backgroundColor: c.paper,
      fontFamily: fonts.mono,
      textAlignVertical: 'top',
    },
    counter: { marginTop: 8, fontSize: 12, color: c.ink4, textAlign: 'right' },
    button: {
      height: 46,
      backgroundColor: c.ink,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xl,
    },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: c.amber, fontSize: 15, fontWeight: '700' },
    secondaryButton: { alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.sm },
    secondaryText: { color: c.ink4, fontSize: 13, fontWeight: '600' },
  }), [c, resolved]);

  async function handleUnlock() {
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      await crypto.unlock(normalizePhrase(phrase));
      navigation.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [{ name: 'Tabs' }],
        }),
      );
    } catch {
      setError('That recovery phrase did not unlock this vault. Check the words and order.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    await signOut();
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 28 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoRow}>
          <BBLogo size={48} />
          <BBWordmark size={22} style={{ marginTop: 12 }} />
        </View>

        <Text style={styles.heading}>Unlock your vault</Text>
        <Text style={styles.subheading}>
          This device does not have your vault key yet. Enter your 12-word recovery phrase to decrypt your files here.
        </Text>

        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Text style={styles.label}>Recovery phrase</Text>
        <TextInput
          style={styles.input}
          value={phrase}
          onChangeText={setPhrase}
          placeholder="word one word two ..."
          placeholderTextColor={c.ink4}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          textContentType="none"
          returnKeyType="done"
          testID="recovery-phrase-input"
          accessibilityLabel="Recovery phrase field"
        />
        <Text style={styles.counter}>{words.length}/12 words</Text>

        <TouchableOpacity
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={() => { void handleUnlock(); }}
          activeOpacity={0.85}
          disabled={!canSubmit}
          testID="unlock-vault-button"
          accessibilityLabel="Unlock vault"
        >
          {loading ? <ActivityIndicator color={c.amber} /> : <Text style={styles.buttonText}>Unlock vault</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => { void handleSignOut(); }}
          activeOpacity={0.7}
          testID="recovery-use-another-account"
        >
          <Text style={styles.secondaryText}>Use another account</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
