import { BBLogo } from "../components/BBLogo";
import React, { useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'RecoveryPhrase'>;

export default function RecoveryPhraseScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();

  // The phrase is generated in SignupScreen via the native crypto module and
  // passed in via navigation params. If it's missing, the native module is not
  // linked (e.g. running in Expo Go) — never substitute fake words, since users
  // would write them down and lose access to their real recovery material.
  const phrase = route.params?.phrase ?? [];
  const phraseUnavailable = phrase.length === 0;

  const [revealed, setRevealed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  function handleContinue() {
    navigation.navigate('RecoveryPhraseVerify', { phrase });
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <View style={styles.logoRow}>
          <View style={styles.logo}>
            <BBLogo size={48} />
          </View>
        </View>

        <Text style={styles.heading}>Your recovery phrase</Text>
        <Text style={styles.subheading}>
          Write down these 12 words in order and store them somewhere safe — not on this device.
        </Text>

        {/* Warning */}
        <View style={[styles.warning, { backgroundColor: c.amberBg, borderColor: c.amber }]}>
          <View style={styles.warningBar} />
          <Text style={styles.warningText}>
            We cannot recover this. If you lose your device and this phrase, your data is gone permanently.
          </Text>
        </View>

        {/* Phrase card */}
        <View style={styles.phraseCard}>
          {phraseUnavailable ? (
            <View style={styles.unavailableArea}>
              <Text style={styles.unavailableTitle}>Recovery phrase not available</Text>
              <Text style={styles.unavailableBody}>
                Recovery phrase generation requires the native crypto module. Build with{' '}
                <Text style={styles.codeInline}>npx expo run:ios</Text> (or{' '}
                <Text style={styles.codeInline}>run:android</Text>) for full encryption.
              </Text>
              <Text style={styles.unavailableBody}>
                Your account currently uses server-side password authentication — you can sign in
                normally, but end-to-end encryption is disabled until the native module is linked.
              </Text>
            </View>
          ) : revealed ? (
            <View style={styles.grid}>
              {phrase.map((word, i) => (
                <View key={i} style={styles.wordCell}>
                  <Text style={styles.wordNum}>{i + 1}</Text>
                  <Text style={styles.wordText}>{word}</Text>
                </View>
              ))}
            </View>
          ) : (
            <TouchableOpacity
              style={styles.revealArea}
              onPress={() => setRevealed(true)}
              activeOpacity={0.85}
            >
              {/* Blurred grid placeholders */}
              <View style={styles.blurGrid}>
                {[0, 1, 2].map((row) => (
                  <View key={row} style={styles.blurRow}>
                    {[0, 1, 2, 3].map((col) => (
                      <View key={col} style={styles.blurCell} />
                    ))}
                  </View>
                ))}
              </View>
              {/* Overlay prompt */}
              <View style={styles.revealOverlay}>
                <View style={styles.revealIcon}>
                  <View style={styles.revealIconOuter}>
                    <View style={styles.revealIconInner} />
                  </View>
                </View>
                <Text style={styles.revealLabel}>Tap to reveal</Text>
                <Text style={styles.revealSub}>Make sure no one is watching</Text>
              </View>
            </TouchableOpacity>
          )}
        </View>

        {revealed && !phraseUnavailable && (
          <Text style={styles.copyWarning}>
            Write these down. Never screenshot or copy to clipboard.
          </Text>
        )}

        {/* Confirmation checkbox */}
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setConfirmed(!confirmed)}
          activeOpacity={0.7}
          disabled={!revealed || phraseUnavailable}
        >
          <View style={[
            styles.checkbox,
            confirmed && styles.checkboxChecked,
            (!revealed || phraseUnavailable) && styles.checkboxMuted,
          ]}>
            {confirmed && <Text style={styles.checkmark}>✓</Text>}
          </View>
          <Text style={[styles.checkLabel, (!revealed || phraseUnavailable) && styles.checkLabelMuted]}>
            I've written down my recovery phrase and stored it safely.
          </Text>
        </TouchableOpacity>

        {/* Continue */}
        <TouchableOpacity
          style={[styles.button, (!confirmed || !revealed || phraseUnavailable) && styles.buttonDisabled]}
          onPress={handleContinue}
          activeOpacity={0.8}
          disabled={!confirmed || !revealed || phraseUnavailable}
        >
          <Text style={styles.buttonText}>Verify my phrase</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper2 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: 36 },

  logoRow: { alignItems: 'center', paddingTop: 28, marginBottom: 22 },
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
    marginBottom: 18,
  },

  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.amberBg,
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 18,
    gap: 10,
  },
  warningBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.amberDeep,
    alignSelf: 'stretch',
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    color: colors.ink2,
    lineHeight: 17,
    fontWeight: '500',
  },

  phraseCard: {
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
    marginBottom: 12,
  },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 12,
    gap: 8,
  },
  wordCell: {
    width: '23%',
    backgroundColor: colors.paper2,
    borderRadius: radii.sm,
    paddingVertical: 9,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  wordNum: {
    fontSize: 9,
    color: colors.ink4,
    fontWeight: '600',
    marginBottom: 3,
  },
  wordText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.ink,
    textAlign: 'center',
  },

  revealArea: {
    minHeight: 148,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  blurGrid: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    padding: 12,
    gap: 8,
    opacity: 0.12,
  },
  blurRow: { flexDirection: 'row', gap: 8 },
  blurCell: { flex: 1, height: 34, borderRadius: radii.sm, backgroundColor: colors.ink3 },

  revealOverlay: { alignItems: 'center', gap: 6, paddingVertical: 28 },
  revealIcon: { marginBottom: 4 },
  revealIconOuter: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.ink2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealIconInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.ink2,
  },
  revealLabel: { fontSize: 14, fontWeight: '600', color: colors.ink },
  revealSub: { fontSize: 11, color: colors.ink3 },

  unavailableArea: {
    paddingVertical: 28,
    paddingHorizontal: 18,
    alignItems: 'center',
    gap: 6,
  },
  unavailableTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    textAlign: 'center',
  },
  unavailableBody: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: spacing.md,
    marginTop: 6,
  },
  codeInline: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    color: colors.ink2,
  },

  copyWarning: {
    fontSize: 11,
    color: colors.amberDeep,
    textAlign: 'center',
    fontWeight: '500',
    marginBottom: 16,
  },

  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 22,
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
  checkboxChecked: { backgroundColor: colors.amber, borderColor: colors.amber },
  checkboxMuted: { opacity: 0.4 },
  checkmark: { fontSize: 11, color: colors.ink, fontWeight: '700' },
  checkLabel: { flex: 1, fontSize: 13, color: colors.ink2, lineHeight: 18 },
  checkLabelMuted: { opacity: 0.4 },

  button: {
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    paddingVertical: 15,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 15, fontWeight: '700', color: colors.amber },
});
