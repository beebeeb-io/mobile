// @ts-nocheck
/**
 * Task 2253 round 2 (mobile#254 review P2): when the share sheet is not
 * available, the Preview download used to answer "Saved to <path>". That path
 * is the per-export copy, which the `finally` releases a moment later, so the
 * alert named a file that was already gone. The no-share branch says plainly
 * that saving is not available, and never shows the export URI.
 *
 * The check runs on the real source (must pass) AND on an in-memory mutation
 * that restores the old alert (must fail).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const screen = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf8');

/** The `else { ... }` after the download's `Sharing.shareAsync(shareUri` call. */
function noShareBranch(src: string): string {
  const share = src.indexOf('await Sharing.shareAsync(shareUri, {');
  if (share < 0) throw new Error('download share call not found');
  const elseAt = src.indexOf('} else {', share);
  if (elseAt < 0) throw new Error('no-share branch not found');
  const open = src.indexOf('{', elseAt + 2);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i).replace(/\/\/[^\n]*/g, '');
    }
  }
  throw new Error('unbalanced no-share branch');
}

const honest = (src: string) => {
  const b = noShareBranch(src);
  return (
    b.includes("Alert.alert('Not available', 'Saving is not available on this device.');") &&
    !b.includes('shareUri') &&
    !/Saved to/.test(b)
  );
};

describe('2253 round 2: the no-share branch never names the released copy', () => {
  test('real source: an honest "not available", no path', () => {
    expect(honest(screen)).toBe(true);
  });

  test('mutation: the old "Saved to ${shareUri}" alert fails the check', () => {
    const mutated = screen.replace(
      "Alert.alert('Not available', 'Saving is not available on this device.');",
      'Alert.alert(\'Downloaded\', `Saved to ${shareUri}`);',
    );
    expect(mutated).not.toBe(screen);
    expect(honest(mutated)).toBe(false);
  });
});
