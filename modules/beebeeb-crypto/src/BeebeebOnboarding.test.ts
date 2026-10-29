// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1746: the JS face of the native onboarding bridge. The Rust logic is
 * tested in core (task 1744); what is tested HERE is what this file owns:
 * handle passing, stable error codes (never native text), dispose semantics and
 * byte coercion, against a fake native module.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: Array<[string, unknown[]]> = [];
let failWith: { code?: string; message?: string } | null = null;
let nextId = 100;

function rec(name: string, ret?: unknown) {
  return (...args: unknown[]) => {
    calls.push([name, args]);
    if (failWith) {
      const e: any = new Error(failWith.message ?? 'native detail that must never reach a screen: pw=hunter2');
      if (failWith.code) e.code = failWith.code;
      throw e;
    }
    return typeof ret === 'function' ? (ret as any)(...args) : ret;
  };
}

const nativeModule: any = {
  onboardingEvaluatePassword: rec('evaluate', (pw: string, min: number) => ({
    length: pw.length, minLength: min, missingCharacters: 0, meetsMinimum: true, hasMixedCase: true,
    hasNumberOrSymbol: true, strength: 'strong', level: 4, hint: 'none',
  })),
  onboardingBreachNew: rec('breachNew', () => (nextId += 1)),
  onboardingBreachPrefix: rec('breachPrefix', 'ABCDE'),
  onboardingBreachEvaluate: rec('breachEvaluate', { kind: 'clean' }),
  onboardingBreachRelease: rec('breachRelease'),
  onboardingCeremonyNew: rec('ceremonyNew', () => (nextId += 1)),
  onboardingCeremonyEmailVerified: rec('emailVerified'),
  onboardingCeremonyEmailChanged: rec('emailChanged'),
  onboardingCeremonyEmailTicketInvalidated: rec('ticketInvalidated'),
  onboardingCeremonyRegistrationFailed: rec('registrationFailed'),
  onboardingCeremonySetPassword: rec('setPassword', { meetsMinimum: true }),
  onboardingCeremonyBeginPhrase: rec('beginPhrase'),
  onboardingCeremonyPhrase: rec('phrase', 'one two three'),
  onboardingCeremonyAcknowledgePhrase: rec('acknowledge'),
  onboardingCeremonyChallengePositions: rec('positions', [2, 5, 11]),
  onboardingCeremonyConfirmPhrase: rec('confirm'),
  onboardingCeremonyStartRegistration: rec('start', new Uint8Array([1, 2, 3])),
  onboardingCeremonyFinishRegistration: rec('finish', { upload: [4, 5], x25519Public: new Uint8Array([6]), recoveryCheck: new Uint8Array([7]) }),
  onboardingCeremonyStep: rec('step', 'save_recovery_phrase'),
  onboardingCeremonyAccountCreated: rec('accountCreated', new Uint8Array(32).fill(9)),
  onboardingCeremonyAbandon: rec('abandon'),
  onboardingCeremonyRelease: rec('release'),
};

mock.module('expo', () => ({ requireNativeModule: () => nativeModule }));
mock.module('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

const {
  CeremonyError, createBreachCheck, createSignupCeremony, evaluatePasswordPolicy, ceremonyCodeFrom,
} = await import('./BeebeebOnboarding');

beforeEach(() => {
  calls.length = 0;
  failWith = null;
});

const CONFIG = { minLength: 12, emailVerificationRequired: true, verifyWordCount: 3, breachCheckRequired: true, breachFailOpen: true };

describe('error mapping: stable codes, never native text', () => {
  test('ERR_ONBOARDING_<CODE> becomes the lower-case code', () => {
    expect(ceremonyCodeFrom({ code: 'ERR_ONBOARDING_PASSWORD_BREACHED' })).toBe('password_breached');
    expect(ceremonyCodeFrom({ code: 'ERR_ONBOARDING_PHRASE_WORD_MISMATCH' })).toBe('phrase_word_mismatch');
    expect(ceremonyCodeFrom({ code: 'ERR_ONBOARDING_BREACH_PREFIX_MISMATCH' })).toBe('breach_prefix_mismatch');
  });
  test('anything else is "unavailable"', () => {
    for (const e of [null, undefined, {}, { code: 'ERR_VAULT_AUTH_FAILED' }, { code: 5 }, new Error('x')]) {
      expect(ceremonyCodeFrom(e)).toBe('unavailable');
    }
  });
  test('a native failure reaches the caller as CeremonyError with a fixed message that does not carry the native text', async () => {
    failWith = { code: 'ERR_ONBOARDING_PASSWORD_TOO_SHORT' };
    const c = await createSignupCeremony(CONFIG).catch((e) => e);
    expect(c).toBeInstanceOf(CeremonyError);
    expect(c.code).toBe('password_too_short');
    expect(c.message).toBe('Onboarding step failed: password_too_short');
    expect(c.message).not.toContain('hunter2');
  });
  test('a missing native module (Proxy stub throws plain Error) is "unavailable"', async () => {
    failWith = { message: 'BeebeebCrypto native module not available' };
    const e = await evaluatePasswordPolicy('x', 12).catch((x) => x);
    expect(e).toBeInstanceOf(CeremonyError);
    expect(e.code).toBe('unavailable');
  });
});

describe('ceremony handle', () => {
  test('every call carries the handle id returned by create', async () => {
    const c = await createSignupCeremony(CONFIG);
    const id = calls[0][0] === 'ceremonyNew' ? nextId : -1;
    await c.emailVerified();
    await c.beginPhrase();
    expect(await c.phrase()).toBe('one two three');
    await c.acknowledgePhrase();
    expect(await c.challengePositions()).toEqual([2, 5, 11]);
    await c.confirmPhrase(['a', 'b', 'c']);
    expect(await c.step()).toBe('save_recovery_phrase');
    const used = calls.slice(1).map(([, args]) => args[0]);
    expect(used.every((a) => a === id)).toBe(true);
    expect(calls[0][1]).toEqual([12, true, 3, true, true]);
  });

  test('bytes come back as Uint8Array whatever shape the bridge used', async () => {
    const c = await createSignupCeremony(CONFIG);
    const start = await c.startRegistration();
    const fin = await c.finishRegistration(new Uint8Array([8]));
    const key = await c.accountCreated();
    expect(start).toBeInstanceOf(Uint8Array);
    expect(Array.from(fin.upload)).toEqual([4, 5]);
    expect(fin.x25519Public).toBeInstanceOf(Uint8Array);
    expect(fin.recoveryCheck).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  test('dispose releases once, then every use throws "disposed" and a second dispose is a no-op', async () => {
    const c = await createSignupCeremony(CONFIG);
    await c.dispose();
    await c.dispose();
    expect(calls.filter(([n]) => n === 'release').length).toBe(1);
    const e = await Promise.resolve().then(() => c.emailVerified()).catch((x) => x);
    expect(e).toBeInstanceOf(CeremonyError);
    expect(e.code).toBe('disposed');
  });

  test('a failing release does not throw out of dispose', async () => {
    const c = await createSignupCeremony(CONFIG);
    failWith = { code: 'ERR_ONBOARDING_CRYPTO' };
    await c.dispose();
  });
});

describe('breach check', () => {
  test('exposes the prefix the request must use and passes it back unchanged to evaluate', async () => {
    const b = await createBreachCheck('correct horse');
    expect(b.prefix).toBe('ABCDE');
    expect(await b.evaluate('ABCDE', 'AAAA:1', true)).toEqual({ kind: 'clean' });
    const ev = calls.find(([n]) => n === 'breachEvaluate');
    expect(ev[1].slice(1)).toEqual(['ABCDE', 'AAAA:1', true]);
  });
  test('a null body (outage) is passed through as null, not as an empty string', async () => {
    const b = await createBreachCheck('pw');
    await b.evaluate('ABCDE', null, false);
    const ev = calls.find(([n]) => n === 'breachEvaluate');
    expect(ev[1][2]).toBeNull();
    expect(ev[1][3]).toBe(false);
  });
  test('setPassword hands the native side the breach handle id, or null when no check is required', async () => {
    const c = await createSignupCeremony(CONFIG);
    const b = await createBreachCheck('pw');
    await c.setPassword('pw-one', 'pw-one', b);
    await c.setPassword('pw-one', 'pw-one', null);
    const sets = calls.filter(([n]) => n === 'setPassword');
    expect(typeof sets[0][1][3]).toBe('number');
    expect(sets[0][1][3]).toBe(b.handleId);
    expect(sets[1][1][3]).toBeNull();
  });
  test('a disposed check cannot be used again', async () => {
    const b = await createBreachCheck('pw');
    await b.dispose();
    await expect(b.evaluate('ABCDE', 'x', true)).rejects.toMatchObject({ code: 'disposed' });
    expect(calls.filter(([n]) => n === 'breachRelease').length).toBe(1);
  });
  test('if the prefix cannot be read, the half-made handle is released', async () => {
    const orig = nativeModule.onboardingBreachPrefix;
    nativeModule.onboardingBreachPrefix = () => { throw Object.assign(new Error('x'), { code: 'ERR_ONBOARDING_UNKNOWN_HANDLE' }); };
    await expect(createBreachCheck('pw')).rejects.toMatchObject({ code: 'unknown_handle' });
    nativeModule.onboardingBreachPrefix = orig;
    expect(calls.filter(([n]) => n === 'breachRelease').length).toBe(1);
  });
});

describe('password evaluation', () => {
  test('passes the typed password and the server minimum and returns the evaluation untouched', async () => {
    const e = await evaluatePasswordPolicy('abcdefghijkl', 14);
    expect(calls[0]).toEqual(['evaluate', ['abcdefghijkl', 14]]);
    expect(e.level).toBe(4);
    expect(JSON.stringify(e)).not.toContain('abcdefghijkl');
  });
});
