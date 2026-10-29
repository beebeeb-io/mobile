// @ts-nocheck
/**
 * Task 1821: the account chip on Settings and Storage reads the onboarding
 * document's state. One test per state: the right label, no stale "TRIAL" after
 * the trial ended, no "No plan plan", no purchase vocabulary.
 */
import { describe, expect, test } from 'bun:test';
import { fixtureNames, loadFixture } from './fixtures';
import { parseOnboardingDocument } from './parse';
import { planCardFromDocument } from './plan-card';
import { accountChip } from '../plan-chip';
import { isPurchaseWording } from '../../../scripts/purchase-vocabulary-scan';

function doc(name, mutate) {
  const raw = loadFixture(name);
  if (mutate) mutate(raw);
  const r = parseOnboardingDocument(raw);
  if (!r.ok) throw new Error(`${name} did not parse`);
  return r.doc;
}
const card = (name, opts, mutate) => planCardFromDocument(doc(name, mutate), { timeZone: 'UTC', ...opts });

describe('planCardFromDocument: one chip per account.state', () => {
  test('allowance: "Allowance", the size, no TRIAL', () => {
    expect(card('account.allowance.ios')).toEqual({ label: 'Allowance', badge: null, statusLine: '2 GB of storage' });
  });

  test('trialing_no_card (no-card trial): "Trial" with its end date, no plan name, no second chip', () => {
    const c = card('account.trialing_no_card.desktop', { planName: 'Basic' });
    expect(c).toEqual({ label: 'Trial', badge: null, statusLine: 'Ends 18 Oct 2026' });
  });

  test('trialing (card on file): "Trial", never "BASIC TRIAL"', () => {
    const c = card('account.trialing.desktop', { planName: 'Basic' });
    expect(c.label).toBe('Trial');
    expect(c.badge).toBeNull();
    expect(c.statusLine).toMatch(/^Ends \d+ \w+ 2026$/);
  });

  test('trial_ended over the allowance: "Trial ended", read-only with the deletion date, no TRIAL chip', () => {
    const c = card('account.trial_ended.ios');
    expect(c).toEqual({ label: 'Trial ended', badge: null, statusLine: 'Read-only · deleted on 1 Nov 2026' });
    expect(`${c.label} ${c.badge ?? ''}`).not.toMatch(/\btrial\b(?! ended)/i);
  });

  test('trial_ended within the allowance: files kept, nothing pending', () => {
    const c = card('account.trial_ended.ios', {}, (raw) => {
      raw.account.storage.used_bytes = 500_000_000;
      raw.account.storage.over_allowance = false;
      raw.account.lifecycle.data_deletion_at = null;
    });
    expect(c).toEqual({ label: 'Trial ended', badge: null, statusLine: 'Files kept · 2 GB allowance' });
  });

  test('trial_ended without explicit evidence: no "Files kept" (missing storage, null over_allowance)', () => {
    const noStorage = card('account.trial_ended.ios', {}, (raw) => {
      delete raw.account.storage;
      raw.account.lifecycle.data_deletion_at = null;
    });
    expect(noStorage).toEqual({ label: 'Trial ended', badge: null, statusLine: 'Read-only' });
    const nullOver = card('account.trial_ended.ios', {}, (raw) => {
      raw.account.storage.over_allowance = null;
      raw.account.lifecycle.data_deletion_at = null;
    });
    expect(nullOver).toEqual({ label: 'Trial ended', badge: null, statusLine: 'Read-only' });
  });

  test('trial_cancelling: "Trial" with a CANCELLED chip and the access date', () => {
    const c = card('account.trial_cancelling.web');
    expect(c.label).toBe('Trial');
    expect(c.badge).toBe('CANCELLED');
    expect(c.statusLine).toBe('You can still download your files.');
    const dated = card('account.trial_cancelling.web', {}, (raw) => {
      raw.account.trial = { kind: 'no_card', started_at: '2026-10-04T09:00:00Z', ends_at: '2026-10-18T09:00:00Z', cap_bytes: 10000000000, converts_automatically: false, first_charge_at: null };
    });
    expect(dated.statusLine).toBe('Access until 18 Oct 2026');
  });

  test('needs_plan: "No plan" (a state), never "No plan plan"', () => {
    const c = card('account.needs_plan.ios', { planName: 'No plan' });
    expect(c).toEqual({ label: 'No plan', badge: null, statusLine: 'Uploads are off' });
  });

  test('lapsed: "Plan ended", read-only with the deletion date', () => {
    const c = card('account.lapsed.ios');
    expect(c.label).toBe('Plan ended');
    expect(c.statusLine).toMatch(/^Read-only · deleted on /);
  });

  test('active: the account\'s own plan name and the renewal line the caller passes', () => {
    expect(card('account.active.web', { planName: 'Basic', activeLine: 'Renews 12 Oct 2026' })).toEqual({
      label: 'Basic',
      badge: null,
      statusLine: 'Renews 12 Oct 2026',
    });
    expect(card('account.active.web').label).toBe('Active');
  });

  test('past_due, read_only, frozen, legacy_free: a plain state label', () => {
    expect(card('account.past_due.web', { planName: 'Basic' }).label).toBe('Basic');
    expect(card('account.read_only.web').label).toBe('Read-only');
    expect(card('account.frozen.desktop').label).toBe('Frozen');
    expect(card('account.legacy_free.web').label).toBe('Free');
  });

  test('an unknown state is only a label', () => {
    const c = card('account.allowance.ios', {}, (raw) => { raw.account.state = 'something_new'; });
    expect(c).toEqual({ label: 'Account', badge: null, statusLine: null });
  });

  test('no chip ever ends in "plan" ("No plan plan") or says "<x> plan"', () => {
    for (const name of fixtureNames().filter((n) => n.startsWith('account.'))) {
      const c = card(name, { planName: 'Basic', activeLine: 'Renews 12 Oct 2026' });
      expect(`${c.label} ${c.badge ?? ''} ${c.statusLine ?? ''}`, name).not.toMatch(/\bplan plan\b/i);
      if (c.label !== 'No plan') expect(c.label, name).not.toMatch(/\bplan$/i);
    }
  });

  test('purchase vocabulary appears in no chip except the three reviewed state strings', () => {
    const seen = new Set();
    let checked = 0;
    for (const name of fixtureNames().filter((n) => n.startsWith('account.'))) {
      const c = card(name, { planName: 'Basic' });
      for (const t of [c.label, c.badge, c.statusLine]) {
        if (!t) continue;
        checked += 1;
        if (isPurchaseWording(t)) seen.add(t);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect([...seen].sort()).toEqual(['A payment did not go through', 'No plan', 'Plan ended']);
  });
});

describe('accountChip: document first, subscription row as fallback', () => {
  const trialingSub = { plan: 'personal', status: 'trialing', trial_ends_at: '2026-10-18T09:00:00Z', current_period_end: '2026-10-18T09:00:00Z' };

  test('document wins: a trial on the personal plan is "Trial", not "Basic" + "TRIAL"', () => {
    const c = accountChip({ doc: doc('account.trialing_no_card.desktop'), subscription: trialingSub });
    expect(c.label).toBe('Trial');
    expect(c.badge).toBeNull();
  });

  test('document wins: trial_ended with a row still saying trialing shows "Trial ended", not "TRIAL / Trial ends"', () => {
    const c = accountChip({ doc: doc('account.trial_ended.ios'), subscription: trialingSub, now: new Date('2026-11-01T00:00:00Z') });
    expect(c.label).toBe('Trial ended');
    expect(c.badge).toBeNull();
    expect(c.statusLine).not.toMatch(/Trial ends/);
  });

  test('document, active: the entitled plan name from the row and its renewal line', () => {
    const sub = { plan: 'personal', status: 'active', current_period_end: '2026-10-12T00:00:00Z', effective_plan: 'basic' };
    const c = accountChip({ doc: doc('account.active.web'), subscription: sub });
    expect(c.label).toBe('Basic');
    expect(c.statusLine).toMatch(/^Renews /);
  });

  test('document, needs_plan with a row whose plan is "none": "No plan", not "No plan plan"', () => {
    const c = accountChip({ doc: doc('account.needs_plan.ios'), subscription: { plan: 'none', status: 'cancelled', account_state: 'needs_plan', effective_plan: 'none' } });
    expect(c).toEqual({ label: 'No plan', badge: null, statusLine: 'Uploads are off' });
  });

  test('no document, running trial: the row still shows the TRIAL chip', () => {
    const c = accountChip({ doc: null, subscription: trialingSub, now: new Date('2026-10-10T00:00:00Z') });
    expect(c.badge).toBe('TRIAL');
    expect(c.statusLine).toMatch(/^Trial ends /);
  });

  test('no document, trial END DATE PASSED (stale cache): no TRIAL chip, "Trial ended <date>"', () => {
    const c = accountChip({ doc: null, subscription: trialingSub, now: new Date('2026-10-20T00:00:00Z') });
    expect(c.badge).toBeNull();
    expect(c.statusLine).toMatch(/^Trial ended /);
  });

  test('no document and no subscription: no chip', () => {
    expect(accountChip({ doc: null, subscription: null })).toBeNull();
  });
});

describe('accountChip: an active document is not mixed with a stale billing line (PR #169 P2)', () => {
  test('active document + lapsed row: no Read-only / Uploads are off status line', () => {
    const stale = { plan: 'none', status: 'canceled', account_state: 'lapsed', data_deletion_at: '2026-11-01T00:00:00Z' };
    const c = accountChip({ doc: doc('account.active.web'), subscription: stale });
    expect(c.statusLine).toBeNull();
    expect(c.label).not.toBe('Trial ended');
  });
  test('active document + needs_plan row: no "Uploads are off"', () => {
    const stale = { plan: 'none', status: null, account_state: 'needs_plan' };
    expect(accountChip({ doc: doc('account.active.web'), subscription: stale }).statusLine).toBeNull();
  });
});
