// Pure orchestration for PhraseNotConfirmedScreen's "verify" step (task 1445
// ruling 2), extracted so the exact sequence — compare, then mark verified,
// then seed, exactly once each, only on a match — is unit-testable without
// rendering the screen (this repo has no @testing-library/react-native).
// Mirrors the dependency-injection shape `onboarding-confirm-seed.ts` /
// `welcome-seed.ts` already use for the same class of problem.

export type PhraseVerificationOutcome = 'verified' | 'mismatch';

export interface AttemptPhraseVerificationDeps {
  /** `crypto.verifyRecoveryPhrase` — compare-only, never writes (see recovery-phrase-verify.ts). */
  verifyRecoveryPhrase: (phrase: string) => Promise<boolean>;
  /** `useAuth().markPhraseVerified` — flips PHRASE_VERIFIED_KEY to 'verified'. */
  markPhraseVerified: () => Promise<void>;
  /** `confirmPhraseAndSeed(...)` — fire-and-forget, already a no-op unless allCorrect. */
  seed: () => void;
}

/**
 * On a match: marks the phrase verified, fires the seed exactly once, and
 * returns 'verified'. On a mismatch: touches NOTHING — `markPhraseVerified`
 * and `seed` are not called — and returns 'mismatch' so the screen can show
 * an error and stay put. Never throws (verifyRecoveryPhrase itself never
 * throws — see recovery-phrase-verify.ts).
 */
export async function attemptPhraseVerification(
  phrase: string,
  deps: AttemptPhraseVerificationDeps,
): Promise<PhraseVerificationOutcome> {
  const ok = await deps.verifyRecoveryPhrase(phrase);
  if (!ok) return 'mismatch';
  await deps.markPhraseVerified();
  deps.seed();
  return 'verified';
}
