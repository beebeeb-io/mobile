// Pure router-decision helpers for task 1445 (ruling 2, 2026-09-21).
//
// Bug: a fresh in-app signup persists the session + master key immediately.
// If the app is killed while the user is still on the recovery-phrase /
// verify onboarding steps (before `markPhraseVerified()` runs) and
// relaunched, the cold-start router used to put the user straight into the
// vault — the phrase was never confirmed, and (per PR #97) the welcome seed
// never ran either.
//
// The original ruling asked to resume onboarding and re-show the words.
// That turned out to be cryptographically impossible: the master key is a
// one-way Argon2id derivation of the BIP39 mnemonic entropy
// (`repos/core/beebeeb-core/src/recovery.rs`), and the phrase itself is
// never persisted anywhere on-device or server-side by design
// (`modules/beebeeb-crypto/src/BeebeebCrypto.ts` — "shown once and never
// stored"). Ruling 2 instead routes to a dedicated blocking screen
// (`PhraseNotConfirmedScreen`) that offers re-verifying the phrase (compared
// against the persisted master key, never re-derived from it) or starting
// over.
//
// Kept dependency-free (no React/RN imports), matching `startup-auth.ts` /
// `recovery-phrase.ts` — the logic is unit-tested directly, App.tsx wires it
// to SecureStore + navigation.

/** The three states `PHRASE_VERIFIED_KEY` (App.tsx) can be read as. `null` covers both an absent key (legacy user / pre-phrase-flow) and any unreadable SecureStore error — both mean "verified". */
export type PhraseMarkerState = 'pending' | 'verified' | null;

export interface PhraseGateInput {
  /** `user !== null` in App.tsx — a live session exists. */
  isAuthenticated: boolean;
  /** App.tsx's `phraseVerified` state, computed from `PHRASE_VERIFIED_KEY` at startup. */
  phraseVerified: boolean;
  /**
   * True only during the SAME JS session that just called `skipOnboarding()`
   * (signup) — the actual phrase words are still held in memory
   * (`pendingRecoveryPhrase`). This is the ONLY condition under which
   * OnboardingScreen can legitimately show the real words; it is always
   * `false` after a genuine process relaunch (the in-memory state resets).
   */
  hasInMemoryPendingPhrase: boolean;
}

/**
 * True when the app should route to the blocking `PhraseNotConfirmed`
 * screen instead of the vault (Tabs). This is deliberately DISJOINT from
 * the live-signup path (`hasInMemoryPendingPhrase`): that path still shows
 * the real words via the existing OnboardingScreen redirect. This gate only
 * fires when the words are genuinely gone — a cold relaunch mid-onboarding.
 */
export function shouldRouteToPhraseGate(input: PhraseGateInput): boolean {
  return input.isAuthenticated && !input.phraseVerified && !input.hasInMemoryPendingPhrase;
}

/**
 * True when a stale `PHRASE_VERIFIED_KEY: 'pending'` marker must be wiped
 * on this boot because there is no session to which it could belong.
 * `PHRASE_VERIFIED_KEY` is a single, device-global SecureStore key (not
 * namespaced per account) — without this, an interrupted signup's 'pending'
 * marker would silently leak into whichever account logs in next on this
 * device and incorrectly block that account's vault.
 */
export function shouldClearPendingMarkerOnBoot(input: {
  tokenExists: boolean;
  phraseKey: PhraseMarkerState;
}): boolean {
  return !input.tokenExists && input.phraseKey === 'pending';
}
