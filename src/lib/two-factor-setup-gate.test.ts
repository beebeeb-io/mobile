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
});
