// @ts-nocheck — this file runs in Bun's isolated test process.
import { describe, expect, test } from 'bun:test';

import { SETTINGS_BACK_EDGE_PX, shouldCompleteSettingsBackSwipe } from './settings-back-swipe';

const PHONE_WIDTH = 390;

describe('shouldCompleteSettingsBackSwipe', () => {
  test('completes a fast swipe that starts in the left edge band', () => {
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 8,
        translationX: 70,
        velocityX: 900,
        screenWidth: PHONE_WIDTH,
      }),
    ).toBe(true);
  });

  test('completes a slow but long swipe from the edge', () => {
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 4,
        translationX: 220,
        velocityX: 120,
        screenWidth: PHONE_WIDTH,
      }),
    ).toBe(true);
  });

  test('does not complete when the swipe starts away from the edge', () => {
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 200,
        translationX: 260,
        velocityX: 1_500,
        screenWidth: PHONE_WIDTH,
      }),
    ).toBe(false);
  });

  test('does not complete for a leftward swipe', () => {
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 4,
        translationX: -120,
        velocityX: -1_200,
        screenWidth: PHONE_WIDTH,
      }),
    ).toBe(false);
  });

  test('does not complete for a short slow swipe', () => {
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 4,
        translationX: 40,
        velocityX: 200,
        screenWidth: PHONE_WIDTH,
      }),
    ).toBe(false);
  });

  test('scales the distance threshold with a wide screen', () => {
    // 100px clears the flat 60px floor but not 0.18 * 1024 (~184px).
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 8,
        translationX: 100,
        velocityX: 200,
        screenWidth: 1024,
      }),
    ).toBe(false);
    expect(
      shouldCompleteSettingsBackSwipe({
        startX: 8,
        translationX: 200,
        velocityX: 200,
        screenWidth: 1024,
      }),
    ).toBe(true);
  });

  test('exports a 24px edge band', () => {
    expect(SETTINGS_BACK_EDGE_PX).toBe(24);
  });
});
