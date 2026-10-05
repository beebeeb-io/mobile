// @ts-nocheck
/**
 * Task 1037: the server's `account_state` decides whether the app can be used.
 * `needs_plan` blocks the file UI, `lapsed` makes the vault read-only, and
 * anything else (including an older server that does not send the field yet)
 * is `ok`.
 *
 * Pure logic, no native imports, so no `mock.module` is needed.
 */
import { describe, expect, test } from 'bun:test';
import {
  accountGateFor,
  lapsedBannerText,
  normalizeAccountState,
  readOnlyUploadMessage,
  uploadsBlocked,
} from './account-state';

describe('normalizeAccountState', () => {
  test('passes the three known states through', () => {
    expect(normalizeAccountState('ok')).toBe('ok');
    expect(normalizeAccountState('needs_plan')).toBe('needs_plan');
    expect(normalizeAccountState('lapsed')).toBe('lapsed');
  });

  test('missing field (older server) is ok', () => {
    expect(normalizeAccountState(undefined)).toBe('ok');
    expect(normalizeAccountState(null)).toBe('ok');
  });

  test('an unknown future value is ok, never a lockout', () => {
    expect(normalizeAccountState('something_new')).toBe('ok');
    expect(normalizeAccountState('')).toBe('ok');
  });
});

describe('accountGateFor', () => {
  test('no subscription payload (fetch failed / signed out) is ok', () => {
    expect(accountGateFor(null)).toEqual({ kind: 'ok' });
    expect(accountGateFor(undefined)).toEqual({ kind: 'ok' });
  });

  test('older server response without account_state is ok', () => {
    expect(accountGateFor({ plan: 'pro', status: 'active' })).toEqual({ kind: 'ok' });
  });

  test('needs_plan blocks the app', () => {
    expect(accountGateFor({ account_state: 'needs_plan', data_deletion_at: null })).toEqual({ kind: 'needs_plan' });
  });

  test('lapsed carries the deletion date', () => {
    expect(
      accountGateFor({ account_state: 'lapsed', data_deletion_at: '2026-12-01T12:00:00Z' }),
    ).toEqual({ kind: 'lapsed', dataDeletionAt: '2026-12-01T12:00:00Z' });
  });

  test('lapsed without a deletion date keeps null (older server mid-rollout)', () => {
    expect(accountGateFor({ account_state: 'lapsed' })).toEqual({ kind: 'lapsed', dataDeletionAt: null });
  });
});

describe('uploadsBlocked', () => {
  test('only needs_plan and lapsed block uploads and backup', () => {
    expect(uploadsBlocked({ kind: 'ok' })).toBe(false);
    expect(uploadsBlocked({ kind: 'needs_plan' })).toBe(true);
    expect(uploadsBlocked({ kind: 'lapsed', dataDeletionAt: null })).toBe(true);
  });
});

describe('lapsedBannerText', () => {
  test('names the deletion date', () => {
    expect(lapsedBannerText('2026-12-01T12:00:00Z')).toBe(
      'Your trial has ended. Your vault is read-only and will be deleted on Dec 1, 2026.',
    );
  });

  test('without a date it still says read-only and never prints "Invalid Date"', () => {
    expect(lapsedBannerText(null)).toBe('Your trial has ended. Your vault is read-only.');
    expect(lapsedBannerText('not-a-date')).toBe('Your trial has ended. Your vault is read-only.');
  });

  test('no price and no purchase wording (App Review 3.1.1(a), task 1400)', () => {
    const text = lapsedBannerText('2026-12-01T12:00:00Z');
    expect(text).not.toMatch(/€|\$|upgrad|subscribe|buy|purchase|price/i);
  });
});

describe('readOnlyUploadMessage', () => {
  test('lapsed: explains read-only and what still works', () => {
    const msg = readOnlyUploadMessage({ kind: 'lapsed', dataDeletionAt: null });
    expect(msg).toMatch(/read-only/i);
    expect(msg).toMatch(/download/i);
  });

  test('needs_plan: points to the web without a link or a price', () => {
    const msg = readOnlyUploadMessage({ kind: 'needs_plan' });
    expect(msg).toMatch(/beebeeb\.io/);
    expect(msg).not.toMatch(/https?:\/\//);
  });

  test('ok: null (nothing to explain)', () => {
    expect(readOnlyUploadMessage({ kind: 'ok' })).toBeNull();
  });

  test('neither message uses purchase wording', () => {
    for (const gate of [{ kind: 'lapsed', dataDeletionAt: null }, { kind: 'needs_plan' }]) {
      expect(readOnlyUploadMessage(gate)).not.toMatch(/€|\$|upgrad|subscribe|buy|purchase|price/i);
    }
  });
});

describe('process-wide gate mirror', () => {
  test('defaults to ok, and reflects what the provider sets', async () => {
    const mod = await import('./account-state');
    expect(mod.getCurrentAccountGate()).toEqual({ kind: 'ok' });
    mod.setCurrentAccountGate({ kind: 'lapsed', dataDeletionAt: null });
    expect(mod.getCurrentAccountGate()).toEqual({ kind: 'lapsed', dataDeletionAt: null });
    mod.setCurrentAccountGate({ kind: 'ok' });
  });

  test('requestAccountStateRefresh calls the registered refresher; unregister stops it', async () => {
    const mod = await import('./account-state');
    let calls = 0;
    const unregister = mod.registerAccountStateRefresher(() => { calls += 1; });
    mod.requestAccountStateRefresh();
    expect(calls).toBe(1);
    unregister();
    mod.requestAccountStateRefresh();
    expect(calls).toBe(1);
  });
});

describe('gateForRefusalCode — server refusals of upload init / share creation (409)', () => {
  test('plan_required means needs_plan, whatever the app last knew', async () => {
    const { gateForRefusalCode } = await import('./account-state');
    expect(gateForRefusalCode('plan_required', { kind: 'ok' })).toEqual({ kind: 'needs_plan' });
  });

  test('account_lapsed means lapsed, keeping a known deletion date', async () => {
    const { gateForRefusalCode } = await import('./account-state');
    expect(gateForRefusalCode('account_lapsed', { kind: 'ok' })).toEqual({ kind: 'lapsed', dataDeletionAt: null });
    expect(
      gateForRefusalCode('account_lapsed', { kind: 'lapsed', dataDeletionAt: '2026-12-01T12:00:00Z' }),
    ).toEqual({ kind: 'lapsed', dataDeletionAt: '2026-12-01T12:00:00Z' });
  });

  test('quota_exceeded is read-only only when the account is already known to be blocked', async () => {
    const { gateForRefusalCode } = await import('./account-state');
    expect(gateForRefusalCode('quota_exceeded', { kind: 'ok' })).toBeNull();
    expect(gateForRefusalCode('quota_exceeded', { kind: 'needs_plan' })).toEqual({ kind: 'needs_plan' });
  });

  test('anything else is not an account refusal', async () => {
    const { gateForRefusalCode } = await import('./account-state');
    for (const code of [undefined, null, '', 'account_mismatch', 'object_budget_exceeded']) {
      expect(gateForRefusalCode(code, { kind: 'ok' })).toBeNull();
    }
  });
});

describe('isAccountRefusalCode — which upload errors should make the app re-check the account', () => {
  test('the two new codes plus quota_exceeded', async () => {
    const { isAccountRefusalCode } = await import('./account-state');
    expect(isAccountRefusalCode('plan_required')).toBe(true);
    expect(isAccountRefusalCode('account_lapsed')).toBe(true);
    expect(isAccountRefusalCode('quota_exceeded')).toBe(true);
    expect(isAccountRefusalCode('account_mismatch')).toBe(false);
    expect(isAccountRefusalCode(undefined)).toBe(false);
  });
});

describe('task 1746 — trial_ended (no-card trial over the allowance, spec 4b.7)', () => {
  test('the server code makes the app read-only, keeping a known deletion date and banner sentence', async () => {
    const { gateForRefusalCode } = await import('./account-state');
    expect(gateForRefusalCode('trial_ended', { kind: 'ok' })).toEqual({ kind: 'trial_ended', dataDeletionAt: null, bannerText: null });
    const known = { kind: 'trial_ended', dataDeletionAt: '2026-11-01T09:00:00Z', bannerText: 'Your trial ended.' };
    expect(gateForRefusalCode('trial_ended', known)).toEqual(known);
  });

  test('it makes uploads blocked and says why, without a purchase word', async () => {
    const { readOnlyUploadMessage, uploadsBlocked } = await import('./account-state');
    const gate = { kind: 'trial_ended', dataDeletionAt: null, bannerText: null };
    expect(uploadsBlocked(gate)).toBe(true);
    const msg = readOnlyUploadMessage(gate);
    expect(msg).toMatch(/read-only/);
    expect(msg).toMatch(/download and delete/);
    expect(msg).not.toMatch(/subscribe|upgrade|buy|purchase|price|plan/i);
  });

  test('quota_exceeded while trial_ended keeps the trial_ended gate; the code is an account refusal', async () => {
    const { gateForRefusalCode, isAccountRefusalCode } = await import('./account-state');
    const gate = { kind: 'trial_ended', dataDeletionAt: null, bannerText: null };
    expect(gateForRefusalCode('quota_exceeded', gate)).toEqual(gate);
    expect(isAccountRefusalCode('trial_ended')).toBe(true);
  });
});

describe('task 1746 — trialEndedBannerText (Files banner, facts only)', () => {
  test('the server sentence wins when it passed the no-purchase filter', async () => {
    const { trialEndedBannerText } = await import('./account-state');
    expect(trialEndedBannerText({ dataDeletionAt: '2026-11-01T09:00:00Z', bannerText: 'Your trial ended. Files above 2 GB are read-only.' })).toBe('Your trial ended. Files above 2 GB are read-only.');
  });
  test('without it the client words it from the deletion date, or without one', async () => {
    const { trialEndedBannerText } = await import('./account-state');
    expect(trialEndedBannerText({ dataDeletionAt: '2026-11-01T12:00:00Z', bannerText: null })).toMatch(/^Your trial ended\. Files above your allowance are read-only and will be deleted on \w{3} \d{1,2}, 2026 unless you free up space\.$/);
    expect(trialEndedBannerText({ dataDeletionAt: null, bannerText: null })).toBe('Your trial ended. Files above your allowance are read-only.');
    expect(trialEndedBannerText({ dataDeletionAt: 'nonsense', bannerText: null })).toBe('Your trial ended. Files above your allowance are read-only.');
  });
  test('no purchase vocabulary and no web direction in the client wording', async () => {
    const { trialEndedBannerText } = await import('./account-state');
    for (const d of [null, '2026-11-01T12:00:00Z']) {
      expect(trialEndedBannerText({ dataDeletionAt: d, bannerText: null })).not.toMatch(/subscribe|upgrade|buy|purchase|price|plans?\b|web|beebeeb\.io/i);
    }
  });
});
