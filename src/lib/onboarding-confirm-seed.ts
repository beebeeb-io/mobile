/**
 * The task-1444 welcome.md seed trigger for `OnboardingScreen.handleConfirm`
 * — the in-app signup flow's ACTUAL phrase-verify step.
 *
 * (SignupScreen -> `skipOnboarding` -> App.tsx navigates to the
 * `RecoveryPhrase` route, which renders `OnboardingScreen`, NOT
 * `RecoveryPhraseVerifyScreen` — that screen is only reached via the
 * separate recovery / verify-later routes. `RecoveryPhraseVerifyScreen`
 * already fires `ensureUnlockedAndSeed` on its own confirm handler.)
 *
 * Extracted as a pure function so the actual trigger condition is unit
 * testable without a React Native component renderer (this repo has no
 * `@testing-library/react-native` — see CLAUDE.md "Tests"; all coverage here
 * is plain `bun:test` against pure logic, matching `welcome-seed.test.ts`).
 *
 * Mirrors `handleConfirm`'s own `if (!allCorrect) return` gate as a
 * belt-and-braces guard (same defense-in-depth pattern `welcome-seed.ts`
 * already uses for its own idempotency checks) — this function must never
 * fire the seed on incorrect verification words even if a future edit to
 * the screen ever called it before that gate.
 */
import { ensureUnlockedAndSeed, type EnsureUnlockedAndSeedOptions } from './welcome-seed';

export interface ConfirmPhraseAndSeedOptions {
  /** OnboardingScreen's own `allCorrect` — true only once all 3 verify words match. */
  allCorrect: boolean;
  /** `useAuth().user?.user_id` — undefined if somehow unauthenticated at this point. */
  userId: string | undefined;
  isUnlocked: EnsureUnlockedAndSeedOptions['isUnlocked'];
  unlock: EnsureUnlockedAndSeedOptions['unlock'];
  encryptChunkFn: EnsureUnlockedAndSeedOptions['encryptChunkFn'];
  encryptMetadataFn: EnsureUnlockedAndSeedOptions['encryptMetadataFn'];
}

/**
 * Fire-and-forget: never blocks `handleConfirm`'s step transition, and never
 * throws (both `ensureUnlockedAndSeed` and `seedWelcomeMarkdown` swallow
 * their own errors after logging).
 */
export function confirmPhraseAndSeed(opts: ConfirmPhraseAndSeedOptions): void {
  if (!opts.allCorrect) return;
  if (!opts.userId) {
    console.info('[welcome-seed] seed skipped: no authenticated user at verify time');
    return;
  }
  void ensureUnlockedAndSeed({
    userId: opts.userId,
    isUnlocked: opts.isUnlocked,
    unlock: opts.unlock,
    encryptChunkFn: opts.encryptChunkFn,
    encryptMetadataFn: opts.encryptMetadataFn,
  });
}
