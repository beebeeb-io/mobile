/**
 * The pre-account flow (stage `pre_account`), task 1746: enter_email,
 * verify_email_code, accept_terms, set_password, save_recovery_phrase,
 * create_account, in the order and with the numbers the document declares.
 * Mirrors the web renderer (`repos/web/src/components/onboarding/signup-flow.tsx`,
 * task 1745).
 *
 * What lives where (spec 5.5, 5.12):
 *   - The planner (`planScreen`) picks the screen. This file never decides order,
 *     never skips a step on its own, never invents policy.
 *   - Password policy, the breach gate, the recovery phrase and OPAQUE all run in
 *     the core ceremony (UniFFI, `beebeeb_core::onboarding`). The fields below are
 *     inputs and buttons. No cryptography in TypeScript.
 *   - The ceremony is wiped (`dispose` = abandon + release) when the flow is left,
 *     restarted, or fails for a reason the person cannot retry.
 *   - The password is held in this file only while the field is on screen. The
 *     master key reaches the vault through `ports.adoptVault` and nowhere else.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { clampCodeLength, shownTermsVersion } from '../../lib/onboarding/limits';
import { useAppSwitcherProtection, useCaptureGuard } from './screen-privacy';
import { fonts, radii, spacing } from '../../theme';
import { CeremonyError, type BreachCheck, type PasswordEvaluation, type SignupCeremony } from '../../../modules/beebeeb-crypto/src/BeebeebOnboarding';
import { DigitCodeInput, type DigitCodeInputHandle } from '../DigitCodeInput';
import { runBreachCheck } from '../../lib/onboarding/breach-step';
import {
  TICKET_EXPIRED_NOTICE,
  UNKNOWN_OUTCOME_MESSAGE,
  VAULT_NOT_ADOPTED_MESSAGE,
  ceremonyMessage,
  createAccountMessage,
  emailStartMessage,
  verifyCodeMessage,
} from '../../lib/onboarding/copy';
import { runCreateAccount, type CreateAccountOutcome } from '../../lib/onboarding/create-account';
import { planScreen, type Screen, type StepScreen } from '../../lib/onboarding/plan';
import { toActionError, type SignupPorts } from '../../lib/onboarding/ports';
import { GUESS_BUDGET, formatCountdown, resendRemainingSeconds } from '../../lib/onboarding/resend';
import type { OnboardingDocument, SignupPolicy } from '../../lib/onboarding/types';
import { StepBlocked, StepFallback, SignupUnavailable, UnsupportedSchema, UpdateRequired } from './BlockingScreens';
import {
  CheckRow,
  ErrorLine,
  Field,
  Notice,
  OnboardingFrame,
  PrimaryButton,
  SecondaryButton,
  Spinner,
  useOnboardingStyles,
} from './ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Session {
  email: string;
  pilotKey: string;
  ticket: string;
  /** When email-start last succeeded, for the "send a new code in m:ss" countdown. */
  emailSentAt: number | null;
  /** The Terms version the person accepted (the version the accept_terms step showed); submitted at register-finish. */
  termsVersion: string;
}

const freshSession = (): Session => ({ email: '', pilotKey: '', ticket: '', emailSentAt: null, termsVersion: '' });

interface Ctx {
  doc: OnboardingDocument;
  policy: SignupPolicy;
  ports: SignupPorts;
  /** Null until the ceremony is ready; the secret-bearing steps wait for it. */
  ceremony: SignupCeremony | null;
  session: React.MutableRefObject<Session>;
  screen: StepScreen;
  done: (id: string) => void;
  undo: (...ids: string[]) => void;
  notice: string;
  setNotice: (n: string) => void;
  startOver: () => void;
  /** Leave the flow (back to Welcome or Login). */
  cancel: () => void;
  /** The account exists and auth should refresh. */
  onCreated: (o: Extract<CreateAccountOutcome, { kind: 'created' }>) => void;
  onAccountExists: (email: string) => void;
  regionLine: string | null;
}

type CeremonyCtx = Ctx & { ceremony: SignupCeremony };

// ── enter_email ──────────────────────────────────────────────────────────────

function EnterEmailStep({ ctx }: { ctx: Ctx }) {
  const { session, ports } = ctx;
  const [email, setEmail] = useState(session.current.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const previous = session.current.email;
      const same = previous !== '' && previous.toLowerCase() === trimmed.toLowerCase();
      if (same && session.current.emailSentAt !== null) {
        // Same address, mail already sent: do not send a second one.
        ctx.done('enter_email');
        return;
      }
      // The verified email changed: core withdraws verification, keeps the secrets.
      if (previous && !same && session.current.ticket) {
        await ctx.ceremony?.emailChanged();
        session.current.ticket = '';
        ctx.undo('verify_email_code');
      }
      await ports.actions.emailStart(trimmed, session.current.pilotKey);
      session.current.email = trimmed;
      session.current.emailSentAt = Date.now();
      ctx.setNotice('');
      ctx.done('enter_email');
    } catch (err) {
      setError(emailStartMessage(toActionError(err, 'email_start_failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingFrame
      title="Create your account"
      subtitle="Start with your email. Everything you store is encrypted on your device before it leaves it, so we cannot read any of it."
      position={ctx.screen.position}
      total={ctx.screen.total}
      onBack={ctx.cancel}
      backLabel="Sign in"
      regionLine={ctx.regionLine}
      testID="signup-step-enter_email"
    >
      <Field
        label="Email"
        value={email}
        onChangeText={(t) => {
          setEmail(t);
          setError('');
        }}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!busy}
        invalid={!!error}
        testID="signup-email-input"
      />
      {error ? <ErrorLine testID="signup-email-error">{error}</ErrorLine> : null}
      <View style={{ marginTop: spacing.xl }}>
        <PrimaryButton label="Continue" onPress={() => void submit()} busy={busy} disabled={!email.trim()} testID="signup-email-continue" />
      </View>
    </OnboardingFrame>
  );
}

// ── pilot_key ────────────────────────────────────────────────────────────────

function PilotKeyStep({ ctx }: { ctx: Ctx }) {
  const [key, setKey] = useState(ctx.session.current.pilotKey);
  return (
    <OnboardingFrame
      title="Pilot access key"
      subtitle="Sign-up currently needs a pilot access key. Contact the team if you are a pilot."
      position={ctx.screen.position}
      total={ctx.screen.total}
      testID="signup-step-pilot_key"
    >
      <Field label="Access key" value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} mono testID="signup-pilot-key-input" />
      <View style={{ marginTop: spacing.xl }}>
        <PrimaryButton
          label="Continue"
          disabled={!key.trim()}
          testID="signup-pilot-key-continue"
          onPress={() => {
            ctx.session.current.pilotKey = key.trim();
            ctx.done('pilot_key');
          }}
        />
      </View>
    </OnboardingFrame>
  );
}

// ── verify_email_code ────────────────────────────────────────────────────────

function VerifyEmailCodeStep({ ctx }: { ctx: Ctx }) {
  const { policy, session, ports, screen } = ctx;
  const { s } = useOnboardingStyles();
  const length = clampCodeLength(typeof screen.step.params.length === 'number' ? screen.step.params.length : policy.emailCode.length);
  const codeRef = useRef<DigitCodeInputHandle>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  // Wrong codes on this screen. The server gives all live codes ONE shared guess
  // budget (5); once it is spent a fresh code is the only way forward and the
  // server issues it at once, so the wait is lifted.
  const [failedVerifies, setFailedVerifies] = useState(0);
  const budgetSpent = failedVerifies >= GUESS_BUDGET;

  // A resend sends a fresh code, but only `resend_after_seconds` after the last
  // one (the server enforces the same window); count it down live. `sentAt` lives
  // in state so the effect re-runs on EVERY resend.
  const [sentAt, setSentAt] = useState<number | null>(session.current.emailSentAt);
  const [now, setNow] = useState(() => Date.now());
  const remaining = resendRemainingSeconds(sentAt, policy.emailCode.resendAfterSeconds, now);
  useEffect(() => {
    if (resendRemainingSeconds(sentAt, policy.emailCode.resendAfterSeconds, Date.now()) <= 0) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (resendRemainingSeconds(sentAt, policy.emailCode.resendAfterSeconds, t) <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [sentAt, policy.emailCode.resendAfterSeconds]);

  async function submit(value: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!ctx.ceremony) {
        setError('Encryption is still loading. Try again in a moment.');
        return;
      }
      const ticket = await ports.actions.emailVerify(session.current.email, value.trim());
      session.current.ticket = ticket;
      await ctx.ceremony.emailVerified();
      ctx.setNotice('');
      ctx.done('verify_email_code');
    } catch (err) {
      const e = toActionError(err, 'wrong_code');
      if (e.code === 'rate_limited' || e.code === 'network') {
        setError(verifyCodeMessage(e));
      } else {
        setFailedVerifies((n) => n + 1);
        setError(verifyCodeMessage(e));
        setCode('');
        codeRef.current?.clear();
      }
    } finally {
      setBusy(false);
    }
  }

  async function askAgain() {
    setBusy(true);
    setError('');
    try {
      await ports.actions.emailStart(session.current.email, session.current.pilotKey);
      session.current.emailSentAt = Date.now();
      setNow(session.current.emailSentAt);
      setSentAt(session.current.emailSentAt);
      setFailedVerifies(0);
      setCode('');
      codeRef.current?.clear();
      setResent(true);
    } catch {
      setError('We could not send another email. Try again later.');
    } finally {
      setBusy(false);
    }
  }

  const canAskAgain = remaining <= 0 || budgetSpent;

  return (
    <OnboardingFrame
      title="Check your email"
      // Anti-enumeration copy (spec 5.9): identical for every address.
      subtitle="If this address can be used, we sent an email. Open it to continue. If you already have an account, the email says so and links to sign-in."
      position={screen.position}
      total={screen.total}
      testID="signup-step-verify_email_code"
    >
      {ctx.notice ? <Notice testID="signup-code-notice">{ctx.notice}</Notice> : null}
      <Text style={s.label}>{`${length}-digit code`}</Text>
      <DigitCodeInput
        ref={codeRef}
        length={length}
        value={code}
        onChange={setCode}
        onComplete={(v) => void submit(v)}
        disabled={busy}
        invalid={!!error}
        testID="signup-code"
        accessibilityLabel="Email code"
      />
      {error ? <ErrorLine testID="signup-code-error">{error}</ErrorLine> : null}
      {budgetSpent ? (
        <Text style={[s.mutedText, { marginTop: spacing.sm }]} testID="signup-guess-budget-spent">
          Too many wrong codes. Ask for a new one.
        </Text>
      ) : null}
      <View style={{ marginTop: spacing.xl }}>
        <PrimaryButton label="Verify" onPress={() => void submit(code)} busy={busy} disabled={code.length !== length} testID="signup-code-verify" />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.lg }}>
        <TouchableOpacity onPress={() => ctx.undo('enter_email')} accessibilityRole="button" testID="signup-use-different-email">
          <Text style={s.linkText}>Use a different email</Text>
        </TouchableOpacity>
        {canAskAgain ? (
          <TouchableOpacity onPress={() => void askAgain()} disabled={busy} accessibilityRole="button" testID="signup-send-new-code">
            <Text style={s.linkText}>Send a new code</Text>
          </TouchableOpacity>
        ) : (
          <Text style={s.mutedText} testID="signup-ask-again-at">
            You can ask for a new code in <Text style={{ fontFamily: fonts.mono }}>{formatCountdown(remaining)}</Text>
          </Text>
        )}
      </View>
      {resent ? (
        <Text style={[s.mutedText, { marginTop: spacing.sm }]} testID="signup-code-resent">
          If this address can be used, a new email is on its way.
        </Text>
      ) : null}
    </OnboardingFrame>
  );
}

// ── accept_terms ─────────────────────────────────────────────────────────────

export function TermsLinks({ terms }: { terms: { url: string | null; privacyUrl: string | null; version: string } }) {
  const { s } = useOnboardingStyles();
  const open = (url: string | null) => {
    if (url) Linking.openURL(url).catch(() => {});
  };
  return (
    <Text style={[s.mutedText, { marginBottom: spacing.md, lineHeight: 20 }]} testID="terms-links">
      Read the{' '}
      {terms.url ? (
        <Text style={s.linkText} onPress={() => open(terms.url)} accessibilityRole="link">Terms of Service</Text>
      ) : (
        'Terms of Service'
      )}{' '}
      and the{' '}
      {terms.privacyUrl ? (
        <Text style={s.linkText} onPress={() => open(terms.privacyUrl)} accessibilityRole="link">Privacy Policy</Text>
      ) : (
        'Privacy Policy'
      )}
      . Version <Text style={{ fontFamily: fonts.mono }}>{terms.version}</Text>.
    </Text>
  );
}

function AcceptTermsStep({ ctx }: { ctx: Ctx }) {
  const { policy, screen } = ctx;
  const version = shownTermsVersion(screen.step.params, policy.terms.version);
  const [terms, setTerms] = useState(false);
  const [understood, setUnderstood] = useState(false);
  return (
    <OnboardingFrame title="Terms and privacy" position={screen.position} total={screen.total} testID="signup-step-accept_terms">
      <TermsLinks terms={{ ...policy.terms, version }} />
      <CheckRow checked={terms} onChange={setTerms} testID="signup-terms-check">
        I accept the Terms of Service and the Privacy Policy.
      </CheckRow>
      <CheckRow checked={understood} onChange={setUnderstood} testID="signup-understood-check">
        I understand that Beebeeb cannot recover my account if I lose both my password and my recovery phrase. We can't recover this.
      </CheckRow>
      <View style={{ marginTop: spacing.xl }}>
        <PrimaryButton label="Continue" disabled={!terms || !understood} onPress={() => {
            // Record what was SHOWN; register-finish submits exactly this.
            ctx.session.current.termsVersion = version;
            ctx.done('accept_terms');
          }} testID="signup-terms-continue" />
      </View>
    </OnboardingFrame>
  );
}

// ── set_password ─────────────────────────────────────────────────────────────

function hintText(e: PasswordEvaluation): { text: string; tone: 'bad' | 'neutral' | 'good' } {
  switch (e.hint) {
    case 'need_more_characters':
      return { text: `Needs at least ${e.minLength} characters, ${e.missingCharacters} more.`, tone: 'bad' };
    case 'mix_case_and_add_number_or_symbol':
      return { text: 'Mix upper and lowercase, and add a number or symbol.', tone: 'neutral' };
    case 'mix_case':
      return { text: 'Mix upper and lowercase.', tone: 'neutral' };
    case 'add_number_or_symbol':
      return { text: 'Add a number or symbol.', tone: 'neutral' };
    default:
      return e.strength === 'strong' ? { text: 'Strong.', tone: 'good' } : { text: 'Good.', tone: 'neutral' };
  }
}

function SetPasswordStep({ ctx }: { ctx: CeremonyCtx }) {
  const { policy, ports, ceremony, screen } = ctx;
  const { s, c } = useOnboardingStyles();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [show, setShow] = useState(false);
  // While the password is readable on screen it must not be capturable.
  useCaptureGuard('signup-show-password', show);
  useAppSwitcherProtection(show);
  const [evaluation, setEvaluation] = useState<PasswordEvaluation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirmRef = useRef<any>(null);

  // Advisory meter from core. The gate is `setPassword`, never this.
  useEffect(() => {
    if (!password) {
      setEvaluation(null);
      return;
    }
    let cancelled = false;
    ports.ceremony
      .evaluate(password, policy.password.minLength)
      .then((e) => {
        if (!cancelled) setEvaluation(e);
      })
      .catch(() => {
        if (!cancelled) setEvaluation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [password, policy.password.minLength, ports.ceremony]);

  const matches = password.length > 0 && password === confirmation;
  const mismatch = confirmation.length > 0 && password !== confirmation;

  async function submit() {
    if (busy || !matches || !evaluation?.meetsMinimum) return;
    setBusy(true);
    setError('');
    let breach: BreachCheck | null = null;
    try {
      const bc = policy.password.breachCheck;
      if (bc) {
        breach = await ports.ceremony.breach(password);
        await runBreachCheck(ports.fetchBreachBody, breach, bc);
      }
      await ceremony.setPassword(password, confirmation, breach);
      ctx.done('set_password');
    } catch (err) {
      setError(ceremonyMessage(err instanceof CeremonyError ? err.code : 'unknown'));
    } finally {
      await breach?.dispose();
      setBusy(false);
    }
  }

  const hint = evaluation ? hintText(evaluation) : null;
  const meterColors = [c.red, c.ink4, c.amber, c.green];

  return (
    <OnboardingFrame
      title="Set a password"
      subtitle="It unlocks your account on this device. Your recovery phrase stays the ultimate backup."
      position={screen.position}
      total={screen.total}
      testID="signup-step-set_password"
    >
      <Field
        label="Password"
        value={password}
        onChangeText={(t) => {
          setPassword(t);
          setError('');
        }}
        placeholder={`At least ${policy.password.minLength} characters`}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="next"
        blurOnSubmit={false}
        onSubmitEditing={() => confirmRef.current?.focus()}
        editable={!busy}
        testID="signup-password-input"
      />
      {evaluation && hint ? (
        <View style={{ marginTop: spacing.sm }} testID="signup-password-strength">
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {[1, 2, 3, 4].map((i) => (
              <View
                key={i}
                style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= evaluation.level ? meterColors[evaluation.level - 1] : c.line }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
            <Text
              style={{ fontSize: 12, color: hint.tone === 'bad' ? c.red : hint.tone === 'good' ? c.green : c.ink3, flex: 1 }}
              testID="signup-password-strength-message"
            >
              {hint.text}
            </Text>
            <Text style={{ fontSize: 11, color: c.ink4, fontFamily: fonts.mono }}>
              {evaluation.length} / {evaluation.minLength}
            </Text>
          </View>
        </View>
      ) : null}
      <Field
        label="Confirm password"
        inputRef={confirmRef}
        value={confirmation}
        onChangeText={(t) => {
          setConfirmation(t);
          setError('');
        }}
        placeholder="Type it again"
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        editable={!busy}
        testID="signup-password-confirm-input"
      />
      <View style={{ minHeight: 20, marginTop: 6 }}>
        {mismatch ? <Text style={{ fontSize: 12, color: c.red }} testID="signup-confirm-mismatch">Does not match yet.</Text> : null}
        {matches ? <Text style={{ fontSize: 12, color: c.green }} testID="signup-confirm-match">Match.</Text> : null}
      </View>
      <TouchableOpacity onPress={() => setShow(!show)} accessibilityRole="button" style={{ alignSelf: 'flex-start', paddingVertical: 6 }} testID="signup-password-toggle">
        <Text style={s.linkText}>{show ? 'Hide password' : 'Show password'}</Text>
      </TouchableOpacity>
      {error ? <ErrorLine testID="signup-password-error">{error}</ErrorLine> : null}
      <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
        <SecondaryButton label="Back" onPress={() => ctx.undo('accept_terms')} testID="signup-password-back" style={{ flex: 0.5 }} />
        <PrimaryButton
          label={busy ? 'Checking' : 'Continue'}
          onPress={() => void submit()}
          busy={busy}
          disabled={!matches || !evaluation?.meetsMinimum}
          testID="signup-password-continue"
          style={{ flex: 1 }}
        />
      </View>
    </OnboardingFrame>
  );
}

// ── save_recovery_phrase (ceremony: save_phrase, then confirm_phrase) ────────

function SaveRecoveryPhraseStep({ ctx }: { ctx: CeremonyCtx }) {
  // Hide this screen from screenshots, screen recordings and the app switcher
  // while the words (or the confirmation of them) are on it.
  usePreventScreenCapture('signup-recovery-phrase');
  useAppSwitcherProtection();
  const { ceremony, screen } = ctx;
  const { s, c } = useOnboardingStyles();
  const [phase, setPhase] = useState<'loading' | 'show' | 'confirm'>('loading');
  const [words, setWords] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        await ceremony.beginPhrase(); // Argon2id, about a second
        setWords((await ceremony.phrase()).split(' '));
        setPhase('show');
      } catch (err) {
        setError(err instanceof CeremonyError ? ceremonyMessage(err.code) : 'Could not create your recovery phrase.');
        setPhase('show');
      }
    })();
    // Drop the words from React state when this step is left.
    return () => setWords([]);
  }, [ceremony]);

  async function acknowledge() {
    setBusy(true);
    setError('');
    try {
      await ceremony.acknowledgePhrase();
      const pos = await ceremony.challengePositions();
      setPositions(pos);
      setAnswers(pos.map(() => ''));
      setWords([]); // the confirm step needs no copy of the words; core compares
      setPhase('confirm');
    } catch (err) {
      setError(err instanceof CeremonyError ? ceremonyMessage(err.code) : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await ceremony.confirmPhrase(answers.map((a) => a.trim().toLowerCase()));
      setAnswers([]);
      ctx.done('save_recovery_phrase');
    } catch (err) {
      setError(err instanceof CeremonyError ? ceremonyMessage(err.code) : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function showAgain() {
    try {
      setWords((await ceremony.phrase()).split(' '));
      setPhase('show');
      setSaved(false);
      setError('');
    } catch {
      setError('The words are no longer available. Start over to get a new phrase.');
    }
  }

  if (phase === 'loading') {
    return (
      <OnboardingFrame title="Your recovery phrase" position={screen.position} total={screen.total} testID="signup-step-save_recovery_phrase">
        <Spinner label="Generating your recovery phrase" />
      </OnboardingFrame>
    );
  }

  if (phase === 'confirm') {
    return (
      <OnboardingFrame
        title="Confirm your phrase"
        subtitle="Type the words you wrote down. This is how we know you can recover your account."
        position={screen.position}
        total={screen.total}
        testID="signup-step-confirm_phrase"
      >
        {positions.map((pos, i) => (
          <Field
            key={pos}
            label={`Word ${pos}`}
            value={answers[i] ?? ''}
            onChangeText={(t) => {
              const next = answers.slice();
              next[i] = t;
              setAnswers(next);
              setError('');
            }}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            mono
            returnKeyType={i === positions.length - 1 ? 'go' : 'next'}
            onSubmitEditing={i === positions.length - 1 ? () => void confirm() : undefined}
            testID={`signup-phrase-answer-${pos}`}
          />
        ))}
        {error ? <ErrorLine testID="signup-phrase-error">{error}</ErrorLine> : null}
        <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl }}>
          <SecondaryButton label="Show words" onPress={() => void showAgain()} testID="signup-phrase-show-again" style={{ flex: 0.7 }} />
          <PrimaryButton
            label="Confirm"
            onPress={() => void confirm()}
            busy={busy}
            disabled={answers.some((a) => !a.trim())}
            testID="signup-phrase-confirm"
            style={{ flex: 1 }}
          />
        </View>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame
      title="Your recovery phrase"
      subtitle={`${words.length > 0 ? `These ${words.length} words are` : 'These words are'} the only way to recover your account. Write them down or save them in a password manager. We can't recover this for you.`}
      position={screen.position}
      total={screen.total}
      testID="signup-step-save_recovery_phrase"
    >
      {words.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 10,
            padding: spacing.md,
            backgroundColor: c.paper2,
            borderRadius: radii.lg,
            borderWidth: 1,
            borderColor: c.line,
            marginBottom: spacing.md,
          }}
          testID="signup-phrase-words"
        >
          {words.map((w, i) => (
            <View
              key={i}
              style={{
                flexBasis: '40%',
                flexGrow: 1,
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
              }}
            >
              <Text style={{ minWidth: 24, color: c.ink4, fontSize: 12, fontFamily: fonts.mono }} selectable={false}>
                {String(i + 1).padStart(2, '0')}
              </Text>
              {/* Not selectable: the words cannot be copied out of the app. */}
              <Text
                selectable={false}
                style={{ flex: 1, color: c.ink, fontSize: 15, fontFamily: fonts.mono, fontWeight: '700' }}
                testID={`signup-phrase-word-${i + 1}`}
              >
                {w}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={[s.notice, { borderColor: c.amber, backgroundColor: c.amberBg }]}>
        <Text style={{ fontSize: 13, color: c.ink, lineHeight: 18, fontWeight: '600' }}>
          Do not take a screenshot or a photo of these words, and do not paste them anywhere. Write them down.
        </Text>
      </View>
      {error ? <ErrorLine testID="signup-phrase-error">{error}</ErrorLine> : null}
      <CheckRow checked={saved} onChange={setSaved} testID="signup-phrase-saved-check">
        I have saved my recovery phrase offline.
      </CheckRow>
      <View style={{ marginTop: spacing.lg }}>
        <PrimaryButton
          label="I saved it, verify"
          onPress={() => void acknowledge()}
          busy={busy}
          disabled={!saved || words.length === 0}
          testID="signup-phrase-saved"
        />
      </View>
    </OnboardingFrame>
  );
}

// ── create_account ───────────────────────────────────────────────────────────

function CreateAccountStep({ ctx }: { ctx: CeremonyCtx }) {
  const { ceremony, session, ports, doc, screen, policy } = ctx;
  const { s } = useOnboardingStyles();
  const [status, setStatus] = useState('Setting up account encryption');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // register-finish went out and no verdict came back: the account may exist.
  const [unknown, setUnknown] = useState(false);
  // The account exists but this device's vault did not adopt the key: tell them before moving on.
  const [vaultNotice, setVaultNotice] = useState<Extract<CreateAccountOutcome, { kind: 'created' }> | null>(null);
  const running = useRef(-1);

  useEffect(() => {
    if (running.current === attempt) return;
    running.current = attempt;
    (async () => {
      setError('');
      // A document with no accept_terms step still has a Terms version to record.
      if (!session.current.termsVersion) session.current.termsVersion = policy.terms.version;
      const outcome = await runCreateAccount({
        ceremony,
        ports,
        session: session.current,
        onStatus: setStatus,
      });
      switch (outcome.kind) {
        case 'created':
          if (outcome.vaultAdopted) ctx.onCreated(outcome);
          else setVaultNotice(outcome);
          return;
        case 'unknown_outcome':
          setUnknown(true);
          return;
        case 'ticket_invalid':
          ctx.setNotice(TICKET_EXPIRED_NOTICE);
          ctx.undo('verify_email_code');
          return;
        case 'account_exists':
          ctx.onAccountExists(session.current.email);
          return;
        case 'failed_before_account':
          setError(createAccountMessage(outcome.rateLimited, outcome.code));
          return;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return (
    <OnboardingFrame title="Creating your account" position={screen.position} total={screen.total} testID="signup-step-create_account">
      {vaultNotice ? (
        <>
          <Text style={s.body} testID="signup-vault-notice">{VAULT_NOT_ADOPTED_MESSAGE}</Text>
          <View style={{ marginTop: spacing.xl }}>
            <PrimaryButton label="Continue" onPress={() => ctx.onCreated(vaultNotice)} testID="signup-vault-notice-continue" />
          </View>
        </>
      ) : unknown ? (
        <>
          <ErrorLine testID="signup-create-unknown">{UNKNOWN_OUTCOME_MESSAGE}</ErrorLine>
          <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl }}>
            <SecondaryButton label="Start over" onPress={ctx.startOver} testID="signup-unknown-start-over" style={{ flex: 0.8 }} />
            <PrimaryButton label="Go to sign in" onPress={ctx.cancel} testID="signup-unknown-sign-in" style={{ flex: 1 }} />
          </View>
        </>
      ) : error ? (
        <>
          <ErrorLine testID="signup-create-error">{error}</ErrorLine>
          <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl }}>
            <SecondaryButton label="Start over" onPress={ctx.startOver} testID="signup-start-over" style={{ flex: 0.8 }} />
            <PrimaryButton label="Try again" onPress={() => setAttempt((n) => n + 1)} testID="signup-try-again" style={{ flex: 1 }} />
          </View>
        </>
      ) : (
        <View testID="signup-create-progress">
          <Spinner label={status} />
        </View>
      )}
    </OnboardingFrame>
  );
}

// ── the flow ─────────────────────────────────────────────────────────────────

function renderStep(ctx: Ctx): React.ReactNode {
  const { ceremony } = ctx;
  const withCeremony = (render: (c: CeremonyCtx) => React.ReactNode): React.ReactNode =>
    ceremony ? (
      render({ ...ctx, ceremony })
    ) : (
      <OnboardingFrame title="Preparing encryption" position={ctx.screen.position} total={ctx.screen.total}>
        <Spinner label="Loading the encryption module" />
      </OnboardingFrame>
    );
  switch (ctx.screen.stepId) {
    case 'enter_email':
      return <EnterEmailStep ctx={ctx} />;
    case 'pilot_key':
      return <PilotKeyStep ctx={ctx} />;
    case 'verify_email_code':
      return <VerifyEmailCodeStep ctx={ctx} />;
    case 'accept_terms':
      return <AcceptTermsStep ctx={ctx} />;
    case 'set_password':
      return withCeremony((c) => <SetPasswordStep ctx={c} />);
    case 'save_recovery_phrase':
      return withCeremony((c) => <SaveRecoveryPhraseStep ctx={c} />);
    case 'create_account':
      return withCeremony((c) => <CreateAccountStep ctx={c} />);
    default:
      return null;
  }
}

/** Screens the planner can return that are not an interactive step. */
export function renderTerminalScreen(
  screen: Screen,
  opts: { onRefresh: () => void; onSignOut?: () => Promise<void>; onBack?: () => void },
): React.ReactNode {
  switch (screen.kind) {
    case 'update_required':
      return <UpdateRequired screen={screen} onSignOut={opts.onSignOut} />;
    case 'unsupported_schema':
      return <UnsupportedSchema screen={screen} onSignOut={opts.onSignOut} />;
    case 'signup_unavailable':
      return <SignupUnavailable screen={screen} onBack={opts.onBack} />;
    case 'fallback':
      return <StepFallback screen={screen} onSignOut={opts.onSignOut} />;
    case 'blocked':
      return <StepBlocked screen={screen} onRefresh={opts.onRefresh} onSignOut={opts.onSignOut} />;
    default:
      return null;
  }
}

export function SignupFlow({
  doc,
  ports,
  onCreated,
  onAccountExists,
  onCancel,
  onRefresh,
}: {
  doc: OnboardingDocument;
  ports: SignupPorts;
  /** The account exists: refresh auth. Called once. */
  onCreated: (o: Extract<CreateAccountOutcome, { kind: 'created' }>) => void;
  /** register-finish said the address already has an account. */
  onAccountExists: (email: string) => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const policy = doc.policy;
  const [completed, setCompleted] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState('');
  const [ceremony, setCeremony] = useState<SignupCeremony | null>(null);
  const [ceremonyFailed, setCeremonyFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const session = useRef<Session>(freshSession());

  const screen = useMemo(() => planScreen(doc, completed), [doc, completed]);

  const needsEmailVerification = doc.steps.some((st) => st.id === 'verify_email_code' && st.required);
  const minLength = policy?.password.minLength ?? 12;
  const verifyWordCount = policy?.recoveryPhrase.verifyWordCount ?? 3;
  const breachRequired = !!policy?.password.breachCheck;
  // The ceremony applies the value it was CONSTRUCTED with (a client cannot pick
  // it per call), so it must come from the document, not a constant.
  const breachFailOpen = policy?.password.breachCheck?.failOpen ?? true;

  // One ceremony per attempt. Re-created only when the numbers it was built from
  // change or the person starts over; disposed (abandon + release) on leave.
  useEffect(() => {
    let cancelled = false;
    let made: SignupCeremony | null = null;
    setCeremonyFailed(false);
    ports.ceremony
      .create({
        minLength,
        emailVerificationRequired: needsEmailVerification,
        verifyWordCount,
        breachCheckRequired: breachRequired,
        breachFailOpen,
      })
      .then((c) => {
        if (cancelled) {
          void c.dispose();
          return;
        }
        made = c;
        setCeremony(c);
      })
      .catch(() => {
        if (!cancelled) setCeremonyFailed(true);
      });
    return () => {
      cancelled = true;
      setCeremony(null);
      if (made) void made.dispose();
    };
  }, [ports.ceremony, minLength, verifyWordCount, breachRequired, breachFailOpen, needsEmailVerification, generation]);

  const done = useCallback((id: string) => setCompleted((prev) => new Set(prev).add(id)), []);
  const undo = useCallback(
    (...ids: string[]) =>
      setCompleted((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      }),
    [],
  );
  const startOver = useCallback(() => {
    session.current = freshSession();
    setCompleted(new Set());
    setNotice('');
    setGeneration((g) => g + 1);
  }, []);

  if (screen.kind !== 'step') {
    return <>{renderTerminalScreen(screen, { onRefresh, onBack: onCancel })}</>;
  }
  if (!policy) return null;

  if (ceremonyFailed) {
    return (
      <OnboardingFrame
        title="Encryption did not load"
        subtitle="The app needs its encryption module to create an account. Close the app, open it again and retry."
        testID="signup-ceremony-unavailable"
      >
        <PrimaryButton label="Try again" onPress={() => setGeneration((g) => g + 1)} testID="signup-ceremony-retry" />
      </OnboardingFrame>
    );
  }

  const ctx: Ctx = {
    doc,
    policy,
    ports,
    ceremony,
    session,
    screen,
    done,
    undo,
    notice,
    setNotice,
    startOver,
    cancel: onCancel,
    onCreated,
    onAccountExists,
    regionLine: doc.copy.region_line ?? null,
  };
  return <>{renderStep(ctx)}</>;
}
