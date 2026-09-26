// @ts-nocheck
// Task 1539 (finding 2) — 2FA setup back-navigation guard.
//
// RED on main: `src/lib/two-factor-setup-gate.ts` does not exist on main at
// all (the screen's back-button handler had
//   `if (step > 1) { navigation.goBack(); } else { navigation.goBack(); }`
// inline — both branches identical, dead conditional, no extracted gate to
// import), so this whole file fails at the module-resolution step:
//   error: Cannot find module '../lib/two-factor-setup-gate' from ...
// That failure — not a passing-but-wrong assertion — is the RED this test
// was written against. See the task Notes for the pasted failure.
import { describe, expect, test } from 'bun:test';
import { shouldBlockTwoFactorSetupBack, twoFactorSetupBackAction } from './two-factor-setup-gate';

describe('shouldBlockTwoFactorSetupBack', () => {
  test('step 1 (viewing the secret, nothing committed) may leave freely', () => {
    expect(shouldBlockTwoFactorSetupBack(1)).toBe(false);
  });

  // Flow fix (iOS core journeys, P1): step 2 used to be blocked, which
  // trapped a user who pressed Continue before adding the key to their
  // authenticator — no Back, swipe-back disabled, secret never shown again;
  // the only escape was force-quitting. Nothing is committed server-side at
  // step 2 (enableTotp only runs when the code is submitted, and success
  // moves straight to step 3), so step 2 must NOT block removal.
  test('step 2 (entering the code, nothing enabled yet) is NOT blocked — the trap this fixes', () => {
    expect(shouldBlockTwoFactorSetupBack(2)).toBe(false);
  });

  // While the enable request is in flight the server may activate 2FA at
  // any moment; leaving then would lose the one-time backup codes.
  test('step 2 while the enable request is in flight IS blocked', () => {
    expect(shouldBlockTwoFactorSetupBack(2, false, true)).toBe(true);
  });

  test('step 3 (one-time backup codes, TOTP already active server-side) is blocked', () => {
    expect(shouldBlockTwoFactorSetupBack(3)).toBe(true);
  });

  // Codex P1 follow-up (PR #109 review): the `beforeRemove` listener this
  // gate drives blocks EVERY goBack() while step > 1 — including the one
  // the step-3 Done button calls after the user has acknowledged their
  // backup codes and 2FA is fully enabled. Without an explicit escape, Done
  // silently does nothing and the user is trapped on the screen.
  test('step 3 with completed=true (Done pressed) is NOT blocked — the trap this fixes', () => {
    expect(shouldBlockTwoFactorSetupBack(3, true)).toBe(false);
  });

  test('step 2 with completed=true is also not blocked (defensive — Done only exists on step 3, but the flag should win regardless of step)', () => {
    expect(shouldBlockTwoFactorSetupBack(2, true)).toBe(false);
  });

  test('defaults (completed=false, verifying=false): only step 3 blocks', () => {
    expect(shouldBlockTwoFactorSetupBack(3)).toBe(true);
    expect(shouldBlockTwoFactorSetupBack(2)).toBe(false);
    expect(shouldBlockTwoFactorSetupBack(1)).toBe(false);
  });
});

describe('twoFactorSetupBackAction (the visible Back button)', () => {
  test('step 1 leaves the screen', () => {
    expect(twoFactorSetupBackAction(1)).toBe('leave');
  });

  test('step 2 returns to step 1 so the secret can be seen and copied again', () => {
    expect(twoFactorSetupBackAction(2)).toBe('previous-step');
  });

  test('step 2 while verifying has no Back', () => {
    expect(twoFactorSetupBackAction(2, true)).toBe('none');
  });

  test('step 3 (one-time backup codes) has no Back — Done is the only way out', () => {
    expect(twoFactorSetupBackAction(3)).toBe('none');
  });
});
