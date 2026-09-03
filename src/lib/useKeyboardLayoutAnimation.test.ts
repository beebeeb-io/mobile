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
 * the list actually has to clear is bar + keyboard, not just the bar, so the
 * last row(s) stayed permanently behind the capsule row no matter how far
 * the list scrolled. Proven on-device with a Photos-filtered list of 6 items
 * (docs/_qa-evidence/glass-wave-2/1338b-qa4-04-true-end.png): the crop above
 * the search bar was byte-identical from the very first render through 15
 * scroll swipes — there was no scroll distance left to reach, because the
 * missing keyboard term meant the content was already as tall as it would
 * ever get.
 *
 * 1357 — Guus's layout ruling moved the filter capsules out of this stack
 * entirely (they now live at the top of the content area, inside
 * `headerArea`, so `headerHeight`/`ScrollEdgeBlur` already account for them —
 * see FilesScreen.tsx) and turned the bottom stack into a single flush bar
 * (search input + Cancel) that REPLACES `GlassTabBar` in its own footprint
 * rather than floating a fixed `gap` above it. There is no floating gap to
 * add any more — the bar sits flush against the screen's own bottom edge —
 * so the `gap` term is gone and `stackHeight` is renamed `barHeight` to say
 * what it now actually measures: the one-row bar, not a 3-piece stack.
 */
describe('computeSearchStackBottomPadding', () => {
  test('sums the measured bar height and the keyboard height', () => {
    expect(
      computeSearchStackBottomPadding({ barHeight: 82, fallbackHeight: 70, keyboardHeight: 336 }),
    ).toBe(82 + 336);
  });

  test('falls back to fallbackHeight for the one frame before onLayout has measured the bar', () => {
    expect(
      computeSearchStackBottomPadding({ barHeight: 0, fallbackHeight: 70, keyboardHeight: 336 }),
    ).toBe(70 + 336);
  });

  test('contributes zero once the keyboard is dismissed while search stays open — not a stale height', () => {
    expect(
      computeSearchStackBottomPadding({ barHeight: 82, fallbackHeight: 70, keyboardHeight: 0 }),
    ).toBe(82);
  });

  test('never returns a negative padding for a negative keyboard height (defensive — should not occur in practice)', () => {
    expect(
      computeSearchStackBottomPadding({ barHeight: 82, fallbackHeight: 70, keyboardHeight: -5 }),
    ).toBe(82);
  });
});
