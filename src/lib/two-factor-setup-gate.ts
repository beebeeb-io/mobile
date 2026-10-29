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
 * button, iOS edge-swipe gesture, hardware back).
 *
 * True only when leaving would lose something that cannot be recovered:
 *  - step 3: 2FA is already active server-side and the backup codes on
 *    screen are never shown again;
 *  - step 2 while `verifying`: the enable request is in flight, the server
 *    may activate 2FA at any moment, and leaving now would skip step 3.
 *
 * Step 2 at rest is NOT blocked (flow fix, iOS core journeys P1). Nothing is
 * committed there — `enableTotp` only runs when the code is submitted, and
 * its success moves straight to step 3. Blocking step 2 trapped anyone who
 * pressed Continue before adding the key to their authenticator: no Back,
 * swipe-back disabled, the secret never shown again, force-quit the only
 * way out. (The earlier doc comment claimed step 2 "has already started
 * activating TOTP server-side"; that was wrong — see `handleEnable` in
 * TwoFactorSetupScreen.tsx.)
 *
 * `completed` (Codex P1 follow-up, PR #109 review) is the explicit escape
 * for the step-3 Done button: without it, the SAME `beforeRemove` listener
 * that correctly blocks a swipe/tap-away from step 3 also blocks the
 * `navigation.goBack()` Done itself calls once 2FA is enabled and the user
 * has acknowledged the backup codes — trapping them on the screen with no
 * way off it. The screen sets `completed` right before calling `goBack()`
 * from Done, and nowhere else.
 */
export function shouldBlockTwoFactorSetupBack(
  step: TwoFactorSetupStep,
  completed: boolean = false,
  verifying: boolean = false,
): boolean {
  if (completed) return false;
  if (step === 3) return true;
  return step === 2 && verifying;
}

/** What the screen's visible Back button does at a given step. */
export type TwoFactorSetupBackAction = 'leave' | 'previous-step' | 'none';

/**
 * The visible Back button: step 1 leaves the screen; step 2 returns to
 * step 1, which re-shows the SAME secret (the setup is held by the screen,
 * not re-fetched) so it can be copied into an authenticator; step 3 and an
 * in-flight verification show no Back at all.
 */
export function twoFactorSetupBackAction(
  step: TwoFactorSetupStep,
  verifying: boolean = false,
): TwoFactorSetupBackAction {
  if (shouldBlockTwoFactorSetupBack(step, false, verifying)) return 'none';
  return step === 1 ? 'leave' : 'previous-step';
}

// ── Task 1610: which mode the screen opens in, and where step-1 Back lands ──
//
// Bug: SettingsScreen's "Two-Factor Authentication" row always navigated
// here, and the screen always called `setupTotp()` — no code, no
// X-Confirm-Token — on mount. The server correctly requires step-up once
// 2FA is already on (`routes/totp.rs` `setup_step_up_validated_if_required`),
// so an already-enrolled account hit a raw 403 `confirmation_required` the
// instant it opened the option. `initialTwoFactorSetupMode` is the fix: the
// screen decides its OPENING mode from the account's already-known
// `totp_enabled` (from `useAuth()`, sourced from `/auth/me`) instead of
// always starting the fresh-enrollment wizard.

/** What TwoFactorSetupScreen shows first. */
export type TwoFactorSetupMode = 'on' | 'wizard';

/**
 * `totp_enabled: true` → open on the On state (Turn off / Set up again),
 * never call `setupTotp()` bare. `false` (or not yet known — `/auth/me`
 * always includes the field, but a defensive `undefined` reads the same as
 * off) → open directly in the fresh-enrollment wizard, unchanged from
 * before this task.
 */
export function initialTwoFactorSetupMode(totpEnabled: boolean | undefined): TwoFactorSetupMode {
  return totpEnabled ? 'on' : 'wizard';
}

/**
 * Where the wizard's step-1 Back button lands. A FRESH entry (2FA was off)
 * leaves the screen, exactly as before this task. A wizard reached via
 * "Set up again" (`cameFromReauth`) instead returns to the On state: the
 * account's PREVIOUS secret is still the live one server-side — `setup2fa`'s
 * new secret is not activated until `enable` succeeds (server `routes/totp.rs`,
 * the `enabled = FALSE` branch of its upsert) — so backing out here loses
 * nothing and must not be treated as abandoning an active 2FA setup.
 */
export function wizardStep1BackTarget(cameFromReauth: boolean): 'leave' | 'on' {
  return cameFromReauth ? 'on' : 'leave';
}
