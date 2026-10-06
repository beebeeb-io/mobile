// @ts-nocheck
/**
 * Task 1820: the no-card trial's typed refusals (server task 1755) as pure copy.
 * App Store 3.1.x: the app shows account state only, so none of these sentences
 * may offer, price or point at buying anything. Server wording for several of
 * them does ("choose a plan", "Subscribe", "pay at checkout"), which is why the
 * client maps by code and never prints the server sentence.
 */
import { describe, expect, test } from 'bun:test';
import { TRIAL_REFUSAL_CODES, isTrialRefusalCode, trialCapMessage, trialRefusalMessage } from './trial-refusals';

const PURCHASE_VOCABULARY =
  /subscribe|subscription|upgrade|\bbuy\b|purchase|checkout|\bprices?\b|pricing|€|\$|per (month|year)|\/(mo|yr)\b|start (a |the |your )?(\d+-day )?trial|choose (a|your) plan|see plans|add (a )?card|pay now|\bplans?\b|ideal/i;

const SIX = [
  'trial_previously_subscribed',
  'trial_sharing_unavailable',
  'trial_share_limit_reached',
  'no_subscription_to_cancel',
  'trial_convert_unavailable',
  'trial_checkout_retired',
];

describe('every no-card trial code has honest, purchase-free copy', () => {
  test('the six codes from task 1820 are all recognised', () => {
    for (const code of SIX) {
      expect(isTrialRefusalCode(code), code).toBe(true);
      expect(TRIAL_REFUSAL_CODES).toContain(code);
    }
    expect(TRIAL_REFUSAL_CODES.length).toBeGreaterThanOrEqual(9);
  });

  test('each code maps to a non-empty sentence with no purchase vocabulary', () => {
    for (const code of TRIAL_REFUSAL_CODES) {
      const m = trialRefusalMessage(code);
      expect(m, code).toBeTruthy();
      expect(m.length, code).toBeGreaterThan(20);
      expect(m.length, code).toBeLessThan(200);
      expect(PURCHASE_VOCABULARY.test(m), `${code}: "${m}"`).toBe(false);
      expect(/^[a-z0-9_]+$/.test(m), code).toBe(false); // never a machine code
    }
  });

  test('the sentences say what is true', () => {
    expect(trialRefusalMessage('trial_share_limit_reached')).toContain('5 active share links');
    expect(trialRefusalMessage('trial_sharing_unavailable')).toContain('private');
    expect(trialRefusalMessage('no_subscription_to_cancel')).toContain('nothing will be charged');
    expect(trialRefusalMessage('trial_checkout_retired')).toContain('Nothing was changed or charged');
  });

  test('unknown and empty codes are not ours', () => {
    expect(isTrialRefusalCode('quota_exceeded')).toBe(false);
    expect(isTrialRefusalCode(undefined)).toBe(false);
    expect(isTrialRefusalCode(42)).toBe(false);
    expect(trialRefusalMessage('some_other_conflict')).toBeNull();
    expect(trialRefusalMessage(undefined)).toBeNull();
  });
});

describe('the trial storage cap names the number the server enforced', () => {
  test('a no-card cap of 10 GB says 10 GB, not 25', () => {
    const m = trialCapMessage(10_000_000_000);
    expect(m).toContain('10 GB');
    expect(m).not.toContain('25 GB');
    expect(PURCHASE_VOCABULARY.test(m)).toBe(false);
  });
  test('the older mandated cap and a missing limit keep saying 25 GB', () => {
    expect(trialCapMessage(25_000_000_000)).toContain('25 GB');
    expect(trialCapMessage(undefined)).toContain('25 GB');
    expect(trialCapMessage(null)).toContain('25 GB');
    expect(trialCapMessage(0)).toContain('25 GB');
    expect(trialCapMessage(Number.NaN)).toContain('25 GB');
  });
});
