// @ts-nocheck
/**
 * Task 1746: the gate read from the document's capabilities. The point of the
 * file: an `allowance` account is a WORKING vault, even though the legacy label
 * for it is `needs_plan` (which would block the whole UI).
 */
import { describe, expect, test } from 'bun:test';
import { fixtureNames, loadFixture } from './fixtures';
import { gateFromDocument } from './account-gate';
import { parseOnboardingDocument } from './parse';

const doc = (name, mutate) => {
  const raw = JSON.parse(JSON.stringify(loadFixture(name)));
  if (mutate) mutate(raw);
  return parseOnboardingDocument(raw).doc;
};

describe('every account fixture', () => {
  const expected = {
    'account.active.web': 'ok',
    'account.allowance.desktop': 'ok',
    'account.allowance.ios': 'ok',
    'account.allowance.web': 'ok',
    'account.frozen.desktop': 'lapsed',
    'account.lapsed.ios': 'lapsed',
    'account.legacy_free.web': 'ok',
    'account.needs_plan.ios': 'needs_plan',
    'account.past_due.web': 'ok',
    'account.read_only.web': 'lapsed',
    'account.trial_cancelling.web': 'trial_cancelled_read_only',
    'account.trial_ended.ios': 'trial_ended',
    'account.trialing.desktop': 'ok',
    'account.trialing_no_card.desktop': 'ok',
  };

  test('the table covers all 14 account fixtures (a fixture added without a row is a red)', () => {
    const names = fixtureNames().filter((n) => n.startsWith('account.'));
    expect(names.sort()).toEqual(Object.keys(expected).sort());
  });

  test('each gate matches the table', () => {
    for (const [name, kind] of Object.entries(expected)) {
      expect(gateFromDocument(doc(name))?.kind, name).toBe(kind);
    }
  });

  test('an allowance account is NOT gated although its legacy label is needs_plan', () => {
    const d = doc('account.allowance.ios');
    const raw = loadFixture('account.allowance.ios');
    expect(raw.account.legacy_account_state).toBe('needs_plan');
    expect(gateFromDocument(d)).toEqual({ kind: 'ok' });
  });
});

describe('trial_ended carries the deletion date and the server sentence, scrubbed of purchase words', () => {
  test('fixture E', () => {
    const g = gateFromDocument(doc('account.trial_ended.ios'));
    expect(g.kind).toBe('trial_ended');
    expect(g.dataDeletionAt).toBe('2026-11-01T09:00:00Z');
    expect(g.bannerText).toBe('Your trial ended. Files above 2 GB are read-only and will be deleted on 1 Nov unless you free up space.');
  });
  test('a server sentence with a call to action is dropped, not rendered', () => {
    const g = gateFromDocument(doc('account.trial_ended.ios', (raw) => { raw.copy.trial_ended_over_allowance = 'Upgrade to keep your files.'; }));
    expect(g.bannerText).toBeNull();
  });
});

describe('edge cases', () => {
  test('a pre-account document and null say nothing', () => {
    expect(gateFromDocument(doc('pre_account.ios'))).toBeNull();
    expect(gateFromDocument(null)).toBeNull();
    expect(gateFromDocument(undefined)).toBeNull();
  });
  test('a document with no capabilities at all is not decidable (legacy fallback)', () => {
    expect(gateFromDocument(doc('account.allowance.ios', (raw) => { raw.account.capabilities = {}; }))).toBeNull();
  });
  test('upload refused with an unknown reason is read-only, never ok', () => {
    const g = gateFromDocument(doc('account.allowance.ios', (raw) => { raw.account.capabilities.upload = { allowed: false, reason: 'something_new' }; }));
    expect(g.kind).toBe('lapsed');
  });
  test('upload refused with NO reason is read-only too', () => {
    const g = gateFromDocument(doc('account.allowance.ios', (raw) => { raw.account.capabilities.upload = { allowed: false }; }));
    expect(g.kind).toBe('lapsed');
  });
  test('an unverified email gates like needs_plan', () => {
    const g = gateFromDocument(doc('account.allowance.ios', (raw) => { raw.account.capabilities.upload = { allowed: false, reason: 'email_unverified' }; }));
    expect(g.kind).toBe('needs_plan');
  });
});
