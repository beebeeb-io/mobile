// @ts-nocheck
/**
 * Task 1605 — never-paid trial cancel (read-only immediately, 14-day
 * retention dates) and the 25 GB active-trial cap. Server PR #129
 * (`.claude/tasks/in-development/1605-trial-abuse-limits-cancel-readonly-retention-cap.md`).
 *
 * Mobile has NO in-app purchase / subscription-management call to action
 * (task 1400, App Review 3.1.1(a) — see account-state.ts's file header and
 * StorageScreen.tsx's). So unlike web, there is no "pay now" button here —
 * these tests only cover the informational copy/state, never a purchase
 * action. Deviation recorded in DEVIATIONS.md → "Task 1605".
 *
 * Pure logic, no native imports — needs no `mock.module`.
 */
import { describe, expect, test } from 'bun:test';
import {
  accountGateFor,
  gateForRefusalCode,
  isAccountRefusalCode,
  readOnlyUploadMessage,
  TRIAL_CANCELLED_READ_ONLY_ERROR,
  trialCancelledReadOnlyStatusLine,
  uploadsBlocked,
} from './account-state';
import { billingStatusView, formatBillingDate, trialCapNote } from './billing-status';
import { formatBytes } from './format';

const ACCESS_UNTIL = '2026-10-13T00:00:00Z';
const DELETION_AT = '2026-10-27T00:00:00Z';

describe('accountGateFor — never-paid trial cancel', () => {
  test('uploads_blocked_at set → trial_cancelled_read_only gate, dates carried through', () => {
    expect(
      accountGateFor({
        account_state: 'ok',
        uploads_blocked_at: '2026-09-29T09:00:00Z',
        access_until: ACCESS_UNTIL,
        data_deletion_at: DELETION_AT,
      }),
    ).toEqual({ kind: 'trial_cancelled_read_only', accessUntil: ACCESS_UNTIL, dataDeletionAt: DELETION_AT });
  });

  test('account_state ok + no uploads_blocked_at → ok (a paying customer mid-cancel-grace)', () => {
    expect(accountGateFor({ account_state: 'ok', uploads_blocked_at: null })).toEqual({ kind: 'ok' });
  });

  test('lapsed still outranks uploads_blocked_at (should never co-occur, but lapsed is checked first)', () => {
    expect(
      accountGateFor({ account_state: 'lapsed', data_deletion_at: DELETION_AT, uploads_blocked_at: '2026-09-29T09:00:00Z' }),
    ).toEqual({ kind: 'lapsed', dataDeletionAt: DELETION_AT });
  });
});

describe('uploadsBlocked — trial_cancelled_read_only', () => {
  test('true, same as lapsed/needs_plan', () => {
    expect(uploadsBlocked({ kind: 'trial_cancelled_read_only', accessUntil: null, dataDeletionAt: null })).toBe(true);
  });
});

describe('readOnlyUploadMessage — trial_cancelled_read_only', () => {
  test('names the trial cancellation, never the generic lapsed copy', () => {
    const msg = readOnlyUploadMessage({ kind: 'trial_cancelled_read_only', accessUntil: null, dataDeletionAt: null });
    expect(msg).toContain('cancelled your trial');
    expect(msg).not.toContain('trial has ended');
  });

  test('null for ok', () => {
    expect(readOnlyUploadMessage({ kind: 'ok' })).toBeNull();
  });
});

describe('trialCancelledReadOnlyStatusLine', () => {
  test('exact "Uploads stopped · Access until <date> · Files deleted on <date>"', () => {
    const line = trialCancelledReadOnlyStatusLine(
      { kind: 'trial_cancelled_read_only', accessUntil: ACCESS_UNTIL, dataDeletionAt: DELETION_AT },
      formatBillingDate,
    );
    expect(line).toBe(
      `Uploads stopped · Access until ${formatBillingDate(ACCESS_UNTIL)} · Files deleted on ${formatBillingDate(DELETION_AT)}`,
    );
  });

  test('never contains "Renews"', () => {
    const line = trialCancelledReadOnlyStatusLine(
      { kind: 'trial_cancelled_read_only', accessUntil: ACCESS_UNTIL, dataDeletionAt: DELETION_AT },
      formatBillingDate,
    );
    expect(line).not.toContain('Renews');
  });

  test('null for any other gate', () => {
    expect(trialCancelledReadOnlyStatusLine({ kind: 'ok' }, formatBillingDate)).toBeNull();
    expect(trialCancelledReadOnlyStatusLine({ kind: 'lapsed', dataDeletionAt: null }, formatBillingDate)).toBeNull();
  });
});

describe('gateForRefusalCode / isAccountRefusalCode — TRIAL_CANCELLED_READ_ONLY_ERROR', () => {
  test('the 409 code maps to the gate, preserving dates already known from GET /billing/subscription', () => {
    const current = { kind: 'trial_cancelled_read_only', accessUntil: ACCESS_UNTIL, dataDeletionAt: DELETION_AT } as const;
    expect(gateForRefusalCode(TRIAL_CANCELLED_READ_ONLY_ERROR, current)).toEqual(current);
  });

  test('the code is a recognized account-refusal code (app re-checks account state)', () => {
    expect(isAccountRefusalCode(TRIAL_CANCELLED_READ_ONLY_ERROR)).toBe(true);
  });

  test('an unrelated code is not a refusal', () => {
    expect(isAccountRefusalCode('not_found')).toBe(false);
  });
});

describe('billingStatusView — cancelling, task 1605 branch', () => {
  test('never-paid cancelled trial gets the compact line, badgeKind cancelling', () => {
    const view = billingStatusView({
      plan: 'basic',
      status: 'cancelling',
      current_period_end: ACCESS_UNTIL,
      uploads_blocked_at: '2026-09-29T09:00:00Z',
      access_until: ACCESS_UNTIL,
      data_deletion_at: DELETION_AT,
    });
    expect(view.badgeKind).toBe('cancelling');
    expect(view.statusLine).toBe(
      `Uploads stopped · Access until ${formatBillingDate(ACCESS_UNTIL)} · Files deleted on ${formatBillingDate(DELETION_AT)}`,
    );
  });

  test('a paying customer\'s ordinary cancel keeps the existing "Access until" line, no "Uploads stopped"', () => {
    const view = billingStatusView({
      plan: 'pro',
      status: 'cancelling',
      current_period_end: ACCESS_UNTIL,
      uploads_blocked_at: null,
    });
    expect(view.statusLine).toBe(`Access until ${formatBillingDate(ACCESS_UNTIL)}`);
  });
});

describe('trialCapNote — informational only, no purchase CTA (task 1400)', () => {
  test('names the cap and points to the web, for a capped trialing row', () => {
    const note = trialCapNote({ status: 'trialing', trial_storage_cap_bytes: 25_000_000_000 }, formatBytes);
    expect(note).toContain(formatBytes(25_000_000_000));
    expect(note).toContain('on the web');
  });

  test('never a tappable action word like "Pay now" or "Upgrade" (task 1400 — informational only)', () => {
    const note = trialCapNote({ status: 'trialing', trial_storage_cap_bytes: 25_000_000_000 }, formatBytes);
    expect(note).not.toMatch(/pay now/i);
    expect(note).not.toMatch(/upgrade/i);
  });

  test('null once the server clears the cap (first charge settled)', () => {
    expect(trialCapNote({ status: 'trialing', trial_storage_cap_bytes: null }, formatBytes)).toBeNull();
  });

  test('null for a non-trialing status', () => {
    expect(trialCapNote({ status: 'active', trial_storage_cap_bytes: 25_000_000_000 }, formatBytes)).toBeNull();
  });

  test('null for a missing subscription', () => {
    expect(trialCapNote(null, formatBytes)).toBeNull();
  });
});
