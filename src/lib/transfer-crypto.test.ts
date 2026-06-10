// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches the convention in the other src/lib/*.test.ts files).
import { describe, expect, test } from 'bun:test';
import { randomBytes } from './transfer-crypto';

describe('randomBytes — CSPRNG hardening (task 0675)', () => {
  test('uses the platform CSPRNG when present (returns n filled bytes)', () => {
    const b = randomBytes(32);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(b.length).toBe(32);
    // The CSPRNG actually filled it — astronomically unlikely to be all-zero.
    expect(b.some((x) => x !== 0)).toBe(true);
  });

  test('THROWS instead of falling back to Math.random when no CSPRNG is available', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      // Simulate a runtime without WebCrypto getRandomValues.
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
      expect(() => randomBytes(32)).toThrow(/CSPRNG|getRandomValues|secure/i);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});
