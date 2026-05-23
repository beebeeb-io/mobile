/**
 * Two-Factor Authentication setup screen.
 *
 * Step 1 — Show TOTP secret + copy button. User adds key to authenticator app.
 * Step 2 — 6-digit code entry. Calls enableTotp(code) to activate.
 * Step 3 — Backup codes display + copy all. Navigate back on Done.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { fonts, spacing, type Colors } from '../theme';
import { setupTotp, enableTotp, friendlyError, type TotpSetup } from '../lib/api';

let Clipboard: { setStringAsync: (s: string) => Promise<void> } = {
  setStringAsync: async () => {},
};
try {
  Clipboard = require('expo-clipboard');
} catch {}

type C = Colors;
type Step = 1 | 2 | 3;

// ── Layout ────────────────────────────────────────────────────────────────────

const layout = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingBottom: 48 },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  header: { marginBottom: 24, marginTop: 8 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  subtitle: { fontSize: 14, lineHeight: 20 },
  section: { marginBottom: 20 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden', padding: 16 },
  secretBox: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  secretText: {
    fontSize: 18,
    letterSpacing: 2,
    textAlign: 'center',
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'center',
    gap: 6,
  },
  copyButtonText: { fontSize: 14, fontWeight: '600' },
  instructionText: { fontSize: 13, lineHeight: 19, marginTop: 12 },
  otpRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 8, marginBottom: 16 },
  otpBox: {
    width: 44,
    height: 52,
    borderRadius: 8,
    borderWidth: 1.5,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  primaryButton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '700' },
  backupGrid: { gap: 8 },
  backupRow: { flexDirection: 'row', gap: 8 },
  backupCode: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    textAlign: 'center',
  },
  noteText: { fontSize: 12, lineHeight: 17, marginTop: 12 },
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 20,
  },
  stepDot: { width: 6, height: 6, borderRadius: 3 },
});

// ── Sub-components ────────────────────────────────────────────────────────────

function StepIndicator({ step, c }: { step: Step; c: C }) {
  return (
    <View style={layout.stepIndicator}>
      {([1, 2, 3] as Step[]).map(s => (
        <View
          key={s}
          style={[
            layout.stepDot,
            { backgroundColor: s === step ? c.amber : c.line2 },
          ]}
        />
      ))}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
  c,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  c: C;
}) {
  return (
    <TouchableOpacity
      style={[
        layout.primaryButton,
        { backgroundColor: disabled ? c.line : c.amber },
      ]}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      disabled={disabled || loading}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {loading ? (
        <ActivityIndicator color={c.black} />
      ) : (
        <Text style={[layout.primaryButtonText, { color: disabled ? c.ink3 : c.black }]}>
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function CopyButton({
  label,
  onPress,
  c,
}: {
  label: string;
  onPress: () => void;
  c: C;
}) {
  return (
    <TouchableOpacity
      style={[layout.copyButton, { borderColor: c.line2 }]}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name="copy-outline" size={15} color={c.amber} />
      <Text style={[layout.copyButtonText, { color: c.amber }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Step 1: Show secret ───────────────────────────────────────────────────────

function StepSecret({
  setup,
  onContinue,
  c,
}: {
  setup: TotpSetup;
  onContinue: () => void;
  c: C;
}) {
  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(setup.secret);
    Alert.alert('Copied', 'Secret key copied to clipboard.');
    // Auto-clear clipboard after 60 seconds to limit exposure of TOTP secret
    setTimeout(() => Clipboard.setStringAsync(''), 60000);
  }, [setup.secret]);

  return (
    <>
      <View style={layout.header}>
        <Text style={[layout.title, { color: c.ink, fontFamily: fonts.sans }]}>
          Set up authenticator
        </Text>
        <Text style={[layout.subtitle, { color: c.ink3, fontFamily: fonts.sans }]}>
          Open Google Authenticator, Authy, or 1Password and scan or enter this key.
        </Text>
      </View>

      <View style={layout.section}>
        <View style={[layout.secretBox, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <Text
            style={[layout.secretText, { color: c.ink, fontFamily: fonts.mono }]}
            selectable
          >
            {setup.secret}
          </Text>
        </View>
        <CopyButton label="Copy secret" onPress={handleCopy} c={c} />
        <Text style={[layout.instructionText, { color: c.ink3, fontFamily: fonts.sans }]}>
          After adding the key, your authenticator app will display a 6-digit code that changes
          every 30 seconds. You will verify it on the next step.
        </Text>
      </View>

      <PrimaryButton label="Continue" onPress={onContinue} c={c} />
    </>
  );
}

// ── Step 2: Verify code ───────────────────────────────────────────────────────

function StepVerify({
  onSuccess,
  c,
}: {
  onSuccess: () => void;
  c: C;
}) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  const code = digits.join('');
  const ready = code.length === 6;

  const handleChange = useCallback((index: number, value: string) => {
    // Handle paste of full 6-digit code
    const clean = value.replace(/\D/g, '');
    if (clean.length === 6) {
      setDigits(clean.split(''));
      inputRefs.current[5]?.focus();
      return;
    }
    const single = clean.slice(-1);
    setDigits(prev => {
      const next = [...prev];
      next[index] = single;
      return next;
    });
    if (single && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handleKeyPress = useCallback((index: number, key: string) => {
    if (key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }, [digits]);

  const handleEnable = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      await enableTotp(code);
      onSuccess();
    } catch (err) {
      Alert.alert('Verification failed', friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [code, ready, onSuccess]);

  return (
    <>
      <View style={layout.header}>
        <Text style={[layout.title, { color: c.ink, fontFamily: fonts.sans }]}>
          Verify
        </Text>
        <Text style={[layout.subtitle, { color: c.ink3, fontFamily: fonts.sans }]}>
          Enter the 6-digit code from your authenticator app to confirm it is set up correctly.
        </Text>
      </View>

      <View style={layout.section}>
        <View style={layout.otpRow}>
          {digits.map((digit, i) => (
            <TextInput
              key={i}
              ref={ref => { inputRefs.current[i] = ref; }}
              style={[
                layout.otpBox,
                {
                  color: c.ink,
                  borderColor: digit ? c.amber : c.line,
                  backgroundColor: c.paper2,
                  fontFamily: fonts.mono,
                },
              ]}
              value={digit}
              onChangeText={val => handleChange(i, val)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(i, nativeEvent.key)}
              keyboardType="number-pad"
              maxLength={6}
              caretHidden
              selectTextOnFocus
              accessibilityLabel={`Digit ${i + 1}`}
            />
          ))}
        </View>
      </View>

      <PrimaryButton
        label="Enable 2FA"
        onPress={handleEnable}
        loading={loading}
        disabled={!ready}
        c={c}
      />
    </>
  );
}

// ── Step 3: Backup codes ──────────────────────────────────────────────────────

function StepBackupCodes({
  codes,
  onDone,
  c,
}: {
  codes: string[];
  onDone: () => void;
  c: C;
}) {
  const handleCopyAll = useCallback(async () => {
    await Clipboard.setStringAsync(codes.join('\n'));
    Alert.alert('Copied', 'All backup codes copied to clipboard.');
    // Auto-clear clipboard after 60 seconds to limit exposure of backup codes
    setTimeout(() => Clipboard.setStringAsync(''), 60000);
  }, [codes]);

  // Render codes in pairs
  const pairs: string[][] = [];
  for (let i = 0; i < codes.length; i += 2) {
    pairs.push(codes.slice(i, i + 2));
  }

  return (
    <>
      <View style={layout.header}>
        <Text style={[layout.title, { color: c.ink, fontFamily: fonts.sans }]}>
          Backup codes
        </Text>
        <Text style={[layout.subtitle, { color: c.ink3, fontFamily: fonts.sans }]}>
          Two-factor authentication is now active. Save these codes somewhere safe — each one can
          be used once if you lose access to your authenticator app.
        </Text>
      </View>

      <View style={[layout.section, layout.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
        <View style={layout.backupGrid}>
          {pairs.map((pair, rowIndex) => (
            <View key={rowIndex} style={layout.backupRow}>
              {pair.map((code, colIndex) => (
                <Text
                  key={colIndex}
                  style={[layout.backupCode, { color: c.ink, fontFamily: fonts.mono, borderColor: c.line, backgroundColor: c.paper }]}
                  selectable
                >
                  {code}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </View>

      <CopyButton label="Copy all codes" onPress={handleCopyAll} c={c} />

      <Text style={[layout.noteText, { color: c.ink3, fontFamily: fonts.sans, marginBottom: 20 }]}>
        These codes will not be shown again. Store them in a password manager or print them out.
      </Text>

      <PrimaryButton label="Done" onPress={onDone} c={c} />
    </>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function TwoFactorSetupScreen() {
  // Block screenshots/screen recording — this screen shows the TOTP secret,
  // QR code, and one-time backup codes that can each break 2FA if leaked.
  usePreventScreenCapture('two-factor-setup');
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();

  const [step, setStep] = useState<Step>(1);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Fetch secret on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingSetup(true);
    setupTotp()
      .then(data => {
        if (!cancelled) setSetup(data);
      })
      .catch(err => {
        if (!cancelled) setSetupError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingSetup(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleDone = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  return (
    <View
      style={[layout.root, { backgroundColor: c.paper, paddingTop: insets.top }]}
    >
      <ScrollView
        style={layout.scroll}
        contentContainerStyle={[
          layout.scrollContent,
          { paddingTop: spacing.md },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Back button */}
        <TouchableOpacity
          style={layout.backButton}
          onPress={() => {
            Haptics.selectionAsync();
            if (step > 1) {
              // Only allow going back from step 1 (steps 2-3 are forward-only after enabling)
              navigation.goBack();
            } else {
              navigation.goBack();
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={20} color={c.amber} />
          <Text style={{ color: c.amber, fontSize: 16, fontFamily: fonts.sans }}>Back</Text>
        </TouchableOpacity>

        <StepIndicator step={step} c={c} />

        {loadingSetup && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <ActivityIndicator size="large" color={c.amber} />
            <Text style={{ color: c.ink3, marginTop: 16, fontFamily: fonts.sans }}>
              Generating secret...
            </Text>
          </View>
        )}

        {!loadingSetup && setupError != null && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Ionicons name="alert-circle-outline" size={48} color={c.red} />
            <Text style={{ color: c.red, marginTop: 16, fontFamily: fonts.sans, textAlign: 'center' }}>
              {setupError}
            </Text>
          </View>
        )}

        {!loadingSetup && setup != null && step === 1 && (
          <StepSecret setup={setup} onContinue={() => setStep(2)} c={c} />
        )}

        {!loadingSetup && setup != null && step === 2 && (
          <StepVerify onSuccess={() => setStep(3)} c={c} />
        )}

        {!loadingSetup && setup != null && step === 3 && (
          <StepBackupCodes codes={setup.backup_codes} onDone={handleDone} c={c} />
        )}
      </ScrollView>
    </View>
  );
}
