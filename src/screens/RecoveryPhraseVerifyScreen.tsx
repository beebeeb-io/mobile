import { BBLogo } from "../components/BBLogo";
import { BBWordmark } from "../components/BBWordmark";
import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { fonts, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useAuth } from '../lib/auth';
import { useCrypto } from '../lib/crypto-context';
import { ensureUnlockedAndSeed } from '../lib/welcome-seed';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'RecoveryPhraseVerify'>;

function pickVerifyPositions(length: number): number[] {
  if (length <= 0) return [];
  const count = Math.min(3, length);
  const positions: number[] = [];
  while (positions.length < count) {
    const n = Math.floor(Math.random() * length);
    if (!positions.includes(n)) positions.push(n);
  }
  return positions.sort((a, b) => a - b);
}

export default function RecoveryPhraseVerifyScreen() {
  // Block screenshots/screen recording — the phrase words are inferable from
  // the prompts and entered text on this screen.
  usePreventScreenCapture('recovery-phrase-verify');
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();

  const { user, markPhraseVerified } = useAuth();
  const { encryptChunk, encryptMetadata, isUnlocked, unlock } = useCrypto();
  const { phrase } = route.params;
  const positions = useMemo(() => pickVerifyPositions(phrase.length), [phrase.length]);

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    content: { paddingHorizontal: spacing.xl },
    logoRow: { alignItems: 'center', marginBottom: 22 },
    logo: { width: 44, height: 44, borderRadius: 12, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' },
    logoText: { color: c.amber, fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },
    heading: { fontSize: 22, fontWeight: '700', color: c.ink, textAlign: 'center', letterSpacing: -0.3, marginBottom: 6 },
    subheading: { fontSize: 13, color: c.ink3, textAlign: 'center', lineHeight: 19, marginBottom: 24 },
    errorBanner: { backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2', borderWidth: 1, borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca', borderRadius: radii.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.lg },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    inputsCard: { backgroundColor: c.paper, borderRadius: radii.lg, borderWidth: 1, borderColor: c.line, marginBottom: 24, overflow: 'hidden' },
    inputRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
    inputRowBorder: { borderBottomWidth: 1, borderBottomColor: c.line },
    posLabel: { width: 28, height: 28, borderRadius: radii.sm, backgroundColor: c.paper2, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    posNumber: { fontSize: 12, fontWeight: '700', color: c.ink3 },
    input: { flex: 1, height: 36, fontSize: 14, color: c.ink, fontFamily: fonts.mono },
    inputError: { color: c.red },
    button: { backgroundColor: c.ink, borderRadius: radii.md, paddingVertical: 15, alignItems: 'center', marginBottom: 14 },
    buttonDisabled: { opacity: 0.4 },
    buttonText: { fontSize: 15, fontWeight: '700', color: c.amber },
    backRow: { alignItems: 'center', paddingVertical: 4 },
    backText: { fontSize: 13, color: c.ink4 },
  }), [c, resolved]);

  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [error, setError] = useState<string | null>(null);

  function setAnswer(index: number, value: string) {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value.trim().toLowerCase();
      return next;
    });
    if (error) setError(null);
  }

  async function handleVerify() {
    const allCorrect = positions.every(
      (pos, i) => answers[i] === phrase[pos].toLowerCase()
    );
    if (!allCorrect) {
      setError("One or more words don't match. Check your phrase and try again.");
      return;
    }
    await markPhraseVerified();

    // Fire-and-forget seed of a welcome.md into a brand-new account. The
    // helper is idempotent (SecureStore flag + server-side root-empty check),
    // gracefully no-ops on errors, and never blocks navigation.
    //
    // `isUnlocked` here can be a STALE snapshot (task 1444):
    // `<CryptoProvider key={user?.user_id ?? 'signed-out'}>` (App.tsx)
    // remounts the whole crypto context the instant `user.user_id` first
    // populates — SignupScreen unlocks the vault under the transient
    // 'signed-out' key (before `user` exists), then `refreshAuth()` flips the
    // key and React tears that instance down (releasing its native key
    // handle) and mounts a fresh, locked one. `BiometricGuard`'s "post-login
    // vault unlock" effect re-unlocks the new instance from the keychain, but
    // it's fire-and-forget — a fast verify (e.g. a scripted/Maestro run) can
    // reach here before it resolves, so trusting this snapshot silently
    // skipped the seed with no log line at all. `ensureUnlockedAndSeed`
    // actively (re)unlocks instead — a no-op if already unlocked, and dedups
    // with any unlock already in flight.
    if (user?.user_id) {
      const userId = user.user_id;
      void ensureUnlockedAndSeed({
        userId,
        isUnlocked,
        unlock: () => unlock(undefined, 'welcome_seed_verify'),
        encryptChunkFn: encryptChunk,
        encryptMetadataFn: encryptMetadata,
      });
    } else {
      console.info('[welcome-seed] seed skipped: no authenticated user at verify time');
    }

    navigation.navigate('Tabs');
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <View style={styles.logoRow}>
          <View style={styles.logo}>
            <BBLogo size={48} />
          </View>
          <BBWordmark size={22} style={{ marginTop: 12 }} />
        </View>

        <Text style={styles.heading}>Verify your phrase</Text>
        <Text style={styles.subheading}>
          Enter the words at the positions below to confirm you saved your phrase.
        </Text>

        {/* Error */}
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Word inputs */}
        <View style={styles.inputsCard}>
          {positions.map((pos, i) => (
            <View key={pos} style={[styles.inputRow, i < positions.length - 1 && styles.inputRowBorder]}>
              <View style={styles.posLabel}>
                <Text style={styles.posNumber}>{pos + 1}</Text>
              </View>
              <TextInput
                style={[styles.input, error && answers[i] !== phrase[pos].toLowerCase() && styles.inputError]}
                value={answers[i]}
                onChangeText={(v) => setAnswer(i, v)}
                placeholder={`Word #${pos + 1}`}
                placeholderTextColor={c.ink4}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType={i < positions.length - 1 ? 'next' : 'done'}
              />
            </View>
          ))}
        </View>

        {/* Verify button */}
        <TouchableOpacity
          style={[styles.button, answers.some((a) => !a) && styles.buttonDisabled]}
          onPress={() => { void handleVerify(); }}
          activeOpacity={0.8}
          disabled={answers.some((a) => !a)}
        >
          <Text style={styles.buttonText}>Confirm and continue</Text>
        </TouchableOpacity>

        {/* Back to phrase — allowed, so user can re-read the words */}
        <TouchableOpacity
          style={styles.backRow}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Text style={styles.backText}>Back to phrase</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

