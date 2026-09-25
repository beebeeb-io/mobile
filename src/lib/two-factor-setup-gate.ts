// Task 1539 (finding 2): pure gate decision for TwoFactorSetupScreen's
// back-navigation guard. Kept dependency-free (no React/RN imports),
// matching phrase-confirmation-gate.ts / startup-auth.ts — the logic is
// unit-tested directly, the screen wires it to its custom back button,
// `navigation.setOptions({ gestureEnabled })`, and a `beforeRemove` listener.
//
// Bug this replaces: the screen's back-button handler read
//   `if (step > 1) { navigation.goBack(); } else { navigation.goBack(); }`
// — both branches identical, so the comment above it ("Only allow going back
// from step 1 (steps 2-3 are forward-only after enabling)") was never
// actually enforced. A user could swipe/tap away from step 3 (backup codes,
// shown exactly once, 2FA already active server-side) and lose them
// permanently with no way to see them again.

/** TwoFactorSetupScreen's three steps: 1 = view secret, 2 = verify code, 3 = one-time backup codes. */
export type TwoFactorSetupStep = 1 | 2 | 3;

/**
 * Whether the screen must block every way of leaving (header/custom back
 * button, iOS edge-swipe gesture, hardware back). True for steps 2 and 3:
 * step 2 has already started activating TOTP server-side, and step 3 shows
 * backup codes that are never shown again. Only step 1 — before anything is
 * committed — may be left freely.
 */
export function shouldBlockTwoFactorSetupBack(step: TwoFactorSetupStep): boolean {
  return step > 1;
}
