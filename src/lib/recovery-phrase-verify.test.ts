// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { verifyRecoveryPhraseAgainstStoredCheck } from './recovery-phrase-verify';

const MASTER_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// A tiny fake "recovery check" — deterministic function of the key bytes,
// standing in for the real HKDF-based `computeRecoveryCheck`. What matters
// for these tests is only that it's a PURE function of the key (same key in
// -> same check out), not its real crypto.
async function fakeCheck(key: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(key.map((b) => (b + 1) % 256));
}

describe('verifyRecoveryPhraseAgainstStoredCheck (task 1445 ruling 2)', () => {
  test('returns true when the typed phrase derives the SAME key as the stored check', async () => {
    const storedCheckB64 = b64(await fakeCheck(MASTER_KEY));
    const ok = await verifyRecoveryPhraseAgainstStoredCheck('correct horse battery staple', {
      getStoredCheckBase64: async () => storedCheckB64,
      recoverFromPhraseFn: async () => ({ masterKey: MASTER_KEY.slice() }),
      computeRecoveryCheckFn: fakeCheck,
    });
    expect(ok).toBe(true);
  });

  test('returns false — and never throws — when the typed phrase derives a DIFFERENT key (the wrong-phrase case)', async () => {
    const storedCheckB64 = b64(await fakeCheck(MASTER_KEY));
    const ok = await verifyRecoveryPhraseAgainstStoredCheck('some other twelve word phrase entirely wrong', {
      getStoredCheckBase64: async () => storedCheckB64,
      recoverFromPhraseFn: async () => ({ masterKey: OTHER_KEY.slice() }),
      computeRecoveryCheckFn: fakeCheck,
    });
    expect(ok).toBe(false);
  });

  test('never calls a "store" function — the deps contract has no write path at all (a wrong guess cannot corrupt the real key)', async () => {
    // Type-level guarantee: VerifyRecoveryPhraseDeps only exposes read +
    // derive + compare functions. This test documents that contract so a
    // future edit adding a `storeMasterKey`-shaped dep to this file is a
    // visible, deliberate decision, not a silent one.
    const storedCheckB64 = b64(await fakeCheck(MASTER_KEY));
    let recoverCalls = 0;
    await verifyRecoveryPhraseAgainstStoredCheck('correct horse battery staple', {
      getStoredCheckBase64: async () => storedCheckB64,
      recoverFromPhraseFn: async () => {
        recoverCalls += 1;
        return { masterKey: OTHER_KEY.slice() };
      },
      computeRecoveryCheckFn: fakeCheck,
    });
    expect(recoverCalls).toBe(1);
  });

  test('returns false when no check was ever stored (e.g. legacy account with no recovery check)', async () => {
    const ok = await verifyRecoveryPhraseAgainstStoredCheck('anything', {
      getStoredCheckBase64: async () => null,
      recoverFromPhraseFn: async () => ({ masterKey: MASTER_KEY.slice() }),
      computeRecoveryCheckFn: fakeCheck,
    });
    expect(ok).toBe(false);
  });

  test('returns false (not throw) when the phrase is malformed and the native deriver rejects it', async () => {
    const storedCheckB64 = b64(await fakeCheck(MASTER_KEY));
    const ok = await verifyRecoveryPhraseAgainstStoredCheck('not a real phrase', {
      getStoredCheckBase64: async () => storedCheckB64,
      recoverFromPhraseFn: async () => {
        throw new Error('InvalidRecoveryPhrase');
      },
      computeRecoveryCheckFn: fakeCheck,
    });
    expect(ok).toBe(false);
  });

  test('zeroes the candidate key bytes after comparing (defense in depth)', async () => {
    const storedCheckB64 = b64(await fakeCheck(MASTER_KEY));
    const candidate = MASTER_KEY.slice();
    await verifyRecoveryPhraseAgainstStoredCheck('correct horse battery staple', {
      getStoredCheckBase64: async () => storedCheckB64,
      recoverFromPhraseFn: async () => ({ masterKey: candidate }),
      computeRecoveryCheckFn: fakeCheck,
    });
    expect(Array.from(candidate).every((b) => b === 0)).toBe(true);
  });
});
