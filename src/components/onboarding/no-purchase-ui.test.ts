// @ts-nocheck
/**
 * Task 1746: the NO PURCHASE posture (App Store 3.1.3, task 1400, spec 4b.7) as a
 * source-level guard. The iOS accessibility hierarchy does not expose "clickable",
 * so the simulator rung asserts on ALL text and labels; this file closes the other
 * half: the status components contain no touchable at all, and nothing under
 * `src/lib/onboarding` or `src/components/onboarding` reaches a billing, checkout or
 * trial-start endpoint or opens a URL other than the sanctioned ones.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const sources = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
    .map((f) => [`${dir}/${f}`, read(`${dir}/${f}`)]);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('status components are inert', () => {
  test('AccountStatusCard has no touchable, no press handler, no link', () => {
    const src = strip(read('components/onboarding/AccountStatusCard.tsx'));
    expect(src.length).toBeGreaterThan(500); // we read real code, not an empty file
    for (const word of ['TouchableOpacity', 'TouchableHighlight', 'Pressable', 'onPress', 'Linking', 'openURL', 'Button', 'navigation']) {
      expect(src.includes(word), word).toBe(false);
    }
  });
});

describe('nothing in the onboarding code can reach a purchase', () => {
  const files = [...sources('lib/onboarding'), ...sources('components/onboarding')];

  test('we scanned the real file set', () => {
    expect(files.length).toBeGreaterThan(25);
  });

  test('no billing, checkout, trial-start or plans endpoint appears in code', () => {
    for (const [name, raw] of files) {
      const src = strip(raw);
      for (const needle of ['/billing/', 'trial/start', '/checkout', 'billing_profile', 'start_trial', 'choose_plan', 'external_link', 'system_browser']) {
        // The planner and parser must NAME the steps they refuse; everywhere else the word must not occur.
        if (/(plan|parse|types|fixtures|overlay-screen|dev-fixture)\.ts$/.test(name)) continue;
        expect(src.includes(needle), `${name}: ${needle}`).toBe(false);
      }
    }
  });

  test('Linking.openURL appears only where the URL comes from fallbackAction, the terms links, or support', () => {
    const allowed = new Set([
      'components/onboarding/BlockingScreens.tsx', // action.url from fallbackAction (App Store, support mail, web only when links are on)
      'components/onboarding/SignupFlow.tsx', // terms and privacy pages (legal, not a purchase)
    ]);
    for (const [name, raw] of files) {
      if (strip(raw).includes('openURL')) expect(allowed.has(name), name).toBe(true);
    }
  });

  test('the launch binary compiles in no purchase surface', () => {
    expect(strip(read('lib/onboarding/types.ts'))).toContain('COMPILED_PURCHASE_SURFACES: readonly PurchaseSurface[] = [];');
  });
});
