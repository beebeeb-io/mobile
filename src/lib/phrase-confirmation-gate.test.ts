// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { shouldClearPendingMarkerOnBoot, shouldRouteToPhraseGate } from './phrase-confirmation-gate';

describe('shouldRouteToPhraseGate (task 1445 ruling 2)', () => {
  test('routes to the blocking screen: authenticated, unverified, no in-memory phrase (the cold-relaunch bug)', () => {
    expect(
      shouldRouteToPhraseGate({
        isAuthenticated: true,
        phraseVerified: false,
        hasInMemoryPendingPhrase: false,
      }),
    ).toBe(true);
  });

  test('does NOT route when the live signup flow still holds the words in memory — that goes through OnboardingScreen instead', () => {
    expect(
      shouldRouteToPhraseGate({
        isAuthenticated: true,
        phraseVerified: false,
        hasInMemoryPendingPhrase: true,
      }),
    ).toBe(false);
  });

  test('does NOT route once verified', () => {
    expect(
      shouldRouteToPhraseGate({
        isAuthenticated: true,
        phraseVerified: true,
        hasInMemoryPendingPhrase: false,
      }),
    ).toBe(false);
  });

  test('does NOT route when signed out, regardless of phraseVerified', () => {
    expect(
      shouldRouteToPhraseGate({
        isAuthenticated: false,
        phraseVerified: false,
        hasInMemoryPendingPhrase: false,
      }),
    ).toBe(false);
  });
});

describe('shouldClearPendingMarkerOnBoot (task 1445 ruling 2 — "pending + no session is cleared on launch")', () => {
  test('clears a pending marker when there is no session on this boot', () => {
    expect(shouldClearPendingMarkerOnBoot({ tokenExists: false, phraseKey: 'pending' })).toBe(true);
  });

  test('does not touch a pending marker while a session exists', () => {
    expect(shouldClearPendingMarkerOnBoot({ tokenExists: true, phraseKey: 'pending' })).toBe(false);
  });

  test('does not touch a verified marker, session or not', () => {
    expect(shouldClearPendingMarkerOnBoot({ tokenExists: false, phraseKey: 'verified' })).toBe(false);
    expect(shouldClearPendingMarkerOnBoot({ tokenExists: true, phraseKey: 'verified' })).toBe(false);
  });

  test('does not touch an absent marker (legacy user)', () => {
    expect(shouldClearPendingMarkerOnBoot({ tokenExists: false, phraseKey: null })).toBe(false);
    expect(shouldClearPendingMarkerOnBoot({ tokenExists: true, phraseKey: null })).toBe(false);
  });
});
