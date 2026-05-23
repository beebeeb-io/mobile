import { BBLogo } from "../components/BBLogo";
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useAuth } from '../lib/auth';
import { useCrypto } from '../lib/crypto-context';
import { mountTrustedFileProvider, populateFileProviderCache } from '../lib/file-provider-mount';
import { useToast } from '../lib/toast-context';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'RecoveryPhrase'>;
type Step = 'phrase' | 'verify' | 'files' | 'done';

interface Props {
  route?: Route;
  navigation?: Nav;
  phrase?: string[];
  onComplete?: () => void;
}

function normalizeWords(phrase?: string[]): string[] {
  return (phrase ?? [])
    .flatMap((part) => part.split(/\s+/))
    .map((word) => word.trim())
    .filter(Boolean);
}

function hashWords(words: string[]): number {
  let hash = 2166136261;
  for (const char of words.join(' ').toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickVerifyPositions(words: string[]): number[] {
  const count = Math.min(3, words.length);
  const available = words.map((_, index) => index);
  const positions: number[] = [];
  let seed = hashWords(words);

  while (positions.length < count && available.length > 0) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const index = seed % available.length;
    positions.push(available.splice(index, 1)[0]);
  }

  return positions.sort((a, b) => a - b);
}

export default function OnboardingScreen({ route, navigation, phrase: phraseProp, onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const { markPhraseVerified } = useAuth();
  const crypto = useCrypto();
  const { showToast } = useToast();
  const words = useMemo(
    () => normalizeWords(phraseProp ?? route?.params?.phrase),
    [phraseProp, route?.params?.phrase],
  );
  const verifyPositions = useMemo(() => pickVerifyPositions(words), [words]);
  const [step, setStep] = useState<Step>('phrase');
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [copied, setCopied] = useState(false);
  const [mountingFiles, setMountingFiles] = useState(false);
  const phraseReady = words.length === 12;

  const styles = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: spacing.lg,
      paddingTop: insets.top + 22,
      paddingBottom: insets.bottom + 28,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.xl,
    },
    logoWrap: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: c.ink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    progress: {
      marginLeft: 'auto',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    progressBar: {
      width: 28,
      height: 4,
      borderRadius: 2,
    },
    progressText: {
      marginLeft: 4,
      color: c.ink3,
      fontSize: 12,
      fontWeight: '600',
    },
    eyebrow: {
      color: c.ink3,
      fontSize: 12,
      fontWeight: '700',
      marginBottom: spacing.sm,
      textTransform: 'uppercase',
    },
    heading: {
      color: c.ink,
      fontSize: 25,
      fontWeight: '800',
      letterSpacing: -0.2,
      marginBottom: spacing.sm,
    },
    body: {
      color: c.ink2,
      fontSize: 15,
      lineHeight: 22,
      marginBottom: spacing.lg,
    },
    phraseGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      padding: spacing.md,
      backgroundColor: c.paper2,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: c.line,
      marginBottom: spacing.md,
    },
    wordCell: {
      width: '47%',
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: c.paper,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: c.line,
    },
    wordNumber: {
      minWidth: 24,
      color: c.ink4,
      fontSize: 12,
      fontFamily: fonts.mono,
      fontVariant: ['tabular-nums'],
    },
    wordText: {
      flex: 1,
      color: c.ink,
      fontSize: 15,
      fontFamily: fonts.mono,
      fontWeight: '700',
    },
    warning: {
      padding: spacing.md,
      backgroundColor: c.amberBg,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: c.amber,
      marginBottom: spacing.lg,
    },
    warningText: {
      color: c.ink,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: '700',
    },
    inputGroup: {
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    inputLabel: {
      color: c.ink2,
      fontSize: 13,
      fontWeight: '700',
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    input: {
      flex: 1,
      height: 46,
      borderWidth: 1,
      borderColor: c.line,
      borderRadius: radii.md,
      backgroundColor: c.paper2,
      color: c.ink,
      fontSize: 15,
      fontFamily: fonts.mono,
      paddingHorizontal: spacing.md,
    },
    inputCorrect: { borderColor: c.green },
    inputIncorrect: { borderColor: c.red },
    status: {
      width: 28,
      textAlign: 'center',
      fontSize: 18,
      fontWeight: '800',
    },
    statusCorrect: { color: c.green },
    statusIncorrect: { color: c.red },
    missingCard: {
      padding: spacing.lg,
      backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
      borderWidth: 1,
      borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
      borderRadius: radii.lg,
      marginBottom: spacing.lg,
    },
    missingText: {
      color: c.red,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: '600',
    },
    spacer: { flex: 1, minHeight: spacing.lg },
    button: {
      minHeight: 48,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    primaryButton: { backgroundColor: c.amber },
    secondaryButton: {
      backgroundColor: c.paper,
      borderWidth: 1,
      borderColor: c.line,
    },
    buttonDisabled: { opacity: 0.45 },
    buttonText: {
      color: c.ink,
      fontSize: 15,
      fontWeight: '800',
      textAlign: 'center',
    },
    secondaryButtonText: {
      color: c.ink2,
      fontSize: 15,
      fontWeight: '700',
      textAlign: 'center',
    },
    buttonStack: { gap: spacing.md },
    doneCard: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 220,
      padding: spacing.xl,
      backgroundColor: c.paper2,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: c.line,
      marginBottom: spacing.xl,
    },
    doneMark: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.amberBg,
      borderWidth: 1,
      borderColor: c.amber,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.lg,
    },
    doneMarkText: {
      color: c.amberDeep,
      fontSize: 28,
      fontWeight: '900',
    },
    filesMarkText: {
      color: c.amberDeep,
      fontSize: 13,
      fontWeight: '900',
    },
  }), [c, insets.bottom, insets.top, resolved]);

  const stepNumber = step === 'phrase' ? 1 : step === 'verify' ? 2 : step === 'files' ? 3 : 4;
  const normalizedAnswers = answers.map((answer) => answer.trim().toLowerCase());
  const correctAnswers = verifyPositions.map(
    (position, index) => normalizedAnswers[index] === words[position]?.toLowerCase(),
  );
  const allCorrect = phraseReady && verifyPositions.length === 3 && correctAnswers.every(Boolean);

  async function handleCopyWords() {
    if (!phraseReady) return;
    await Clipboard.setStringAsync(words.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    // Auto-clear clipboard after 60 seconds to limit exposure of recovery phrase
    setTimeout(() => Clipboard.setStringAsync(''), 60000);
  }

  function setAnswer(index: number, value: string) {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  async function handleConfirm() {
    if (!allCorrect) return;
    await markPhraseVerified();
    if (Platform.OS === 'ios') {
      setStep('files');
      return;
    }
    setStep('done');
  }

  async function handleMountFiles() {
    setMountingFiles(true);
    try {
      const result = await mountTrustedFileProvider({ vaultUnlocked: crypto.isUnlocked });
      const mounted = result.supported && result.registered && result.cacheDatabaseReady !== false;
      if (!mounted) {
        Alert.alert('Files unavailable', 'Beebeeb could not be mounted in Files on this device. You can try again later in Settings.');
        return;
      }
      if (crypto.isUnlocked) {
        void populateFileProviderCache(crypto.decryptMetadata).catch(() => {});
      }
      showToast({ type: 'success', message: 'Beebeeb is mounted in Files' });
      setStep('done');
    } catch (err) {
      Alert.alert('Files mount failed', err instanceof Error ? err.message : 'Try again later from Settings.');
    } finally {
      setMountingFiles(false);
    }
  }

  function handleGoToVault() {
    if (navigation) {
      navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      return;
    }
    onComplete?.();
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
        <View style={styles.header}>
          <View style={styles.logoWrap}>
            <BBLogo size={48} />
          </View>
          <View style={styles.progress} accessibilityLabel={`Step ${stepNumber} of 4`}>
            {[1, 2, 3, 4].map((item) => (
              <View
                key={item}
                style={[
                  styles.progressBar,
                  { backgroundColor: item <= stepNumber ? c.ink : c.line2 },
                ]}
              />
            ))}
            <Text style={styles.progressText}>{stepNumber} / 4</Text>
          </View>
        </View>

        {step === 'phrase' && (
          <>
            <Text style={styles.eyebrow}>Recovery phrase</Text>
            <Text style={styles.heading}>Your recovery phrase</Text>
            <Text style={styles.body}>
              Write down these words in order and store them somewhere safe.
            </Text>

            {!phraseReady && (
              <View style={styles.missingCard}>
                <Text style={styles.missingText}>
                  Recovery phrase is not available. Create the account again with the native encryption module enabled.
                </Text>
              </View>
            )}

            {phraseReady && (
              <>
                <View style={styles.phraseGrid}>
                  {words.map((word, index) => (
                    <View key={`${word}-${index}`} style={styles.wordCell}>
                      <Text style={styles.wordNumber}>
                        {String(index + 1).padStart(2, '0')}
                      </Text>
                      <Text style={styles.wordText} selectable>
                        {word}
                      </Text>
                    </View>
                  ))}
                </View>

                <View style={styles.buttonStack}>
                  <TouchableOpacity
                    style={[styles.button, styles.primaryButton]}
                    onPress={() => { void handleCopyWords(); }}
                    activeOpacity={0.82}
                    accessibilityRole="button"
                    accessibilityLabel="Copy all recovery words"
                  >
                    <Text style={styles.buttonText}>
                      {copied ? 'Copied' : 'Copy all words'}
                    </Text>
                  </TouchableOpacity>

                  <View style={styles.warning}>
                    <Text style={styles.warningText}>
                      These 12 words are the ONLY way to recover your vault if you lose access. Write them down.
                    </Text>
                  </View>
                </View>
              </>
            )}

            <View style={styles.spacer} />
            <TouchableOpacity
              style={[styles.button, styles.primaryButton, !phraseReady && styles.buttonDisabled]}
              onPress={() => setStep('verify')}
              activeOpacity={0.82}
              disabled={!phraseReady}
              accessibilityRole="button"
              accessibilityState={{ disabled: !phraseReady }}
            >
              <Text style={styles.buttonText}>I've saved my recovery phrase</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'verify' && (
          <>
            <Text style={styles.eyebrow}>Verification</Text>
            <Text style={styles.heading}>Verify your phrase</Text>
            <Text style={styles.body}>
              Enter the requested words to confirm you saved your recovery phrase.
            </Text>

            {verifyPositions.map((position, index) => {
              const hasAnswer = normalizedAnswers[index].length > 0;
              const isCorrect = correctAnswers[index];
              return (
                <View key={position} style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Enter word #{position + 1}</Text>
                  <View style={styles.inputRow}>
                    <TextInput
                      style={[
                        styles.input,
                        hasAnswer && (isCorrect ? styles.inputCorrect : styles.inputIncorrect),
                      ]}
                      value={answers[index]}
                      onChangeText={(value) => setAnswer(index, value)}
                      placeholder={`Word #${position + 1}`}
                      placeholderTextColor={c.ink4}
                      autoCapitalize="none"
                      autoCorrect={false}
                      textContentType="none"
                      returnKeyType={index < verifyPositions.length - 1 ? 'next' : 'done'}
                      accessibilityLabel={`Enter word number ${position + 1}`}
                    />
                    <Text
                      style={[
                        styles.status,
                        hasAnswer && (isCorrect ? styles.statusCorrect : styles.statusIncorrect),
                      ]}
                      accessibilityLabel={
                        !hasAnswer
                          ? 'Not answered'
                          : isCorrect
                            ? 'Correct word'
                            : 'Incorrect word'
                      }
                    >
                      {hasAnswer ? (isCorrect ? '✓' : '×') : ''}
                    </Text>
                  </View>
                </View>
              );
            })}

            <View style={styles.spacer} />
            <View style={styles.buttonStack}>
              <TouchableOpacity
                style={[styles.button, styles.primaryButton, !allCorrect && styles.buttonDisabled]}
                onPress={() => { void handleConfirm(); }}
                activeOpacity={0.82}
                disabled={!allCorrect}
                accessibilityRole="button"
                accessibilityState={{ disabled: !allCorrect }}
              >
                <Text style={styles.buttonText}>Confirm</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={() => setStep('phrase')}
                activeOpacity={0.78}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>Back to recovery phrase</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {step === 'files' && (
          <>
            <Text style={styles.eyebrow}>Files access</Text>
            <Text style={styles.heading}>Mount Beebeeb in Files</Text>
            <Text style={styles.body}>
              Add Beebeeb to iOS Files on this trusted iPhone. Anyone who can unlock this iPhone can access the mounted Files location until you remove access in Settings.
            </Text>

            <View style={styles.doneCard}>
              <View style={styles.doneMark}>
                <Text style={styles.filesMarkText}>Files</Text>
              </View>
              <Text style={[styles.heading, { textAlign: 'center' }]}>Enable Files access</Text>
              <Text style={[styles.body, { textAlign: 'center', marginBottom: 0 }]}>
                iOS will ask for Face ID or your iPhone passcode once before mounting Beebeeb in Files.
              </Text>
            </View>

            <View style={styles.spacer} />
            <View style={styles.buttonStack}>
              <TouchableOpacity
                style={[styles.button, styles.primaryButton, mountingFiles && styles.buttonDisabled]}
                onPress={() => { void handleMountFiles(); }}
                activeOpacity={0.82}
                disabled={mountingFiles}
                accessibilityRole="button"
                accessibilityState={{ disabled: mountingFiles }}
              >
                {mountingFiles ? (
                  <ActivityIndicator color={c.ink} />
                ) : (
                  <Text style={styles.buttonText}>Enable Files access</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={() => setStep('done')}
                activeOpacity={0.78}
                accessibilityRole="button"
                disabled={mountingFiles}
              >
                <Text style={styles.secondaryButtonText}>Not now</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {step === 'done' && (
          <>
            <View style={styles.doneCard}>
              <View style={styles.doneMark}>
                <Text style={styles.doneMarkText}>✓</Text>
              </View>
              <Text style={[styles.heading, { textAlign: 'center' }]}>Your vault is secure</Text>
              <Text style={[styles.body, { textAlign: 'center', marginBottom: 0 }]}>
                Your files are encrypted on your device. Even we can't access them.
              </Text>
            </View>
            <View style={styles.spacer} />
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={handleGoToVault}
              activeOpacity={0.82}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>Go to my vault</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
