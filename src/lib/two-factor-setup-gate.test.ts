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
import { shouldBlockTwoFactorSetupBack } from './two-factor-setup-gate';

describe('shouldBlockTwoFactorSetupBack', () => {
  test('step 1 (viewing the secret, nothing committed) may leave freely', () => {
    expect(shouldBlockTwoFactorSetupBack(1)).toBe(false);
  });

  test('step 2 (mid-verification) is blocked', () => {
    expect(shouldBlockTwoFactorSetupBack(2)).toBe(true);
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

  test('completed defaults to false — omitting it preserves the existing step>1 behavior', () => {
    expect(shouldBlockTwoFactorSetupBack(3)).toBe(true);
    expect(shouldBlockTwoFactorSetupBack(2)).toBe(true);
    expect(shouldBlockTwoFactorSetupBack(1)).toBe(false);
  });
});
