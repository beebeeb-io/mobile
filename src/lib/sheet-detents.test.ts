// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1586 — the detent / snap / rubber-band math of the shared bottom sheet.
// Mutation evidence is in task 1586's Notes.
import { describe, expect, test } from 'bun:test';
import {
  SHEET_DISMISS_FRACTION,
  SHEET_FLING_DISMISS_VELOCITY,
  SHEET_TOP_GAP,
  adjustDetent,
  computeDetents,
  detentAccessibilityValue,
  displayedTranslate,
  resolveSheetSnap,
  rubberBand,
  rubberBandInterpolation,
  sheetLayoutHeight,
  translateForDetent,
} from './sheet-detents';

// iPhone 17 Pro: 874pt tall, 62pt top inset.
const H = 874;
const TOP = 62;
const all = computeDetents(['half', 'default', 'large'], H, TOP);

describe('computeDetents', () => {
  test('half ~50 %, default ~72 %, large ~90 %, ascending', () => {
    expect(all.map((d) => d.name)).toEqual(['half', 'default', 'large']);
    expect(all.map((d) => d.height)).toEqual([437, 629, 787]);
  });

  test('never reaches under the top inset', () => {
    const tight = computeDetents(['large'], 600, 100);
    expect(tight[0].height).toBe(600 - 100 - SHEET_TOP_GAP);
  });

  test('order of the names does not matter; duplicates after capping collapse', () => {
    expect(computeDetents(['large', 'half'], H, TOP).map((d) => d.name)).toEqual(['half', 'large']);
    // 300pt available, 250 top inset → cap 38: every detent caps to the same height.
    expect(computeDetents(['half', 'default', 'large'], 300, 250)).toHaveLength(1);
  });

  test('layout height is the tallest detent; translate rests each detent', () => {
    const sheetH = sheetLayoutHeight(all);
    expect(sheetH).toBe(787);
    expect(translateForDetent(sheetH, all[2].height)).toBe(0);
    expect(translateForDetent(sheetH, all[0].height)).toBe(350);
  });
});

describe('resolveSheetSnap', () => {
  test('a slow release lands on the nearest detent', () => {
    // Dragged the default (629) down to 470: nearest is half (437).
    expect(resolveSheetSnap({ visibleHeight: 470, velocityY: 0, detents: all })).toEqual({ kind: 'detent', index: 0 });
    // 560 is nearer default (629) than half (437).
    expect(resolveSheetSnap({ visibleHeight: 560, velocityY: 0, detents: all })).toEqual({ kind: 'detent', index: 1 });
    // Pulled up to 740: large.
    expect(resolveSheetSnap({ visibleHeight: 740, velocityY: 0, detents: all })).toEqual({ kind: 'detent', index: 2 });
  });

  test('velocity carries the release to the next detent', () => {
    // 600 alone is nearest default; a 600 pt/s upward flick projects to 672 → still
    // default, a 1200 pt/s one to 744 → large.
    expect(resolveSheetSnap({ visibleHeight: 600, velocityY: -600, detents: all })).toEqual({ kind: 'detent', index: 1 });
    expect(resolveSheetSnap({ visibleHeight: 600, velocityY: -1200, detents: all })).toEqual({ kind: 'detent', index: 2 });
    // A downward flick from default: 600 + 1000 pt/s → 480 → half.
    expect(resolveSheetSnap({ visibleHeight: 600, velocityY: 1000, detents: all })).toEqual({ kind: 'detent', index: 0 });
  });

  test('dragging below the dismiss threshold dismisses', () => {
    const threshold = all[0].height * SHEET_DISMISS_FRACTION; // 262.2
    expect(resolveSheetSnap({ visibleHeight: threshold - 1, velocityY: 0, detents: all })).toEqual({ kind: 'dismiss' });
    expect(resolveSheetSnap({ visibleHeight: threshold + 1, velocityY: 0, detents: all })).toEqual({ kind: 'detent', index: 0 });
  });

  test('a fast downward fling dismisses from any detent, even the largest', () => {
    expect(resolveSheetSnap({ visibleHeight: 787, velocityY: SHEET_FLING_DISMISS_VELOCITY, detents: all })).toEqual({ kind: 'dismiss' });
    expect(resolveSheetSnap({ visibleHeight: 787, velocityY: SHEET_FLING_DISMISS_VELOCITY - 1, detents: all }).kind).toBe('detent');
  });

  test('a fast UPWARD fling never dismisses', () => {
    expect(resolveSheetSnap({ visibleHeight: 300, velocityY: -4000, detents: all })).toEqual({ kind: 'detent', index: 2 });
  });

  test('non-dismissible sheets always land on a detent', () => {
    expect(resolveSheetSnap({ visibleHeight: 10, velocityY: 5000, detents: all, dismissible: false })).toEqual({ kind: 'detent', index: 0 });
  });
});

describe('rubber band past the top detent', () => {
  test('moves less than the finger, never more than the sheet height', () => {
    expect(rubberBand(0, 787)).toBe(0);
    const small = rubberBand(20, 787);
    expect(small).toBeGreaterThan(20 * 0.5);
    expect(small).toBeLessThan(20 * 0.55 + 0.001);
    expect(rubberBand(100000, 787)).toBeLessThan(787);
    // Monotonic.
    expect(rubberBand(200, 787)).toBeGreaterThan(rubberBand(100, 787));
  });

  test('displayed translate: identity below the top, resisted above it', () => {
    expect(displayedTranslate(120, 787)).toBe(120);
    expect(displayedTranslate(0, 787)).toBe(0);
    expect(displayedTranslate(-100, 787)).toBeCloseTo(-rubberBand(100, 787), 6);
    expect(Math.abs(displayedTranslate(-100, 787))).toBeLessThan(100);
  });

  test('the native interpolation samples the same curve and is identity downward', () => {
    const { inputRange, outputRange } = rubberBandInterpolation(787, 900);
    // strictly ascending input, as Animated requires
    for (let i = 1; i < inputRange.length; i++) expect(inputRange[i]).toBeGreaterThan(inputRange[i - 1]);
    const zero = inputRange.indexOf(0);
    expect(outputRange[zero]).toBe(0);
    expect(inputRange[inputRange.length - 1]).toBe(900);
    expect(outputRange[outputRange.length - 1]).toBe(900);
    inputRange.forEach((x, i) => {
      if (x < 0) {
        expect(outputRange[i]).toBeGreaterThan(x);
        expect(outputRange[i]).toBeCloseTo(displayedTranslate(x, 787), 6);
      }
    });
  });
});

describe('VoiceOver adjustable handle', () => {
  test('increment grows one detent, stops at the largest', () => {
    expect(adjustDetent(0, 'increment', 3)).toEqual({ kind: 'detent', index: 1 });
    expect(adjustDetent(2, 'increment', 3)).toEqual({ kind: 'detent', index: 2 });
  });

  test('decrement shrinks one detent, dismisses below the smallest', () => {
    expect(adjustDetent(2, 'decrement', 3)).toEqual({ kind: 'detent', index: 1 });
    expect(adjustDetent(0, 'decrement', 3)).toEqual({ kind: 'dismiss' });
    expect(adjustDetent(0, 'decrement', 3, false)).toEqual({ kind: 'detent', index: 0 });
  });

  test('spoken values', () => {
    expect(detentAccessibilityValue('half')).toBe('Half height');
    expect(detentAccessibilityValue('default')).toBe('Default height');
    expect(detentAccessibilityValue('large')).toBe('Full height');
  });
});
