/**
 * Task 1551 — mobile mirror of web PR #79's `signup-email-code-step.tsx`.
 *
 * The "check your inbox" step: IDENTICAL copy whether `email` already has an
 * account or not (the server's own anti-enumeration invariant —
 * `POST /signup/email-start` always returns the same 202). A user with an
 * existing account receives a sign-in link instead of a code and simply can
 * never produce a valid one here — that's the enforcement mechanism, not a
 * client-side branch.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { DigitCodeInput, type DigitCodeInputHandle } from './DigitCodeInput';
import { spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import { signupEmailStart, signupEmailVerify, friendlyError } from '../lib/api';
import { EMAIL_CODE_LENGTH, sanitizeCode } from '../lib/signup-email-code';

export interface SignupEmailCodeStepProps {
  email: string;
  /** Called with the signup_ticket once the code is confirmed valid. */
  onVerified: (ticket: string) => void;
  /** "Wrong email? Go back" — the user mistyped their address. */
  onWrongEmail: () => void;
  /**
   * Set once, from SignupScreen, when a previously-valid ticket was rejected
   * on register-start/finish (`signup_ticket_invalid` — the ticket expired
   * mid-flow). Shown as the initial error so the user knows why they're
   * back here.
   */
  externalError?: string;
  disabled?: boolean;
}

export function SignupEmailCodeStep({
  email,
  onVerified,
  onWrongEmail,
  externalError,
  disabled,
}: SignupEmailCodeStepProps) {
  const { colors: c, resolved } = useTheme();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(externalError ?? '');
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState('');
  const boxRef = useRef<DigitCodeInputHandle>(null);

  const styles = StyleSheet.create({
    eyebrow: { fontSize: 12, fontWeight: '600', color: c.ink2, marginBottom: 4 },
    heading: { fontSize: 22, fontWeight: '700', color: c.ink, marginBottom: 6 },
    copy: { fontSize: 13, color: c.ink3, lineHeight: 19, marginBottom: spacing.lg },
    emailText: { fontWeight: '600', color: c.ink },
    errorBanner: { backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2', borderWidth: 1, borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca', borderRadius: 10, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.md },
    errorText: { fontSize: 12, color: c.red, lineHeight: 17 },
    statusText: { fontSize: 12, color: c.ink3, textAlign: 'center', marginTop: spacing.md },
    noticeText: { fontSize: 12, color: c.green, textAlign: 'center', marginTop: spacing.md },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.xl },
    footerLink: { fontSize: 12, color: c.ink3 },
    resendLink: { fontSize: 12, color: c.amberDeep, fontWeight: '600' },
    resendLinkDisabled: { opacity: 0.5 },
  });

  const doVerify = useCallback(
    async (candidate: string) => {
      setSubmitting(true);
      setError('');
      try {
        const { signup_ticket } = await signupEmailVerify(email, candidate);
        onVerified(signup_ticket);
      } catch (err) {
        // Deliberately undifferentiated by the server (wrong / expired /
        // reused / attempt-capped all render the same "invalid or expired
        // code" — no signal about which). Surface it as-is; it's already
        // honest and actionable.
        setError(friendlyError(err));
        setCode('');
        boxRef.current?.clear();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setSubmitting(false);
      }
    },
    [email, onVerified],
  );

  function handleChange(next: string) {
    setCode(sanitizeCode(next));
    setError('');
  }

  async function handleResend() {
    setResending(true);
    setResendNotice('');
    setError('');
    try {
      await signupEmailStart(email);
      setResendNotice('Code resent — check your inbox.');
      setCode('');
      boxRef.current?.clear();
    } catch (err) {
      // Rate-limit (429) and every other failure land here with the same
      // honest, already-formatted message friendlyError() gives every other
      // screen in this app (e.g. "Too many requests. Wait a moment, then
      // try again.") — never a generic "something went wrong" that hides a
      // real wait time.
      setError(friendlyError(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <View>
      <Text style={styles.eyebrow}>Verify your email</Text>
      <Text style={styles.heading}>Check your inbox</Text>
      <Text style={styles.copy} testID="signup-code-copy">
        If <Text style={styles.emailText} testID="signup-code-email">{email}</Text> can sign up,
        we've sent it a verification code. Enter the {EMAIL_CODE_LENGTH} digits below to continue.
      </Text>

      <DigitCodeInput
        ref={boxRef}
        length={EMAIL_CODE_LENGTH}
        value={code}
        onChange={handleChange}
        onComplete={(full) => void doVerify(full)}
        disabled={submitting || disabled}
        invalid={!!error}
        testID="signup-code-input"
        accessibilityLabel="Verification code"
      />

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText} testID="signup-code-error">{error}</Text>
        </View>
      ) : null}

      {submitting ? (
        <View style={styles.statusText}>
          <ActivityIndicator size="small" color={c.ink3} />
        </View>
      ) : null}

      {resendNotice && !error ? <Text style={styles.noticeText}>{resendNotice}</Text> : null}

      <View style={styles.footerRow}>
        <TouchableOpacity
          onPress={onWrongEmail}
          disabled={submitting}
          accessibilityLabel="Wrong email, go back"
          testID="signup-code-wrong-email"
        >
          <Text style={styles.footerLink}>Wrong email? Go back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => void handleResend()}
          disabled={resending || submitting}
          accessibilityLabel="Resend code"
          testID="signup-code-resend"
        >
          <Text style={[styles.resendLink, (resending || submitting) && styles.resendLinkDisabled]}>
            {resending ? 'Resending…' : 'Resend code'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
