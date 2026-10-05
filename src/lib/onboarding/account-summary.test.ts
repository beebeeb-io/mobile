// @ts-nocheck
/**
 * Task 1746: the account-stage view model for every account.state fixture, and
 * the NO PURCHASE posture (App Store 3.1.3, task 1400, spec 4b.7): status text
 * only, no offer, no price, no tappable purchase element.
 */
import { describe, expect, test } from 'bun:test';
import { fixtureNames, loadFixture } from './fixtures';
import { parseOnboardingDocument } from './parse';
import { formatDay, formatSize, noPurchaseCopy, summarizeAccount } from './account-summary';

function doc(name) {
  const r = parseOnboardingDocument(loadFixture(name));
  if (!r.ok) throw new Error(`${name} did not parse`);
  return r.doc;
}

const ACCOUNT_FIXTURES = fixtureNames().filter((n) => n.startsWith('account.'));

/** Words that make a sentence a call to action or a price. A status sentence has none. */
const PURCHASE_VOCABULARY = /subscribe|upgrade|\bbuy\b|purchase|checkout|\bprices?\b|pricing|€|\$|per (month|year)|\/(mo|yr)\b|start (a |the |your )?(\d+-day )?trial|choose (a|your) plan|see plans|add (a )?card|pay now/i;

describe('every account fixture summarises', () => {
  test('there are 14 account fixtures covering all 12 states, and each one summarises with a headline', () => {
    expect(ACCOUNT_FIXTURES.length).toBe(14);
    const states = new Set();
    for (const name of ACCOUNT_FIXTURES) {
      const s = summarizeAccount(doc(name), 'UTC');
      expect(s.headline.length, name).toBeGreaterThan(0);
      expect(s.rows.length, name).toBeGreaterThanOrEqual(3);
      states.add(s.state);
    }
    expect(states.size).toBe(12);
  });

  test('NO purchase vocabulary in any generated or server sentence, for ALL 14 account fixtures', () => {
    let sentences = 0;
    for (const name of ACCOUNT_FIXTURES) {
      const s = summarizeAccount(doc(name), 'UTC');
      const texts = [
        s.headline,
        ...s.lines,
        ...(s.usage?.overAllowanceNote ? [s.usage.overAllowanceNote] : []),
        ...s.rows.map((r) => `${r.label} ${r.detail}`),
        ...(s.plansManagedNote ? [s.plansManagedNote] : []),
      ];
      for (const t of texts) {
        sentences += 1;
        expect(PURCHASE_VOCABULARY.test(t), `${name}: "${t}"`).toBe(false);
      }
    }
    expect(sentences).toBeGreaterThan(60); // the loop saw real text, not an empty list
  });

  test('the summary object carries no offer, price, plan list or link field at all', () => {
    for (const name of ACCOUNT_FIXTURES) {
      const s = summarizeAccount(doc(name), 'UTC');
      expect(Object.keys(s).sort()).toEqual(['headline', 'lines', 'plansManagedNote', 'rows', 'state', 'tone', 'usage']);
    }
  });
});

describe('the three states the Verification line names (spec 5.4 B, D, E)', () => {
  test('allowance (B): 2 GB, nothing used, the sanctioned plain-text line, no share', () => {
    const s = summarizeAccount(doc('account.allowance.ios'), 'UTC');
    expect(s.state).toBe('allowance');
    expect(s.headline).toBe('You have 2 GB to start with');
    expect(s.usage.allowanceBytes).toBe(2_000_000_000);
    expect(s.usage.overAllowance).toBe(false);
    expect(s.plansManagedNote).toBe('Plans are managed from your account on the web.');
    const share = s.rows.find((r) => r.name === 'share');
    expect(share.allowed).toBe(false);
    expect(s.rows.find((r) => r.name === 'upload').detail).toBe('Up to 2 GB');
  });

  test('trialing_no_card (D): trial badge, end date, cap, over-allowance note and server copy verbatim', () => {
    const d = doc('account.trialing_no_card.desktop');
    const s = summarizeAccount(d, 'UTC');
    expect(s.state).toBe('trialing_no_card');
    expect(s.headline).toMatch(/^Trial: 10 GB until \d{1,2} \w{3} 2026$/);
    expect(s.lines).toContain('No card is on file, so nothing will be charged.');
    // The server's sentence says "unless you subscribe or free up space" (one copy per
    // state, not per client). This binary has no purchase UI, so the clause is reduced.
    expect(d.copy.trial_end_over_allowance).toMatch(/unless you subscribe or free up space\.$/);
    expect(s.lines).toContain(
      'Your trial ends on 18 Oct. Files above 2 GB become read-only and are deleted 14 days later unless you free up space.',
    );
    expect(s.tone).toBe('attention');
    expect(s.usage.overAllowanceNote).toMatch(/After it ends, the 2 GB allowance applies\.$/);
  });

  test('trial_ended (E): read-only, the server\'s deletion sentence verbatim, delete stays allowed', () => {
    const d = doc('account.trial_ended.ios');
    const s = summarizeAccount(d, 'UTC');
    expect(s.state).toBe('trial_ended');
    expect(s.tone).toBe('restricted');
    expect(s.lines).toEqual([d.copy.trial_ended_over_allowance]);
    expect(s.lines[0]).toMatch(/unless you free up space\.$/);
    expect(s.rows.find((r) => r.name === 'upload').allowed).toBe(false);
    expect(s.rows.find((r) => r.name === 'download').allowed).toBe(true);
    expect(s.rows.find((r) => r.name === 'delete').allowed).toBe(true);
    expect(s.plansManagedNote).toBe('Plans are managed from your account on the web.');
  });
});

describe('noPurchaseCopy: server sentences on a store build with no purchase surface', () => {
  test('a sentence with no purchase vocabulary is returned verbatim', () => {
    const t = 'Your trial ended. Files above 2 GB are read-only and will be deleted on 1 Nov unless you free up space.';
    expect(noPurchaseCopy(t)).toBe(t);
    expect(noPurchaseCopy('Plans are managed from your account on the web.')).toBe('Plans are managed from your account on the web.');
  });
  test('the known "subscribe or free up space" clause is reduced, case-insensitively', () => {
    expect(noPurchaseCopy('Files go in 14 days unless you subscribe or free up space.')).toBe('Files go in 14 days unless you free up space.');
    expect(noPurchaseCopy('Files go in 14 days unless you Subscribe or free up space.')).toBe('Files go in 14 days unless you free up space.');
  });
  test('any other purchase vocabulary drops the sentence (fail closed)', () => {
    for (const bad of [
      'Upgrade now to keep your files.',
      'Buy more storage.',
      'Plans start at €4.99 per month.',
      'Subscribe to keep your files.',
      'Start a 14-day trial today.',
      'Open the checkout page.',
    ]) {
      expect(noPurchaseCopy(bad), bad).toBeNull();
    }
  });
  test('empty and missing are null', () => {
    expect(noPurchaseCopy(null)).toBeNull();
    expect(noPurchaseCopy(undefined)).toBeNull();
    expect(noPurchaseCopy('')).toBeNull();
  });
  test('a server sentence that cannot be made safe is replaced by client-authored status text', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('account.trialing_no_card.desktop')));
    raw.copy.trial_end_over_allowance = 'Upgrade before 18 Oct to keep your files.';
    const s = summarizeAccount(parseOnboardingDocument(raw).doc, 'UTC');
    expect(s.lines.join(' ')).not.toMatch(/upgrade/i);
    expect(s.lines).toContain('Your trial ends on 18 Oct 2026. After that, files above 2 GB are read-only.');
  });
});

describe('forward compatibility and formatting', () => {
  test('an unknown account.state is only a label: generic headline, capability rows still tell the truth', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('account.allowance.ios')));
    raw.account.state = 'quantum_superposition';
    const s = summarizeAccount(parseOnboardingDocument(raw).doc, 'UTC');
    expect(s.headline).toBe('Your account');
    expect(s.rows.find((r) => r.name === 'upload').allowed).toBe(true);
  });

  test('an absent capability is not allowed (closed set, rule 11)', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('account.allowance.ios')));
    delete raw.account.capabilities.share;
    const s = summarizeAccount(parseOnboardingDocument(raw).doc, 'UTC');
    expect(s.rows.find((r) => r.name === 'share')).toMatchObject({ allowed: false, detail: 'Not available' });
  });

  test('a non-account document refuses to summarise', () => {
    expect(() => summarizeAccount(doc('pre_account.ios'))).toThrow();
  });

  test('sizes are decimal, dates are day month year', () => {
    expect(formatSize(2_000_000_000)).toBe('2 GB');
    expect(formatSize(6_300_000_000)).toBe('6.3 GB');
    expect(formatSize(10_000_000_000)).toBe('10 GB');
    expect(formatSize(500_000_000)).toBe('500 MB');
    expect(formatSize(-1)).toBe('0 B');
    expect(formatDay('2026-10-18T09:00:00Z', 'UTC')).toBe('18 Oct 2026');
    expect(formatDay(null)).toBeNull();
    expect(formatDay('not a date')).toBeNull();
  });
});
