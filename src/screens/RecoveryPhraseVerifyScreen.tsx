import { BBLogo } from "../components/BBLogo";
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
import { colors, radii, spacing } from '../theme';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'RecoveryPhraseVerify'>;

function pickVerifyPositions(length: number): number[] {
  const positions: number[] = [];
  while (positions.length < 3) {
    const n = Math.floor(Math.random() * length);
    if (!positions.includes(n)) positions.push(n);
  }
  return positions.sort((a, b) => a - b);
}

export default function RecoveryPhraseVerifyScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const insets = useSafeAreaInsets();

  const { phrase } = route.params;
  const positions = useMemo(() => pickVerifyPositions(phrase.length), [phrase.length]);

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

  function handleVerify() {
    const allCorrect = positions.every(
      (pos, i) => answers[i] === phrase[pos].toLowerCase()
    );
    if (!allCorrect) {
      setError("One or more words don't match. Check your phrase and try again.");
      return;
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
                placeholderTextColor={colors.ink4}
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
          onPress={handleVerify}
          activeOpacity={0.8}
          disabled={answers.some((a) => !a)}
        >
          <Text style={styles.buttonText}>Confirm and continue</Text>
        </TouchableOpacity>

        {/* Back */}
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.xl },

  logoRow: { alignItems: 'center', marginBottom: 22 },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: colors.amber, fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },

  heading: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    letterSpacing: -0.3,
    marginBottom: 6,
  },
  subheading: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 24,
  },

  errorBanner: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: { fontSize: 12, color: colors.red, lineHeight: 17 },

  inputsCard: {
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    marginBottom: 24,
    overflow: 'hidden',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  inputRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  posLabel: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  posNumber: { fontSize: 12, fontWeight: '700', color: colors.ink3 },
  input: {
    flex: 1,
    height: 36,
    fontSize: 14,
    color: colors.ink,
    fontFamily: 'SpaceMono',
  },
  inputError: { color: colors.red },

  button: {
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 14,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 15, fontWeight: '700', color: colors.amber },

  backRow: { alignItems: 'center', paddingVertical: 4 },
  backText: { fontSize: 13, color: colors.ink4 },
});
