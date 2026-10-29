// @ts-nocheck
/**
 * Task 1962 round 4 — Bug 7f/7h guard.
 *
 * `enqueueApplyQuality` is the only INSERT into the thumbnail queue
 * (`ThumbnailQueueDB.swift`). A JS call that was already in flight when the
 * account epoch advanced must not hand its ids to the native queue: a forced
 * sign-out resets and purges the queue, and a late enqueue would leave the
 * OUTGOING account's file ids in the new session's queue.
 *
 * Two invariants, both checked against the shipped sources:
 *   1. Every call site of `enqueueApplyQuality` is account-epoch guarded, and
 *      the epoch check is the statement IMMEDIATELY before the call — no
 *      `await` may sit between the check and the native call (an await
 *      yields the JS thread, and the sign-out could land in that gap).
 *   2. `enqueueApplyQuality`, `clearQueueOnSignOut` and
 *      `purgePlaintextStorage` stay plain synchronous `AsyncFunction`s on
 *      Expo's shared serial queue (no `runOnQueue`, no `async` closure), so
 *      the native order matches the JS order of the sign-out.
 *
 * Matrix 4's behavioural half (an advanced epoch makes the check fail) runs
 * against the real `account-epoch` module; this file mocks nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { accountEpoch, advanceAccountEpoch, isCurrentAccountEpoch } from './account-epoch';

const ROOT = join(import.meta.dir, '../..');
const SECURITY_SCREEN = join(ROOT, 'src/screens/ThumbnailQualityScreen.tsx');
const THUMBNAIL_MODULE = join(ROOT, 'modules/beebeeb-crypto/ios/ThumbnailServiceModule.swift');
const CRYPTO_MODULE = join(ROOT, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift');

function extractBody(source: string, signature: RegExp): string {
  const sigMatch = signature.exec(source);
  if (!sigMatch) {
    throw new Error(`signature not found: ${signature}`);
  }
  const openBraceIndex = source.indexOf('{', sigMatch.index + sigMatch[0].length);
  if (openBraceIndex === -1) {
    throw new Error(`no opening brace found after signature: ${signature}`);
  }
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error(`unbalanced braces after signature: ${signature}`);
}

function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const screenSource = readFileSync(SECURITY_SCREEN, 'utf8');
const screenLines = screenSource.split('\n');

/** Every live (non-comment) line index that calls `enqueueApplyQuality(`. */
function enqueueCallLineIndexes(): number[] {
  const indexes: number[] = [];
  screenLines.forEach((line, index) => {
    const live = stripLineComments(line);
    if (!live.includes('enqueueApplyQuality(')) return;
    if (live.trimStart().startsWith('*') || live.trimStart().startsWith('import')) return;
    indexes.push(index);
  });
  return indexes;
}

/** The previous live (non-blank, non-comment) line before `index`. */
function previousLiveLine(index: number): { lineNumber: number; text: string } {
  for (let i = index - 1; i >= 0; i -= 1) {
    const live = stripLineComments(screenLines[i]).trim();
    if (live === '' || live.startsWith('*') || live.startsWith('/*')) continue;
    return { lineNumber: i, text: live };
  }
  throw new Error(`no live line before ${index}`);
}

describe('every enqueueApplyQuality call site is account-epoch guarded (7f)', () => {
  const callSites = enqueueCallLineIndexes();

  test('the extractor finds the call site (sanity)', () => {
    expect(callSites.length).toBe(1);
  });

  test('the epoch check is the statement immediately before the native call', () => {
    for (const index of callSites) {
      const previous = previousLiveLine(index);
      expect(previous.text).toMatch(/if\s*\(!isCurrentAccountEpoch\(epoch\)\)\s*return;?$/);
    }
  });

  test('no await sits between the epoch check and the native call', () => {
    for (const index of callSites) {
      const previous = previousLiveLine(index);
      expect(previous.text).not.toContain('await');
      // ...and the call itself is the very next statement (adjacent line).
      expect(previous.lineNumber).toBe(index - 1);
    }
  });

  test('the screen captures the account epoch before the work starts', () => {
    // Strip comments first: the doc comment above the capture legitimately
    // names `await`, and it must not count as the first suspension point.
    const body = stripLineComments(
      extractBody(screenSource, /const handleApply = useCallback\(async \(\) =>/),
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const capture = body.search(/const\s+epoch\s*=\s*accountEpoch\(\)/);
    expect(capture).toBeGreaterThanOrEqual(0);
    // capture happens before the first await inside the handler
    const firstAwait = body.indexOf('await ');
    expect(firstAwait).toBeGreaterThanOrEqual(0);
    expect(capture).toBeLessThan(firstAwait);
  });
});

describe('matrix 4: an enqueue after the epoch advanced is dropped by the guard', () => {
  test('isCurrentAccountEpoch is false once the account epoch advances', () => {
    const captured = accountEpoch();
    expect(isCurrentAccountEpoch(captured)).toBe(true);
    advanceAccountEpoch();
    expect(isCurrentAccountEpoch(captured)).toBe(false);
  });
});

describe('sign-out native functions stay synchronous on Expo\'s shared serial queue (7f, 7h)', () => {
  const thumbnailModule = readFileSync(THUMBNAIL_MODULE, 'utf8');
  const cryptoModule = readFileSync(CRYPTO_MODULE, 'utf8');

  const cases: Array<[string, string, RegExp]> = [
    ['enqueueApplyQuality', thumbnailModule, /AsyncFunction\("enqueueApplyQuality"\)/],
    ['clearQueueOnSignOut', thumbnailModule, /AsyncFunction\("clearQueueOnSignOut"\)/],
    ['purgePlaintextStorage', cryptoModule, /AsyncFunction\("purgePlaintextStorage"\)/],
  ];

  for (const [name, source, signature] of cases) {
    test(`${name} does not hop queues or wrap an async closure`, () => {
      const body = stripLineComments(extractBody(source, signature));
      expect(body).not.toContain('runOnQueue');
      expect(body).not.toMatch(/\bTask\s*\{/);
      expect(body).not.toMatch(/\basync\b/);
      expect(body).not.toMatch(/\bawait\b/);
    });
  }

  test('clearQueueOnSignOut still cancels the pool and clears the queue (7h)', () => {
    const body = stripLineComments(extractBody(thumbnailModule, /AsyncFunction\("clearQueueOnSignOut"\)/));
    expect(body).toContain('cancelAll()');
    expect(body).toContain('clearAll()');
  });
});
