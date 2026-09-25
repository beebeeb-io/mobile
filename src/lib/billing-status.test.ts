// @ts-nocheck
/**
 * Task 1540 findings 1, 2, 4, 6 — the plan badge/renewal line must reflect
 * `subscription.status`, not just the plan slug.
 *
 * Bug: StorageScreen's `CurrentPlanCard` and SettingsScreen's subscription
 * row both rendered "Renews {current_period_end}" whenever a plan was paid
 * and had a `current_period_end`, with zero reference to `status`. Server
 * truth (repos/server/beebeeb-api/src/routes/billing.rs `cancel_subscription`,
 * `repos/server/beebeeb-api/src/trial.rs` `start_trial`):
 *   - a `status='cancelling'` subscription KEEPS its existing
 *     `current_period_end` (grace period) — the plan lapses to Free on that
 *     date, it does not renew.
 *   - a `status='trialing'` subscription sets `current_period_end ==
 *     trial_ends_at` — that date is the trial's end / first-charge date, not
 *     a renewal.
 * Web already gets this right (repos/web/src/pages/billing.tsx: a distinct
 * "Trial" / "Cancelling" status pill, and the "Renews" footer explicitly
 * excludes both statuses). This module is the pure view-model both mobile
 * screens now share, so the same logic can't drift between them again.
 *
 * Pure logic, no native imports — needs no `mock.module` (mobile/CLAUDE.md
 * "Tests": isolated per-file, but only modules actually touched need mocking).
 */
import { describe, expect, test } from 'bun:test';
import { billingStatusView, formatBillingDate } from './billing-status';

describe('formatBillingDate', () => {
  test('formats an ISO date as "Mon D, YYYY" (matches the pre-existing inline format)', () => {
    expect(formatBillingDate('2026-10-12T00:00:00Z')).toBe('Oct 12, 2026');
  });
});

describe('billingStatusView — free plan', () => {
  test('free plan: no badge, no status line, regardless of status/dates', () => {
    const view = billingStatusView({
      plan: 'free',
      status: 'active',
      current_period_end: '2026-10-12T00:00:00Z',
    });
    expect(view).toEqual({ isFree: true, badgeKind: null, statusLine: null });
  });

  test('null subscription: treated as free', () => {
    expect(billingStatusView(null)).toEqual({ isFree: true, badgeKind: null, statusLine: null });
  });
});

describe('billingStatusView — normal active paid plan', () => {
  test('active paid plan with current_period_end: "Renews {date}", no badge', () => {
    const view = billingStatusView({
      plan: 'pro',
      status: 'active',
      current_period_end: '2026-10-12T00:00:00Z',
    });
    expect(view).toEqual({ isFree: false, badgeKind: null, statusLine: 'Renews Oct 12, 2026' });
  });

  test('active paid plan with no current_period_end: no status line', () => {
    const view = billingStatusView({ plan: 'pro', status: 'active', current_period_end: null });
    expect(view).toEqual({ isFree: false, badgeKind: null, statusLine: null });
  });
});

describe('billingStatusView — finding 1: cancelling subscription must NOT say "Renews"', () => {
  test('status=cancelling: "Access until {date}", badge=cancelling — never "Renews"', () => {
    const view = billingStatusView({
      plan: 'pro',
      status: 'cancelling',
      // Server keeps current_period_end unchanged on cancel (grace period) —
      // this is the date the plan actually LAPSES to Free, not renews.
      current_period_end: '2026-11-01T00:00:00Z',
    });
    expect(view.badgeKind).toBe('cancelling');
    expect(view.statusLine).toBe('Access until Nov 1, 2026');
    expect(view.statusLine).not.toContain('Renews');
  });
});

describe('billingStatusView — findings 2, 4, 6: trialing subscription must be surfaced as a trial', () => {
  test('status=trialing with trial_ends_at: "Trial ends {date}", badge=trial — never "Renews"', () => {
    const view = billingStatusView({
      plan: 'pro',
      status: 'trialing',
      // trial.rs sets current_period_end === trial_ends_at for a trialing row.
      current_period_end: '2026-10-20T00:00:00Z',
      trial_ends_at: '2026-10-20T00:00:00Z',
    });
    expect(view.badgeKind).toBe('trial');
    expect(view.statusLine).toBe('Trial ends Oct 20, 2026');
    expect(view.statusLine).not.toContain('Renews');
  });

  test('status=trialing with no trial_ends_at field falls back to current_period_end (server always sets both equal, but the client type may lag)', () => {
    const view = billingStatusView({
      plan: 'pro',
      status: 'trialing',
      current_period_end: '2026-10-20T00:00:00Z',
    });
    expect(view.badgeKind).toBe('trial');
    expect(view.statusLine).toBe('Trial ends Oct 20, 2026');
  });

  test('status=trialing with neither date present: badge shown, no status line (never crashes)', () => {
    const view = billingStatusView({ plan: 'pro', status: 'trialing', current_period_end: null });
    expect(view.badgeKind).toBe('trial');
    expect(view.statusLine).toBeNull();
  });
});

describe('billingStatusView — status is case-insensitive (server casing is not a documented contract)', () => {
  test('status="Cancelling" (capitalized) still matches', () => {
    const view = billingStatusView({ plan: 'pro', status: 'Cancelling', current_period_end: '2026-11-01T00:00:00Z' });
    expect(view.badgeKind).toBe('cancelling');
  });
});
