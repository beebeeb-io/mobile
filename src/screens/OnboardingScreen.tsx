import { BBLogo } from "../components/BBLogo";
import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing } from '../theme';

// ---------------------------------------------------------------------------
// 256-word BIP-39 inspired wordlist for placeholder phrases
// ---------------------------------------------------------------------------

const WORDLIST = [
  'abandon','ability','able','about','above','absent','absorb','abstract',
  'absurd','abuse','access','accident','account','accuse','achieve','acid',
  'acoustic','acquire','across','actor','adapt','add','addict','address',
  'adjust','admit','adult','advance','advice','aerobic','afford','afraid',
  'again','agent','agree','ahead','aim','air','airport','aisle',
  'album','alert','alien','all','alley','allow','almost','alone',
  'alpha','already','also','alter','always','amateur','amazing','among',
  'amount','amused','analyst','anchor','ancient','anger','angle','angry',
  'animal','ankle','announce','annual','another','answer','antenna','antique',
  'anxiety','apart','apology','appear','apple','approve','april','arch',
  'arctic','arena','argue','arm','armor','army','around','arrange',
  'arrest','arrive','arrow','art','artefact','artist','aspect','assist',
  'asset','atlas','atom','attack','attend','attitude','attract','auction',
  'audit','august','aunt','author','auto','autumn','average','avocado',
  'avoid','awake','aware','away','awesome','awful','awkward','axis',
  'balance','bamboo','banana','banner','barely','bargain','barrel','base',
  'basic','basket','battle','beach','beauty','because','become','beef',
  'before','begin','behave','behind','believe','below','belt','bench',
  'benefit','best','betray','better','between','beyond','bicycle','bird',
  'birth','bitter','black','blade','blame','blanket','blast','bleak',
  'bless','blind','blood','blossom','blouse','blue','blur','blush',
  'board','boat','body','boil','bomb','bone','bonus','book',
  'boost','border','boring','borrow','bounce','brain','brand','brave',
  'breeze','brick','bridge','brief','bright','bring','brisk','broccoli',
  'broken','bronze','broom','brother','brown','brush','bubble','buddy',
  'budget','buffalo','build','bulb','bulk','bullet','bundle','bunker',
  'burden','burger','burst','bus','business','busy','butter','buyer',
];

function generatePhrase(): string[] {
  const words: string[] = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.floor(Math.random() * WORDLIST.length);
    words.push(WORDLIST[idx]);
  }
  return words;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function OnboardingScreen({ onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const phrase = useMemo(() => generatePhrase(), []);
  const [confirmed, setConfirmed] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
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
          Write down these 12 words in order and keep them somewhere safe.
        </Text>

        {/* Warning */}
        <View style={styles.warning}>
          <View style={styles.warningDot} />
          <Text style={styles.warningText}>
            If you lose your device and this phrase, your data is gone forever. We cannot recover it.
          </Text>
        </View>

        {/* Phrase grid */}
        <View style={styles.phraseCard}>
          {revealed ? (
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
              style={styles.revealButton}
              onPress={() => setRevealed(true)}
              activeOpacity={0.8}
            >
              <View style={styles.revealBlur}>
                {/* Blurred placeholder rows */}
                {[0, 1, 2].map((row) => (
                  <View key={row} style={styles.blurRow}>
                    {[0, 1, 2, 3].map((col) => (
                      <View key={col} style={styles.blurCell} />
                    ))}
                  </View>
                ))}
              </View>
              <View style={styles.revealOverlay}>
                <Text style={styles.revealIcon}>{'⊙'}</Text>
                <Text style={styles.revealLabel}>Tap to reveal</Text>
                <Text style={styles.revealSub}>Make sure no one is looking</Text>
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* Copy hint */}
        {revealed && (
          <Text style={styles.copyHint}>
            Write these down — never screenshot or copy to clipboard.
          </Text>
        )}

        {/* Confirmation checkbox */}
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setConfirmed(!confirmed)}
          activeOpacity={0.7}
          disabled={!revealed}
        >
          <View style={[styles.checkbox, confirmed && styles.checkboxChecked, !revealed && styles.checkboxDisabled]}>
            {confirmed && <Text style={styles.checkmark}>{'✓'}</Text>}
          </View>
          <Text style={[styles.checkLabel, !revealed && styles.checkLabelDisabled]}>
            I've written down my recovery phrase and stored it safely.
          </Text>
        </TouchableOpacity>

        {/* Continue button */}
        <TouchableOpacity
          style={[styles.continueButton, (!confirmed || !revealed) && styles.continueButtonDisabled]}
          onPress={onComplete}
          activeOpacity={0.8}
          disabled={!confirmed || !revealed}
        >
          <Text style={styles.continueButtonText}>Continue to Beebeeb</Text>
        </TouchableOpacity>

        {/* Skip (for testing/returning users) */}
        <TouchableOpacity style={styles.skipRow} onPress={onComplete}>
          <Text style={styles.skipText}>I'll do this later (not recommended)</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper2 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.lg, paddingBottom: 32 },

  logoRow: { alignItems: 'center', paddingTop: 24, marginBottom: 20 },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    color: colors.amber,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

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
    lineHeight: 18,
    marginBottom: 16,
  },

  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#fff9e6',
    borderWidth: 1,
    borderColor: '#f0d060',
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
    gap: 8,
  },
  warningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amberDeep,
    marginTop: 5,
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
    marginBottom: 10,
  },

  // Revealed grid
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
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  wordNum: {
    fontSize: 9,
    color: colors.ink4,
    fontWeight: '600',
    marginBottom: 2,
  },
  wordText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.ink,
    textAlign: 'center',
  },

  // Hidden state
  revealButton: {
    position: 'relative',
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
  },
  revealBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    gap: 8,
    opacity: 0.15,
  },
  blurRow: { flexDirection: 'row', gap: 8 },
  blurCell: {
    flex: 1,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.ink3,
  },
  revealOverlay: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 24,
  },
  revealIcon: { fontSize: 24, color: colors.ink2 },
  revealLabel: { fontSize: 14, fontWeight: '600', color: colors.ink },
  revealSub: { fontSize: 11, color: colors.ink3 },

  copyHint: {
    fontSize: 11,
    color: colors.amberDeep,
    textAlign: 'center',
    marginBottom: 16,
    fontWeight: '500',
  },

  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 20,
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
  checkboxDisabled: {
    opacity: 0.4,
  },
  checkmark: { fontSize: 11, color: colors.ink, fontWeight: '700' },
  checkLabel: {
    flex: 1,
    fontSize: 13,
    color: colors.ink2,
    lineHeight: 18,
  },
  checkLabelDisabled: { opacity: 0.4 },

  continueButton: {
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  continueButtonDisabled: { opacity: 0.4 },
  continueButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.amber,
  },

  skipRow: { alignItems: 'center', paddingVertical: 4 },
  skipText: { fontSize: 12, color: colors.ink4 },
});
