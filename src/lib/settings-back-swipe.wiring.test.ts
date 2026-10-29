// @ts-nocheck — this file runs in Bun's isolated test process.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const screenSource = readFileSync(new URL('../screens/SettingsScreen.tsx', import.meta.url), 'utf8');

describe('SettingsScreen iOS back-swipe wiring', () => {
  test('imports the pure back-swipe helper', () => {
    expect(screenSource).toMatch(/shouldCompleteSettingsBackSwipe/);
  });

  test('wraps the screen in a GestureDetector', () => {
    expect(screenSource).toMatch(/GestureDetector/);
  });
});
