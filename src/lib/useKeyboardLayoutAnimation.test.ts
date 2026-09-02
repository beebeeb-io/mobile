// @ts-nocheck
import { describe, expect, mock, test } from 'bun:test';

// The module under test also exports the `useKeyboardLayoutAnimation` hook,
// which imports Keyboard/Platform from 'react-native' at module load time —
// mock it so this file can import the pure function below without pulling in
// RN's real Flow-typed source (bun's test runner can't parse it).
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  Keyboard: { addListener: () => ({ remove: () => {} }) },
}));

const { computeSearchStackBottomPadding } = await import('./useKeyboardLayoutAnimation');

/**
 * MAJOR 2 (1338b review) reopened: the floating bottom search stack's
 * `KeyboardAvoidingView` lifts itself above the keyboard, but the FlatList's
 * `paddingBottom` only ever accounted for the stack's own measured height —
 * never the keyboard sitting underneath it. With the keyboard up, the space
 * the list actually has to clear is stack + gap + keyboard, not just
 * stack + gap, so the last row(s) stayed permanently behind the capsule row
 * no matter how far the list scrolled. Proven on-device with a Photos-filtered
 * list of 6 items (docs/_qa-evidence/glass-wave-2/1338b-qa4-04-true-end.png):
 * the crop above the search bar was byte-identical from the very first
 * render through 15 scroll swipes — there was no scroll distance left to
 * reach, because the missing keyboard term meant the content was already as
 * tall as it would ever get.
 */
describe('computeSearchStackBottomPadding', () => {
  test('sums the measured stack height, the gap, and the keyboard height', () => {
    expect(
      computeSearchStackBottomPadding({ stackHeight: 140, fallbackHeight: 168, gap: 12, keyboardHeight: 336 }),
    ).toBe(140 + 12 + 336);
  });

  test('falls back to fallbackHeight for the one frame before onLayout has measured the stack', () => {
    expect(
      computeSearchStackBottomPadding({ stackHeight: 0, fallbackHeight: 168, gap: 12, keyboardHeight: 336 }),
    ).toBe(168 + 12 + 336);
  });

  test('contributes zero once the keyboard is dismissed while search stays open — not a stale height', () => {
    expect(
      computeSearchStackBottomPadding({ stackHeight: 140, fallbackHeight: 168, gap: 12, keyboardHeight: 0 }),
    ).toBe(140 + 12);
  });

  test('never returns a negative padding for a negative keyboard height (defensive — should not occur in practice)', () => {
    expect(
      computeSearchStackBottomPadding({ stackHeight: 140, fallbackHeight: 168, gap: 12, keyboardHeight: -5 }),
    ).toBe(140 + 12);
  });
});
