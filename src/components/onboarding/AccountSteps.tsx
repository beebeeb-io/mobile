/**
 * The two account-stage steps this build can do (task 1746): `verify_email`
 * (a native signup is not complete until the mailbox is confirmed: the allowance
 * needs it) and `accept_terms` (every account that predates the acceptance record,
 * and every account after a Terms version bump, carries a required one). Both block
 * the file UI until done, as the document says (`blocking`), and both leave a way
 * out (Sign out) because the overlay covers the app.
 */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { spacing } from '../../theme';
import { acceptTermsVersion, resendAccountVerification, verifyAccountEmail } from '../../lib/api';
import { toActionError } from '../../lib/onboarding/ports';
import { verifyCodeMessage } from '../../lib/onboarding/copy';
import type { StepScreen } from '../../lib/onboarding/plan';
import type { OnboardingDocument } from '../../lib/onboarding/types';
import { TermsLinks } from './SignupFlow';
import { CheckRow, ErrorLine, Field, Notice, OnboardingFrame, PrimaryButton, SecondaryButton, useOnboardingStyles } from './ui';

export function VerifyEmailAccountStep({
  screen,
  onDone,
  onSignOut,
}: {
  screen: StepScreen;
  onDone: () => Promise<void> | void;
  onSignOut: () => Promise<void>;
}) {
  const { s } = useOnboardingStyles();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);

  async function submit() {
    if (busy || code.length < 6) return;
    setBusy(true);
    setError('');
    try {
      await verifyAccountEmail(code.trim());
      await onDone();
    } catch (err) {
      setError(verifyCodeMessage(toActionError(err, 'wrong_code')));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError('');
    try {
      await resendAccountVerification();
      setResent(true);
    } catch (err) {
      const e = toActionError(err, 'resend_failed');
      setError(e.code === 'rate_limited' ? 'Too many emails for now. Try again later.' : 'We could not send another email. Try again later.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingFrame
      title="Confirm your email"
      subtitle="We sent a code to the address on your account. Uploading starts once it is confirmed."
      position={screen.position}
      total={screen.total}
      testID="account-step-verify_email"
    >
      <Field
        label="Code"
        value={code}
        onChangeText={(t) => {
          setCode(t.replace(/\D/g, '').slice(0, 12));
          setError('');
        }}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoCorrect={false}
        mono
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        invalid={!!error}
        testID="account-verify-code-input"
      />
      {error ? <ErrorLine testID="account-verify-error">{error}</ErrorLine> : null}
      {resent ? <Notice testID="account-verify-resent">A new email is on its way.</Notice> : null}
      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        <PrimaryButton label="Confirm" onPress={() => void submit()} busy={busy} disabled={code.length < 6} testID="account-verify-confirm" />
        <TouchableOpacity onPress={() => void resend()} disabled={busy} accessibilityRole="button" style={{ alignSelf: 'center', padding: spacing.sm }} testID="account-verify-resend">
          <Text style={s.linkText}>Send a new code</Text>
        </TouchableOpacity>
        <SecondaryButton label="Sign out" onPress={() => void onSignOut()} testID="account-step-sign-out" />
      </View>
    </OnboardingFrame>
  );
}

export function AcceptTermsAccountStep({
  screen,
  doc,
  onDone,
  onSignOut,
}: {
  screen: StepScreen;
  doc: OnboardingDocument;
  onDone: () => Promise<void> | void;
  onSignOut: () => Promise<void>;
}) {
  const version = typeof screen.step.params.version === 'string' ? (screen.step.params.version as string) : null;
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The links live in `policy.terms` on a pre-account document; an account document
  // carries only the version, so the public pages are named here.
  const terms = {
    url: doc.policy?.terms.url ?? 'https://beebeeb.io/terms',
    privacyUrl: doc.policy?.terms.privacyUrl ?? 'https://beebeeb.io/privacy',
    version: version ?? '',
  };

  async function submit() {
    if (busy || !accepted || !version) return;
    setBusy(true);
    setError('');
    try {
      await acceptTermsVersion(version);
      await onDone();
    } catch (err) {
      const e = toActionError(err, 'terms_failed');
      setError(
        e.code === 'terms_version_stale'
          ? 'The Terms changed while this screen was open. Check again to read the current version.'
          : e.code === 'network'
            ? 'Could not reach the server. Check your connection and try again.'
            : 'We could not record your acceptance. Try again.',
      );
      if (e.code === 'terms_version_stale') await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingFrame
      title="Terms and privacy"
      subtitle="We need your agreement to the current Terms before you continue."
      position={screen.position}
      total={screen.total}
      testID="account-step-accept_terms"
    >
      <TermsLinks terms={terms} />
      <CheckRow checked={accepted} onChange={setAccepted} testID="account-terms-check">
        I accept the Terms of Service and the Privacy Policy.
      </CheckRow>
      {error ? <ErrorLine testID="account-terms-error">{error}</ErrorLine> : null}
      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        <PrimaryButton label="Accept and continue" onPress={() => void submit()} busy={busy} disabled={!accepted || !version} testID="account-terms-accept" />
        <SecondaryButton label="Sign out" onPress={() => void onSignOut()} testID="account-step-sign-out" />
      </View>
    </OnboardingFrame>
  );
}
