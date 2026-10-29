// @ts-nocheck
/**
 * Task 1746 (1753 pass 2, finding 7): every fixture require() sits inside an
 * `if (__DEV__) { ... }` block, so Metro folds them out of a release bundle.
 * Source-level: a require() outside the block would bundle the golden documents.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, 'dev-fixture.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('dev fixtures are dead code in a release build', () => {
  test('every require() is inside an if (__DEV__) block', () => {
    const open = src.indexOf('if (__DEV__) {', src.indexOf('function fixtureJson'));
    expect(open).toBeGreaterThan(-1);
    // find the matching close brace of that block
    let depth = 0;
    let close = -1;
    for (let i = src.indexOf('{', open); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    expect(close).toBeGreaterThan(open);
    const requires = [...src.matchAll(/require\(/g)].map((m) => m.index);
    expect(requires.length).toBe(6);
    for (const at of requires) {
      expect(at > open && at < close, `require at ${at} outside the __DEV__ block`).toBe(true);
    }
  });
});
