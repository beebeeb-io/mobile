// @ts-nocheck
// Task 1591 bug 4 — recovery phrase step: the logo overlapped the wordmark
// (48 pt mark inside a 44 pt box, no gap) and the screen had TWO amber
// buttons ("Copy all words" + "I've saved my recovery phrase"). Brand rule:
// ONE amber primary action per screen. Source guard (no React reconciler
// under bun test). Mutation evidence: task 1591 Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'OnboardingScreen.tsx'), 'utf-8');

function stepBlock(step: string, next: string): string {
  const a = source.indexOf(`{step === '${step}' && (`);
  const b = source.indexOf(`{step === '${next}' && (`);
  if (a < 0 || b < 0) throw new Error(`step block ${step} not found`);
  return source.slice(a, b);
}

describe('OnboardingScreen — one amber primary per step', () => {
  for (const [step, next] of [['phrase', 'verify'], ['verify', 'files'], ['files', 'done']]) {
    test(`step "${step}" has exactly one primaryButton`, () => {
      const n = (stepBlock(step, next).match(/styles\.primaryButton/g) ?? []).length;
      expect(n).toBe(1);
    });
  }

  test('"Copy all words" is the secondary button', () => {
    const block = stepBlock('phrase', 'verify');
    const copyAt = block.indexOf("'Copy all words'");
    const tagStart = block.lastIndexOf('<TouchableOpacity', copyAt);
    expect(block.slice(tagStart, copyAt)).toContain('styles.secondaryButton');
  });
});

describe('OnboardingScreen — brand row', () => {
  test('mark and wordmark are siblings in a row with a gap, no overhanging box', () => {
    expect(source).not.toContain('logoWrap');
    expect(source).toMatch(/brand:\s*\{[^}]*flexDirection:\s*'row'[^}]*gap:\s*\d+/s);
    expect(source).toMatch(/<View style=\{styles\.brand\}[^>]*>\s*<BBLogo size=\{36\} \/>\s*<BBWordmark size=\{20\} \/>/);
  });
});

describe('text on amber stays dark in both themes', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf-8');
  test('OnboardingScreen primary button text uses onAmber, not the theme ink', () => {
    expect(source).toMatch(/buttonText:\s*\{[^}]*color:\s*onAmber/s);
  });
  test('Trust sheet "Prove it" and the proof download button use onAmber', () => {
    expect(read('../components/TrustDetailsSheet.tsx')).toMatch(/proveBtnText, \{ color: onAmber \}/);
    expect(read('../components/EncryptionProof.tsx')).toMatch(/downloadBtnText, \{ color: onAmber \}/);
  });
  test('onAmber is the light-theme ink, not the dark-theme one', async () => {
    const theme = await import('../theme');
    expect(theme.onAmber).toBe(theme.colors.ink);
    expect(theme.onAmber).not.toBe(theme.darkColors.ink);
  });
});
