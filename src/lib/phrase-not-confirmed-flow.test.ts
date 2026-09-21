// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { attemptPhraseVerification } from './phrase-not-confirmed-flow';

describe('attemptPhraseVerification (task 1445 ruling 2)', () => {
  test('correct phrase → verified + seed called exactly once', async () => {
    let markCalls = 0;
    let seedCalls = 0;
    const outcome = await attemptPhraseVerification('correct horse battery staple', {
      verifyRecoveryPhrase: async () => true,
      markPhraseVerified: async () => {
        markCalls += 1;
      },
      seed: () => {
        seedCalls += 1;
      },
    });
    expect(outcome).toBe('verified');
    expect(markCalls).toBe(1);
    expect(seedCalls).toBe(1);
  });

  test('wrong phrase → stays (mismatch), nothing written — markPhraseVerified and seed are never called', async () => {
    let markCalls = 0;
    let seedCalls = 0;
    const outcome = await attemptPhraseVerification('wrong words entirely', {
      verifyRecoveryPhrase: async () => false,
      markPhraseVerified: async () => {
        markCalls += 1;
      },
      seed: () => {
        seedCalls += 1;
      },
    });
    expect(outcome).toBe('mismatch');
    expect(markCalls).toBe(0);
    expect(seedCalls).toBe(0);
  });

  test('seed fires only AFTER markPhraseVerified resolves, never before', async () => {
    const order: string[] = [];
    await attemptPhraseVerification('correct horse battery staple', {
      verifyRecoveryPhrase: async () => true,
      markPhraseVerified: async () => {
        order.push('mark');
      },
      seed: () => {
        order.push('seed');
      },
    });
    expect(order).toEqual(['mark', 'seed']);
  });
});
