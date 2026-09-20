// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Spy on ensureUnlockedAndSeed rather than exercising the real seed pipeline
// (already covered end-to-end by welcome-seed.test.ts) — this file is only
// about WHETHER OnboardingScreen.handleConfirm's seed trigger fires, and
// with what arguments.
let ensureCalls: any[] = [];

mock.module('./welcome-seed', () => ({
  ensureUnlockedAndSeed: async (opts: any) => {
    ensureCalls.push(opts);
    return true;
  },
}));

const { confirmPhraseAndSeed } = await import('./onboarding-confirm-seed');

const baseOpts = () => ({
  allCorrect: true,
  userId: 'user-1',
  isUnlocked: true,
  unlock: async () => {},
  encryptChunkFn: async () => ({}) as any,
  encryptMetadataFn: async () => ({}) as any,
});

beforeEach(() => {
  ensureCalls = [];
});

describe('confirmPhraseAndSeed — OnboardingScreen.handleConfirm seed trigger (1444)', () => {
  // OnboardingScreen (App.tsx:1469-1473 'RecoveryPhrase' route) is the
  // in-app signup flow's ACTUAL verify step — NOT RecoveryPhraseVerifyScreen,
  // which is only reached via the recovery / verify-later routes. The 1444
  // sim proof showed the original fix (wired into RecoveryPhraseVerifyScreen
  // only) never fired on a real signup because that screen is never rendered
  // by the signup path.

  test('wrong words (allCorrect: false): ensureUnlockedAndSeed is never called', () => {
    confirmPhraseAndSeed({ ...baseOpts(), allCorrect: false });
    expect(ensureCalls).toHaveLength(0);
  });

  test('correct words: ensureUnlockedAndSeed is called exactly once with the user id', () => {
    confirmPhraseAndSeed(baseOpts());
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0].userId).toBe('user-1');
  });

  test('correct words but no authenticated user id: ensureUnlockedAndSeed is never called', () => {
    confirmPhraseAndSeed({ ...baseOpts(), userId: undefined });
    expect(ensureCalls).toHaveLength(0);
  });

  test('isUnlocked / unlock / encrypt fns are passed through unchanged to ensureUnlockedAndSeed', () => {
    const unlock = async () => {};
    const encryptChunkFn = async () => ({}) as any;
    const encryptMetadataFn = async () => ({}) as any;
    confirmPhraseAndSeed({
      allCorrect: true,
      userId: 'user-1',
      isUnlocked: false,
      unlock,
      encryptChunkFn,
      encryptMetadataFn,
    });
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0].isUnlocked).toBe(false);
    expect(ensureCalls[0].unlock).toBe(unlock);
    expect(ensureCalls[0].encryptChunkFn).toBe(encryptChunkFn);
    expect(ensureCalls[0].encryptMetadataFn).toBe(encryptMetadataFn);
  });
});
