// @ts-nocheck
/**
 * Task 1746 (1753 pass 2, finding 2): every screen that can cover a SIGNED-IN account
 * offers Sign out, so a person is never trapped behind a blocking overlay. Source-level
 * guard (no renderer under bun): AccountOverlay passes `onSignOut` to each blocking
 * screen, and each of those screens renders a Sign out button when it gets one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (f) => readFileSync(join(__dirname, f), 'utf8');

describe('blocking overlays always offer Sign out', () => {
  const overlay = read('AccountOverlay.tsx');
  const screens = read('BlockingScreens.tsx');

  test('AccountOverlay hands signOut to every blocking screen it renders', () => {
    for (const comp of ['UpdateRequired', 'UnsupportedSchema', 'StepFallback', 'StepBlocked']) {
      const m = overlay.match(new RegExp(`<${comp}\\b[^>]*>`));
      expect(m, comp).not.toBeNull();
      expect(m[0], comp).toContain('onSignOut={signOut}');
    }
  });

  test('UnsupportedSchema renders a Sign out button when given the handler', () => {
    const body = screens.slice(screens.indexOf('export function UnsupportedSchema'), screens.indexOf('export function SignupUnavailable'));
    expect(body).toContain('onSignOut?: () => Promise<void>');
    expect(body).toContain('testID="unsupported-schema-sign-out"');
    expect(body).toContain('label="Sign out"');
  });
});
