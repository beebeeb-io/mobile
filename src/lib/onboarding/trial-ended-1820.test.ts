// @ts-nocheck
/**
 * Task 1820: `trial_ended` rendered from the onboarding document, in both shapes the
 * end of a no-card trial can leave behind (server task 1755, spec 4b.4):
 *   - files KEPT: usage is within the allowance, nothing is pending, nothing is deleted;
 *   - a DEADLINE: usage is over the allowance, the 14-day read-only window runs to
 *     `lifecycle.data_deletion_at`, then the files above the allowance are deleted.
 * Status text only, no purchase wording (App Store 3.1.x).
 */
import { describe, expect, test } from 'bun:test';
import { loadFixture } from './fixtures';
import { parseOnboardingDocument } from './parse';
import { summarizeAccount } from './account-summary';
import { gateFromDocument } from './account-gate';
import { trialEndedBannerText } from '../account-state';

const PURCHASE =
  /subscribe|subscription|upgrade|\bbuy\b|purchase|checkout|\bprices?\b|pricing|€|\$|per (month|year)|start (a |the |your )?(\d+-day )?trial|choose (a|your) plan|see plans|add (a )?card|pay now/i;

function doc(mutate) {
  const raw = JSON.parse(JSON.stringify(loadFixture('account.trial_ended.ios')));
  if (mutate) mutate(raw);
  const r = parseOnboardingDocument(raw);
  if (!r.ok) throw new Error('did not parse');
  return r.doc;
}

/** Usage trimmed to 1.2 GB (allowance 2 GB): nothing pending, nothing to delete. */
const kept = (raw) => {
  raw.account.storage.used_bytes = 1_200_000_000;
  raw.account.storage.over_allowance = false;
  delete raw.account.lifecycle;
  delete raw.copy.trial_ended_over_allowance;
};

describe('trial_ended with a deadline (usage over the allowance)', () => {
  test('the server sentence is shown verbatim, with the deletion date', () => {
    const s = summarizeAccount(doc(), 'UTC');
    expect(s.headline).toBe('Your trial has ended');
    expect(s.lines).toEqual(['Your trial ended. Files above 2 GB are read-only and will be deleted on 1 Nov unless you free up space.']);
    expect(s.tone).toBe('restricted');
  });

  test('when the server sentence is unusable the client sentence says "deleted on <date>", never "read-only until"', () => {
    const s = summarizeAccount(doc((raw) => { raw.copy.trial_ended_over_allowance = 'Subscribe now to keep your files.'; }), 'UTC');
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toBe('Files above 2 GB are read-only and will be deleted on 1 Nov 2026 unless you free up space.');
    expect(s.lines[0]).not.toMatch(/read-only until/);
    expect(PURCHASE.test(s.lines[0])).toBe(false);
  });

  test('the Files banner names the same date', () => {
    const gate = gateFromDocument(doc((raw) => { raw.copy.trial_ended_over_allowance = 'Upgrade to keep your files.'; }));
    expect(gate.kind).toBe('trial_ended');
    expect(trialEndedBannerText(gate)).toMatch(/deleted on Nov 1, 2026/);
  });
});

describe('trial_ended with the files kept (usage within the allowance, no deadline)', () => {
  test('says the files are kept, names no deletion date, and is not alarming', () => {
    const s = summarizeAccount(doc(kept), 'UTC');
    expect(s.headline).toBe('Your trial has ended');
    expect(s.lines).toEqual(['Your files are kept. They are within your 2 GB allowance, so nothing will be deleted.']);
    expect(s.lines.join(' ')).not.toMatch(/deleted on|read-only/);
    expect(s.tone).toBe('neutral');
    expect(PURCHASE.test(s.lines.join(' '))).toBe(false);
  });

  test('over the allowance but no deadline in the document: read-only, and no invented date', () => {
    const s = summarizeAccount(doc((raw) => { delete raw.account.lifecycle; delete raw.copy.trial_ended_over_allowance; }), 'UTC');
    expect(s.lines).toEqual(['Files above 2 GB are read-only.']);
    expect(s.lines[0]).not.toMatch(/deleted on/);
  });

  test('the Files banner for a kept-files gate carries no deletion date', () => {
    const gate = gateFromDocument(doc(kept));
    expect(gate.kind).toBe('trial_ended');
    expect(gate.dataDeletionAt).toBeNull();
    expect(trialEndedBannerText(gate)).not.toMatch(/deleted on/);
  });
});
