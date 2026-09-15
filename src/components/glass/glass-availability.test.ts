// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, it, mock } from 'bun:test';

// Task 1409: on a dev client built before 1308c (or any other binary/OTA skew), the native
// `ExpoGlassEffect` module isn't linked and `expo-glass-effect`'s own `isLiquidGlassAvailable()`
// throws `Cannot find native module 'ExpoGlassEffect'` — exactly what it does at runtime
// (`requireNativeModule` in `expo-modules-core`), reproduced here as a `virtual` mock so this
// test doesn't depend on the native module actually being missing on this machine.
mock.module('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => {
    throw new Error("Cannot find native module 'ExpoGlassEffect'");
  },
  GlassView: () => null,
}));

const { isGlassAvailable } = await import('./glass-availability');

describe('isGlassAvailable', () => {
  it('returns false instead of throwing when the native module is absent', () => {
    expect(() => isGlassAvailable()).not.toThrow();
    expect(isGlassAvailable()).toBe(false);
  });
});
