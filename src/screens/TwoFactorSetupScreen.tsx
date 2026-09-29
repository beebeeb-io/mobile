/**
 * Two-Factor Authentication setup screen.
 *
 * Entry (task 1610): the account's live `totp_enabled` status (from
 * `useAuth()`, sourced from `/auth/me`) decides what this screen shows FIRST —
 * it no longer unconditionally starts the fresh-enrollment wizard. An
 * account with 2FA already ON sees the On state (Turn off / Set up again);
 * only an account with 2FA OFF drops straight into the wizard below. This
 * is the fix for the bug report: SettingsScreen's row always navigated here,
 * and this screen always called `setupTotp()` with no code/token on mount —
 * which the server correctly 403s (`confirmation_required`) once 2FA is on
 * (server `routes/totp.rs` `setup_step_up_validated_if_required` — verified
 * correct, not loosened).
 *
 * On state — Turn off | Set up again
 *   Turn off    — current 6-digit code, then `disableTotp(code)`.
 *   Set up again — current 6-digit code (sent as `body.code`) OR a password
 *                  step-up (`requestConfirmation()`, `X-Confirm-Token`) as the
 *                  alternative, then `setupTotp(...)` returns a NEW secret and
 *                  drops into the same wizard below (steps 1-3) to verify it.
 *
 * Wizard (fresh enrollment, or after a successful "set up again" reauth):
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
import { useAuth } from '../lib/auth';
import {
  setupTotp, enableTotp, disableTotp, friendlyError, ApiError, type TotpSetup,
} from '../lib/api';
import { requestConfirmation } from '../lib/confirm-action';
import {
  shouldBlockTwoFactorSetupBack,
  twoFactorSetupBackAction,
  initialTwoFactorSetupMode,
  wizardStep1BackTarget,
} from '../lib/two-factor-setup-gate';

let Clipboard: { setStringAsync: (s: string) => Promise<void> } = {
  setStringAsync: async () => {},
};
try {
  Clipboard = require('expo-clipboard');
} catch {}

type C = Colors;
type Step = 1 | 2 | 3;
/** What the screen shows before/instead of the fresh-enrollment wizard. */
type Mode = 'on' | 'disable' | 'reauth' | 'wizard';

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
  secondaryButton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
    borderWidth: 1.5,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '600' },
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
  errorText: { fontSize: 12.5, marginTop: 8 },
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 20,
  },
  stepDot: { width: 6, height: 6, borderRadius: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusPillText: { fontSize: 12, fontWeight: '700' },
  singleCodeInput: {
    borderRadius: 8,
    borderWidth: 1.5,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    paddingVertical: 12,
    letterSpacing: 4,
    marginTop: 12,
    marginBottom: 4,
  },
  linkButton: { paddingVertical: 10, alignSelf: 'flex-start' },
  linkButtonText: { fontSize: 13, fontWeight: '600' },
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

function SecondaryButton({
  label,
  onPress,
  loading,
  disabled,
  danger,
  c,
  testID,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  danger?: boolean;
  c: C;
  testID?: string;
}) {
  const color = danger ? c.red : c.ink;
  return (
    <TouchableOpacity
      style={[layout.secondaryButton, { borderColor: danger ? c.red : c.line2 }]}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      disabled={disabled || loading}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[layout.secondaryButtonText, { color }]}>{label}</Text>
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

/** Shared single 6-digit code field for On/Disable/Reauth (distinct from the
 *  wizard's 6-box `StepVerify` input, which needs per-digit focus). */
function CodeField({
  value,
  onChange,
  c,
  testID,
}: {
  value: string;
  onChange: (v: string) => void;
  c: C;
  testID?: string;
}) {
  return (
    <TextInput
      style={[
        layout.singleCodeInput,
        { color: c.ink, borderColor: value.length === 6 ? c.amber : c.line, backgroundColor: c.paper2, fontFamily: fonts.mono },
      ]}
      value={value}
      onChangeText={val => onChange(val.replace(/\D/g, '').slice(0, 6))}
      placeholder="6-digit code"
      placeholderTextColor={c.ink4}
      keyboardType="number-pad"
      maxLength={6}
      accessibilityLabel="6-digit authenticator code"
      testID={testID}
    />
  );
}

// ── On state: 2FA already enabled ─────────────────────────────────────────────

function StepOnState({
  onTurnOff,
  onSetUpAgain,
  c,
}: {
  onTurnOff: () => void;
  onSetUpAgain: () => void;
  c: C;
}) {
  return (
    <>
      <View style={layout.header}>
        <Text style={[layout.title, { color: c.ink, fontFamily: fonts.sans }]}>
          Two-factor authentication
        </Text>
        <View style={layout.statusRow}>
          <View style={[layout.statusPill, { backgroundColor: c.paper2, borderWidth: 1, borderColor: c.green }]}>
            <Text style={[layout.statusPillText, { color: c.green }]}>On</Text>
          </View>
        </View>
        <Text style={[layout.subtitle, { color: c.ink3, fontFamily: fonts.sans, marginTop: 8 }]}>
          Your account is protected with an authenticator app.
        </Text>
      </View>

      <SecondaryButton label="Set up again" onPress={onSetUpAgain} c={c} testID="totp-set-up-again" />
      <SecondaryButton label="Turn off" onPress={onTurnOff} danger c={c} testID="totp-turn-off" />
    </>
  );
}

// ── Turn off: current code required ───────────────────────────────────────────

function StepDisable({
  onDone,
  onCancel,
  c,
}: {
  onDone: () => void;
  onCancel: () => void;
  c: C;
}) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async () => {
    if (code.length < 6) return;
    setLoading(true);
    setError('');
    try {
      await disableTotp(code);
      onDone();
    } catch (err) {
      // Branch on `.status`, not `.code`: mobile's shared `request()` only
      // carries `err.error` through as `ApiError.code` for a small allowlist
      // (account_mismatch, plan_required, account_lapsed) — every other
      // server error code, including `invalid_totp_code`, comes back with
      // `code: undefined` (found while building this fix; left as-is, out of
      // scope here — see task 1610 Notes). The server's `disable` handler
      // only ever 400s here for a wrong code (`wrong_code_on_authenticated_route`
      // → `InvalidTotpCode`), so `.status === 400` is an accurate proxy.
      if (err instanceof ApiError && err.status === 400) {
        setError('Incorrect code. Try again.');
      } else {
        setError(friendlyError(err));
      }
    } finally {
      setLoading(false);
    }
  }, [code, onDone]);

  return (
    <>
      <View style={layout.header}>
        <Text style={[layout.title, { color: c.ink, fontFamily: fonts.sans }]}>Turn off 2FA</Text>
        <Text style={[layout.subtitle, { color: c.ink3, fontFamily: fonts.sans }]}>
          Enter your current authenticator code to turn off two-factor authentication.
        </Text>
      </View>

      <CodeField value={code} onChange={setCode} c={c} testID="totp-disable-code" />
      {error ? <Text style={[layout.errorText, { color: c.red, fontFamily: fonts.sans }]}>{error}</Text> : null}

      <PrimaryButton label="Turn off 2FA" onPress={handleSubmit} loading={loading} disabled={code.length < 6} c={c} />
      <SecondaryButton label="Cancel" onPress={onCancel} c={c} />
    </>
  );
}

// ── Set up again: current code OR password step-up ───────────────────────────

function StepReauth({
  onSetup,
  onCancel,
  c,
}: {
  onSetup: (setup: TotpSetup) => void;
  onCancel: () => void;
  c: C;
}) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [error, setError] = useState('');
  // Codex review (PR #156, P2): Cancel only disables ITS OWN trigger, not the
  // in-flight request — without this guard, a code/password step-up that
  // resolves AFTER Cancel was tapped still calls `onSetup(data)`, silently
  // reissuing the secret and yanking the parent back into the wizard even
  // though the user believed they'd backed out. `setupTotp` has ALREADY run
  // server-side by the time either handler's `await` resolves (the request
  // itself is not abortable), so this can only suppress the STALE UI
  // transition, not the server call — the same one-request-per-tap
  // constraint the wizard's Enable/Disable/Turn-off buttons already accept.
  const cancelledRef = useRef(false);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    onCancel();
  }, [onCancel]);

  const handleCodeSubmit = useCallback(async () => {
    if (code.length < 6) return;
    setLoading(true);
    setError('');
    try {
      const data = await setupTotp({ code });
      if (cancelledRef.current) return;
      onSetup(data);
    } catch (err) {
      // See StepDisable's handleSubmit above for why this checks `.status`
      // rather than `.code`. `setup`'s step-up path 400s only for a wrong
      // code (`InvalidTotpCode`); anything else (network, 403, 5xx) gets the
      // generic message, which already points at the password alternative.
      if (err instanceof ApiError && err.status === 400) {
        setError('Incorrect code. Try again.');
      } else {
        setError('Could not verify that code. Try again, or use your password instead.');
      }
    } finally {
      setLoading(false);
    }
  }, [code, onSetup]);

  const handlePasswordInstead = useCallback(async () => {
    setPasswordLoading(true);
    setError('');
    try {
      const confirmToken = await requestConfirmation({
        title: 'Confirm your password',
        message: 'Enter your password to set up two-factor authentication again.',
      });
      if (!confirmToken) return; // cancelled — requestConfirmation already alerted on real errors
      const data = await setupTotp({ confirmToken });
      if (cancelledRef.current) return;
      onSetup(data);
    } catch (err) {
      if (cancelledRef.current) return;
      Alert.alert('Could not start setup', friendlyError(err));
    } finally {
      setPasswordLoading(false);
    }
  }, [onSetup]);

  return (
    <>
      <View style={layout.header}>
        <Text style={[layout.title, { color: c.ink, fontFamily: fonts.sans }]}>Set up again</Text>
        <Text style={[layout.subtitle, { color: c.ink3, fontFamily: fonts.sans }]}>
          Two-factor authentication is already on. Enter your current authenticator code to set it
          up again — this issues a new secret and new backup codes.
        </Text>
      </View>

      <CodeField value={code} onChange={setCode} c={c} testID="totp-reauth-code" />
      {error ? <Text style={[layout.errorText, { color: c.red, fontFamily: fonts.sans }]}>{error}</Text> : null}

      <PrimaryButton label="Continue" onPress={handleCodeSubmit} loading={loading} disabled={code.length < 6} c={c} />

      <TouchableOpacity
        style={layout.linkButton}
        onPress={handlePasswordInstead}
        disabled={passwordLoading}
        accessibilityRole="button"
        accessibilityLabel="Use your password instead"
      >
        {passwordLoading ? (
          <ActivityIndicator color={c.ink3} />
        ) : (
          <Text style={[layout.linkButtonText, { color: c.ink3, fontFamily: fonts.sans }]}>
            Use your password instead
          </Text>
        )}
      </TouchableOpacity>

      <SecondaryButton label="Cancel" onPress={handleCancel} c={c} />
    </>
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
            testID="totp-setup-secret"
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
  onVerifyingChange,
  c,
}: {
  onSuccess: () => void;
  /** Reports the enable request's in-flight state so the screen can block leaving meanwhile. */
  onVerifyingChange: (verifying: boolean) => void;
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
    onVerifyingChange(true);
    try {
      await enableTotp(code);
      onSuccess();
    } catch (err) {
      Alert.alert('Verification failed', friendlyError(err));
    } finally {
      setLoading(false);
      onVerifyingChange(false);
    }
  }, [code, ready, onSuccess, onVerifyingChange]);

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
  const { user, refreshAuth } = useAuth();

  // Task 1610: the mode this screen OPENS in is decided once, from the
  // already-known `/auth/me` status — never a bare, unconditional
  // `setupTotp()` on mount. An account with 2FA on starts on the On state;
  // only an account with 2FA off starts directly in the wizard (unchanged
  // behavior for that case).
  const [mode, setMode] = useState<Mode>(() => initialTwoFactorSetupMode(user?.totp_enabled));
  // True once "Set up again" has produced a fresh secret — controls what the
  // wizard's step-1 Back button does (see backAction below) and re-enables
  // the On-state pill immediately if the user backs out without finishing.
  const [cameFromReauth, setCameFromReauth] = useState(false);

  const [step, setStep] = useState<Step>(1);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(mode === 'wizard');
  const [setupError, setSetupError] = useState<string | null>(null);
  // True while StepVerify's enable request is in flight — the server may
  // activate 2FA at any moment, so leaving is blocked until it settles.
  const [verifying, setVerifying] = useState(false);

  // Fetch secret on mount ONLY for a fresh (2FA-off) entry; re-runs via the
  // error state's Retry button (1297). "Set up again" populates `setup`
  // itself (via StepReauth's onSetup) and never goes through this effect.
  const cancelledRef = useRef(false);
  const fetchSetup = useCallback(() => {
    setLoadingSetup(true);
    setSetupError(null);
    setupTotp()
      .then(data => {
        if (!cancelledRef.current) setSetup(data);
      })
      .catch(err => {
        if (!cancelledRef.current) setSetupError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelledRef.current) setLoadingSetup(false);
      });
  }, []);
  useEffect(() => {
    if (mode !== 'wizard' || cameFromReauth) return undefined;
    cancelledRef.current = false;
    fetchSetup();
    return () => { cancelledRef.current = true; };
    // Intentionally runs once for a fresh entry — `cameFromReauth` starts
    // false and only ever flips true via handleReauthSetup below, at which
    // point `setup` is already populated and this must NOT re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleReauthSetup = useCallback((data: TotpSetup) => {
    setSetup(data);
    setStep(1);
    setCameFromReauth(true);
    setMode('wizard');
  }, []);

  const handleDisabled = useCallback(() => {
    Alert.alert('Two-factor authentication turned off');
    refreshAuth().catch(() => {});
    navigation.goBack();
  }, [navigation, refreshAuth]);

  // Task 1539 (finding 2): the custom back button's step>1 branch used to
  // call the exact same navigation.goBack() as step 1 — a dead conditional
  // that let a user swipe/tap away from step 3 (one-time backup codes,
  // already-active 2FA) and lose them permanently. `beforeRemove` blocks
  // EVERY removal path (header back, this custom button, and iOS's native
  // edge-swipe gesture) regardless of which one fires, so it's the actual
  // enforcement point; the gestureEnabled + hidden-button changes below are
  // the visible affordance that matches it.
  //
  // Codex P1 follow-up (PR #109 review): that same blanket enforcement also
  // caught the step-3 Done button's OWN `navigation.goBack()` once 2FA was
  // successfully enabled, trapping the user on the screen with no way off
  // it — tapping Done did nothing. `completedRef` is the explicit escape:
  // `handleDone` sets it right before navigating, and the listener (which
  // re-reads it on every fire via the ref, not a stale closure) lets that
  // one `goBack()` through while continuing to block everything else.
  //
  // Only the WIZARD (mode === 'wizard') ever needs this — the On/Disable/
  // Reauth panels hold nothing irrecoverable (no one-time secret is shown
  // there), so leaving them is always free.
  const completedRef = useRef(false);
  const blocked = mode === 'wizard' && shouldBlockTwoFactorSetupBack(step, false, verifying);
  useEffect(() => {
    if (!blocked) return undefined;
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      // Read completedRef fresh on every fire (not a stale render-time
      // value) — Done can flip it after this listener was already
      // installed for the current step.
      if (completedRef.current) return;
      if (mode !== 'wizard' || !shouldBlockTwoFactorSetupBack(step, completedRef.current, verifying)) return;
      e.preventDefault();
    });
    return unsubscribe;
  }, [navigation, mode, step, verifying, blocked]);

  // Belt-and-suspenders: also disable the native iOS edge-swipe-back gesture
  // directly (native-stack supports updating this per-screen), matching how
  // TwoFactorChallenge/RecoveryUnlock are registered in App.tsx. This can't
  // be a static `gestureEnabled: false` on the Stack.Screen the way those
  // are, because step 1 must stay dismissable.
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !blocked });
  }, [navigation, blocked]);

  const backAction = mode === 'wizard' ? twoFactorSetupBackAction(step, verifying) : 'leave';

  const handleDone = useCallback(() => {
    completedRef.current = true;
    navigation.goBack();
  }, [navigation]);

  const handleWizardBack = useCallback(() => {
    Haptics.selectionAsync();
    if (backAction === 'previous-step') {
      setStep(1);
      return;
    }
    // backAction === 'leave' at step 1: where that actually lands depends on
    // how this wizard run started (see wizardStep1BackTarget's doc comment).
    if (wizardStep1BackTarget(cameFromReauth) === 'on') {
      setCameFromReauth(false);
      setSetup(null);
      setStep(1);
      setSetupError(null);
      setMode('on');
      return;
    }
    navigation.goBack();
  }, [backAction, cameFromReauth, navigation]);

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
        {/* Back button — step 1 leaves (or returns to the On state when this
            wizard run started from "set up again"); step 2 returns to step 1
            (same secret, so it can be added to an authenticator); hidden at
            step 3 and while verifying, where the beforeRemove listener above
            is the real enforcement and a button would silently do nothing.
            The On/Disable/Reauth panels always show a plain leave button. */}
        {mode !== 'wizard' ? (
          <TouchableOpacity
            style={layout.backButton}
            onPress={() => {
              Haptics.selectionAsync();
              navigation.goBack();
            }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={20} color={c.amber} />
            <Text style={{ color: c.amber, fontSize: 16, fontFamily: fonts.sans }}>Back</Text>
          </TouchableOpacity>
        ) : backAction !== 'none' && (
          <TouchableOpacity
            style={layout.backButton}
            onPress={handleWizardBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={20} color={c.amber} />
            <Text style={{ color: c.amber, fontSize: 16, fontFamily: fonts.sans }}>Back</Text>
          </TouchableOpacity>
        )}

        {mode === 'wizard' && <StepIndicator step={step} c={c} />}

        {mode === 'on' && (
          <StepOnState
            onTurnOff={() => setMode('disable')}
            onSetUpAgain={() => setMode('reauth')}
            c={c}
          />
        )}

        {mode === 'disable' && (
          <StepDisable onDone={handleDisabled} onCancel={() => setMode('on')} c={c} />
        )}

        {mode === 'reauth' && (
          <StepReauth onSetup={handleReauthSetup} onCancel={() => setMode('on')} c={c} />
        )}

        {mode === 'wizard' && loadingSetup && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <ActivityIndicator size="large" color={c.amber} />
            <Text style={{ color: c.ink3, marginTop: 16, fontFamily: fonts.sans }}>
              Generating secret...
            </Text>
          </View>
        )}

        {mode === 'wizard' && !loadingSetup && setupError != null && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Ionicons name="alert-circle-outline" size={48} color={c.red} />
            <Text style={{ color: c.red, marginTop: 16, fontFamily: fonts.sans, textAlign: 'center' }}>
              {setupError}
            </Text>
            <TouchableOpacity
              onPress={() => {
                Haptics.selectionAsync();
                fetchSetup();
              }}
              style={{
                marginTop: 24,
                minHeight: 44,
                paddingHorizontal: 28,
                borderRadius: 999,
                backgroundColor: c.amber,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry two-factor setup"
              testID="totp-setup-retry"
            >
              <Text style={{ color: '#1a1a1e', fontSize: 15, fontWeight: '600', fontFamily: fonts.sans }}>
                Try again
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'wizard' && !loadingSetup && setup != null && step === 1 && (
          <StepSecret setup={setup} onContinue={() => setStep(2)} c={c} />
        )}

        {mode === 'wizard' && !loadingSetup && setup != null && step === 2 && (
          <StepVerify
            onSuccess={() => {
              setStep(3)
              // Codex review (PR #156, P1): without this, `user.totp_enabled`
              // stays stale at `false` after a fresh enrollment — the NEXT
              // time this screen opens, `initialTwoFactorSetupMode` reads
              // that stale value and routes back into the bare wizard,
              // reproducing the exact 403 confirmation_required this task
              // fixes, for every freshly-enrolled account. Mirrors web's
              // identical `refreshUser()` call at the same point
              // (settings/security.tsx `handleVerify`).
              refreshAuth().catch(() => {})
            }}
            onVerifyingChange={setVerifying}
            c={c}
          />
        )}

        {mode === 'wizard' && !loadingSetup && setup != null && step === 3 && (
          <StepBackupCodes codes={setup.backup_codes} onDone={handleDone} c={c} />
        )}
      </ScrollView>
    </View>
  );
}
