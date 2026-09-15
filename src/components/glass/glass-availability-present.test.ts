// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, it, mock } from 'bun:test';

// Task 1409 companion to glass-availability.test.ts: when the native module IS linked and
// functioning (the normal production case), the guard must be a no-op pass-through — no
// behaviour change for the case that matters most, real users on real builds.
mock.module('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => true,
  GlassView: () => null,
}));

const { isGlassAvailable } = await import('./glass-availability');

describe('isGlassAvailable', () => {
  it('passes through the real value when the native module is present', () => {
    expect(isGlassAvailable()).toBe(true);
  });
});
