/**
 * Task 1445 (ruling 2, 2026-09-21) — the app was killed while a fresh
 * signup was still on the recovery-phrase onboarding steps (before
 * `markPhraseVerified()` ran), and relaunched. The cold-start router used
 * to land straight in the vault with the phrase never confirmed.
 *
 * The original ruling asked to resume onboarding and re-show the 12 words.
 * That is cryptographically impossible — the phrase is never persisted
 * anywhere (device or server), by design: it is shown once at signup and
 * only the master key it derives (a one-way Argon2id KDF, see
 * `repos/core/beebeeb-core/src/recovery.rs`) is kept in the keychain. So
 * this screen does NOT try to show the words again. It blocks the vault
 * entirely and offers exactly two honest paths: re-enter the phrase for a
 * safe compare-only verification (`verifyRecoveryPhrase` — never writes to
 * the keychain, so a wrong guess cannot corrupt the real key), or delete
 * this account and start over. No third path — there is no "continue
 * anyway" skip.
 *
 * No `design/ios26-canvas/` artboard covers onboarding/recovery-phrase
 * screens at all (none of the eleven `.dc.html` files mention "recovery" or
 * "phrase"), so this screen is styled to match its siblings
 * (`OnboardingScreen.tsx`, `RecoveryUnlockScreen.tsx`, plain surfaces, one
 * amber primary action) rather than the glass recipe — same DEVIATIONS.md
 * class as every other "no canvas artboard" entry in that ledger, recorded
 * there by the lead (this repo has no local copy of that file to edit).
 */
import { BBLogo } from '../components/BBLogo';
import { BBWordmark } from '../components/BBWordmark';
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
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePreventScreenCapture } from 'expo-screen-capture';
import * as Haptics from 'expo-haptics';
import { fonts, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useAuth } from '../lib/auth';
import { useCrypto } from '../lib/crypto-context';
import { confirmPhraseAndSeed } from '../lib/onboarding-confirm-seed';
import { attemptPhraseVerification } from '../lib/phrase-not-confirmed-flow';
import { RECOVERY_WORD_COUNT, normalizePhrase, wordsFromPhrase } from '../lib/recovery-phrase';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Step = 'choice' | 'verify';

export default function PhraseNotConfirmedScreen() {
  // Words get typed back in on the verify step — same capture risk as every
  // other recovery-phrase screen.
  usePreventScreenCapture('phrase-not-confirmed');
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { user, markPhraseVerified } = useAuth();
  const crypto = useCrypto();

  const [step, setStep] = useState<Step>('choice');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const words = wordsFromPhrase(phrase);
  const canSubmit = words.length === RECOVERY_WORD_COUNT && !verifying;

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    content: { flexGrow: 1, paddingHorizontal: spacing.xl, justifyContent: 'center' },
    logoRow: { alignItems: 'center', marginBottom: spacing.xl },
    heading: { fontSize: 22, fontWeight: '800', color: c.ink, textAlign: 'center', letterSpacing: -0.2, marginBottom: spacing.sm },
    body: { fontSize: 14, color: c.ink2, lineHeight: 20, textAlign: 'center', marginBottom: spacing.lg },
    warning: {
      padding: spacing.md,
      backgroundColor: c.amberBg,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: c.amber,
      marginBottom: spacing.xl,
    },
    warningText: { color: c.ink, fontSize: 13, lineHeight: 19, fontWeight: '700', textAlign: 'center' },
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
      backgroundColor: c.paper2,
      fontFamily: fonts.mono,
      textAlignVertical: 'top',
    },
    counter: { marginTop: 8, marginBottom: spacing.lg, fontSize: 12, color: c.ink4, textAlign: 'right' },
    button: {
      minHeight: 48,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    primaryButton: { backgroundColor: c.amber },
    secondaryButton: { backgroundColor: c.paper, borderWidth: 1, borderColor: c.line },
    destructiveButton: { backgroundColor: c.paper, borderWidth: 1, borderColor: c.line },
    buttonDisabled: { opacity: 0.45 },
    buttonStack: { gap: spacing.md },
    buttonText: { color: c.ink, fontSize: 15, fontWeight: '800', textAlign: 'center' },
    secondaryButtonText: { color: c.ink2, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    destructiveButtonText: { color: c.red, fontSize: 15, fontWeight: '700', textAlign: 'center' },
    backRow: { alignItems: 'center', paddingVertical: spacing.sm, marginTop: spacing.sm },
    backText: { color: c.ink4, fontSize: 13, fontWeight: '600' },
  }), [c, resolved]);

  async function handleVerify() {
    if (!canSubmit) return;
    setError(null);
    setVerifying(true);
    try {
      const outcome = await attemptPhraseVerification(normalizePhrase(phrase), {
        verifyRecoveryPhrase: crypto.verifyRecoveryPhrase,
        markPhraseVerified,
        seed: () => confirmPhraseAndSeed({
          allCorrect: true,
          userId: user?.user_id,
          isUnlocked: crypto.isUnlocked,
          unlock: () => crypto.unlock(undefined, 'welcome_seed_verify'),
          encryptChunkFn: crypto.encryptChunk,
          encryptMetadataFn: crypto.encryptMetadata,
        }),
      });
      if (outcome === 'mismatch') {
        setError("That phrase doesn't match this account. Check the words and try again.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    } finally {
      setVerifying(false);
    }
  }

  function handleStartOver() {
    navigation.navigate('DeleteAccount');
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
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

        {step === 'choice' && (
          <>
            <Text style={styles.heading}>Confirm your recovery phrase</Text>
            <Text style={styles.body}>
              This device closed before you finished setting up your account. We can't show your
              recovery phrase again — it's shown once, at signup, and never stored anywhere, not
              even by us.
            </Text>
            <View style={styles.warning}>
              <Text style={styles.warningText}>
                Your vault stays locked until you either confirm your phrase or start over.
              </Text>
            </View>
            <View style={styles.buttonStack}>
              <TouchableOpacity
                style={[styles.button, styles.primaryButton]}
                onPress={() => setStep('verify')}
                activeOpacity={0.82}
                accessibilityRole="button"
                testID="phrase-not-confirmed-verify"
              >
                <Text style={styles.buttonText}>I wrote it down — verify it</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.destructiveButton]}
                onPress={handleStartOver}
                activeOpacity={0.78}
                accessibilityRole="button"
                testID="phrase-not-confirmed-start-over"
              >
                <Text style={styles.destructiveButtonText}>I didn't save it — start over</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {step === 'verify' && (
          <>
            <Text style={styles.heading}>Enter your recovery phrase</Text>
            <Text style={styles.body}>
              Enter all 12 words in order to confirm this is the account you created.
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
              onChangeText={(value) => {
                setPhrase(value);
                if (error) setError(null);
              }}
              placeholder="word one word two ..."
              placeholderTextColor={c.ink4}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              textContentType="none"
              returnKeyType="done"
              editable={!verifying}
              testID="phrase-not-confirmed-input"
              accessibilityLabel="Recovery phrase field"
            />
            <Text style={styles.counter}>{words.length}/{RECOVERY_WORD_COUNT} words</Text>

            <View style={styles.buttonStack}>
              <TouchableOpacity
                style={[styles.button, styles.primaryButton, !canSubmit && styles.buttonDisabled]}
                onPress={() => { void handleVerify(); }}
                activeOpacity={0.82}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit, busy: verifying }}
                testID="phrase-not-confirmed-submit"
              >
                {verifying ? <ActivityIndicator color={c.ink} /> : <Text style={styles.buttonText}>Verify phrase</Text>}
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.backRow}
              onPress={() => { setStep('choice'); setError(null); }}
              activeOpacity={0.7}
              disabled={verifying}
            >
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
