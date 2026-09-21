// Pure "does this typed phrase match the account's ALREADY-persisted master
// key" check for task 1445 (ruling 2). Dependency-free (no React/RN/native
// module imports) — every native call is injected, so the compare logic is
// unit-testable without a device/simulator, matching `recovery-phrase.ts`.
//
// SAFETY CONTRACT — read before changing this file:
// `crypto.unlock(phrase)` (crypto-context.tsx) is NOT safe to call with an
// unverified phrase: it unconditionally derives a master key from whatever
// phrase it's given and OVERWRITES the keychain (`storeMasterKey`) with it,
// treating that as success. For task 1445's re-verify screen the real
// master key is already correctly persisted from signup — a wrong guess
// must never touch stored key material, or a typo would silently destroy
// the user's real vault key. This module only ever COMPARES: it derives a
// CANDIDATE key from the typed phrase, computes its recovery check, and
// constant-time-compares it against the check value already stored at
// signup (`MASTER_KEY_CHECK_LABEL` in crypto-context.tsx). It never writes
// anything. This mirrors the existing verify-before-write pattern
// `loadVerifiedMasterKeyHandle`'s `verifyAndCreateHandle` helper already
// uses for the keychain-fallback path in the same file.

export interface VerifyRecoveryPhraseDeps {
  /** Reads the base64-encoded recovery-check value stored at signup/last unlock (`SecureStore.getItemAsync(MASTER_KEY_CHECK_LABEL)`). Returns null if absent/unreadable. */
  getStoredCheckBase64: () => Promise<string | null>;
  /** `recoverFromPhrase` from the native module — derives a candidate master key from the typed phrase. Throws on a malformed/invalid-checksum phrase. */
  recoverFromPhraseFn: (phrase: string) => Promise<{ masterKey: Uint8Array }>;
  /** `computeRecoveryCheck` from the native module. */
  computeRecoveryCheckFn: (masterKey: Uint8Array) => Promise<Uint8Array>;
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Returns true only if `phrase` derives the SAME master key already
 * persisted for this account. Never throws — any failure (no stored check,
 * malformed phrase, native error) resolves to `false`. Never mutates any
 * stored state.
 */
export async function verifyRecoveryPhraseAgainstStoredCheck(
  phrase: string,
  deps: VerifyRecoveryPhraseDeps,
): Promise<boolean> {
  let candidate: Uint8Array | null = null;
  try {
    const checkB64 = await deps.getStoredCheckBase64().catch(() => null);
    if (!checkB64) return false;
    const expected = base64ToUint8(checkB64);
    const result = await deps.recoverFromPhraseFn(phrase);
    candidate = result.masterKey;
    const actual = await deps.computeRecoveryCheckFn(candidate);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  } finally {
    candidate?.fill(0);
  }
}
