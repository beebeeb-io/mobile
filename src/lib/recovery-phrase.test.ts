// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  RECOVERY_WORD_COUNT,
  UnlockTimeoutError,
  normalizePhrase,
  unlockButtonLabel,
  withTimeout,
  wordsFromPhrase,
} from './recovery-phrase';

// Task 1428 — Apple's reviewer (iPad, Japanese locale) got stuck on the
// "Unlock your vault" screen: phrase field empty, 0/12 words, Unlock
// disabled, described as "unresponsive when tapped". These lock in the
// normalization + copy + timeout behavior that makes phrase entry bulletproof.

describe('normalizePhrase', () => {
  test('trims leading/trailing whitespace', () => {
    expect(normalizePhrase('  word ')).toBe('word');
  });

  test('lowercases capitalized words', () => {
    expect(normalizePhrase('Word One TWO')).toBe('word one two');
  });

  test('collapses multiple internal spaces to one', () => {
    expect(normalizePhrase('word  one   two')).toBe('word one two');
  });

  test('collapses newlines (multi-line paste) to a single space', () => {
    expect(normalizePhrase('word\none\ntwo')).toBe('word one two');
  });

  test('collapses tabs and non-breaking spaces (iPad IME quirks)', () => {
    expect(normalizePhrase('word\tone two')).toBe('word one two');
  });

  test('collapses a full-width ideographic space (Japanese IME)', () => {
    expect(normalizePhrase('word　one')).toBe('word one');
  });

  test('drops a trailing space left after pasting', () => {
    expect(normalizePhrase('one two three ')).toBe('one two three');
  });
});

describe('wordsFromPhrase', () => {
  test('empty input has zero words', () => {
    expect(wordsFromPhrase('')).toEqual([]);
  });

  test('whitespace-only input has zero words', () => {
    expect(wordsFromPhrase('   \n\t  ')).toEqual([]);
  });

  test('counts a pasted whole 12-word phrase regardless of formatting', () => {
    const pasted = 'Abandon  Ability\nAble\tAbout above absent absorb abstract absurd abuse access accident ';
    expect(wordsFromPhrase(pasted)).toHaveLength(12);
  });
});

describe('unlockButtonLabel', () => {
  test('says "Unlock vault" once exactly 12 words are present', () => {
    expect(unlockButtonLabel(RECOVERY_WORD_COUNT)).toBe('Unlock vault');
  });

  test('explains an empty field instead of just reading disabled', () => {
    expect(unlockButtonLabel(0)).toBe('Enter your 12-word phrase');
  });

  test('states the remaining count, singular, at 11 words', () => {
    expect(unlockButtonLabel(11)).toBe('1 more word needed');
  });

  test('states the remaining count, plural, at 7 words', () => {
    expect(unlockButtonLabel(7)).toBe('5 more words needed');
  });

  test('flags an over-long phrase (e.g. pasted twice) instead of staying silently disabled', () => {
    expect(unlockButtonLabel(13)).toBe('1 word too many');
    expect(unlockButtonLabel(24)).toBe('12 words too many');
  });
});

describe('withTimeout', () => {
  test('resolves with the underlying value when it settles before the timeout', async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('unlocked'), 5));
    await expect(withTimeout(fast, 200, 'too slow')).resolves.toBe('unlocked');
  });

  test('passes through the underlying rejection when it fails before the timeout', async () => {
    const failFast = new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error('wrong phrase')), 5),
    );
    await expect(withTimeout(failFast, 200, 'too slow')).rejects.toThrow('wrong phrase');
  });

  test('rejects with a typed UnlockTimeoutError once the bound is exceeded', async () => {
    const hangs = new Promise<string>(() => {
      /* never settles — simulates a stuck native bridge call */
    });
    await expect(withTimeout(hangs, 10, 'unlock timed out')).rejects.toBeInstanceOf(UnlockTimeoutError);
  });
});
