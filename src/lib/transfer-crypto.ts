// Pure crypto helpers for the Constellation transfer flow — deliberately kept
// FREE of react-native / ./api imports so the security-critical RNG is
// unit-testable under bun (task 0675) and can't silently regress.

/**
 * Generate `n` cryptographically-random bytes via the platform CSPRNG
 * (`crypto.getRandomValues`; Hermes on iOS has it since RN 0.71+).
 *
 * THROWS if no CSPRNG is available — it MUST NEVER silently degrade to
 * `Math.random` for key/nonce material (task 0675). Math.random is not a CSPRNG;
 * a fallback would mint guessable Constellation keypair material on any runtime
 * lacking WebCrypto. When Constellation is productionized, key material should
 * come from the core CSPRNG over UniFFI (audited, cross-client), not this helper.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const gv = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto?.getRandomValues;
  if (typeof gv !== 'function') {
    throw new Error(
      'randomBytes: no secure CSPRNG (crypto.getRandomValues) available — refusing to generate key material with Math.random',
    );
  }
  gv.call((globalThis as { crypto: object }).crypto, out);
  return out;
}
