/**
 * Pure billing-status view-model — task 1540 findings 1, 2, 4, 6.
 *
 * StorageScreen's `CurrentPlanCard` and SettingsScreen's subscription row
 * both used to render "Renews {current_period_end}" for any paid plan with a
 * `current_period_end`, without ever looking at `subscription.status`. That
 * is wrong for two real server states:
 *
 *  - `status === 'cancelling'`: the server (`beebeeb-api/src/routes/billing.rs`
 *    `cancel_subscription`, Mollie path) sets `status='cancelling'` and
 *    deliberately KEEPS the existing `current_period_end` to model the paid
 *    grace period — the plan lapses to Free on that date, it does not renew.
 *  - `status === 'trialing'`: the server (`beebeeb-api/src/trial.rs`
 *    `start_trial`) sets `current_period_end == trial_ends_at` — that date is
 *    the trial's end / first-charge date, not a renewal, and Pattern-B trials
 *    (no card on file) silently revert to Free on it if never converted.
 *
 * Web already gets this right (`repos/web/src/pages/billing.tsx`): a distinct
 * "Trial" / "Cancelling" status pill, and the "Renews" footer explicitly
 * excludes both statuses. This module is the single, testable place both
 * mobile screens now read from, so the two can't drift apart again the way
 * they already had (StorageScreen.tsx and SettingsScreen.tsx duplicated the
 * exact same wrong logic independently).
 */

export interface SubscriptionStatusFields {
  plan: string;
  status?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
}

export type BillingBadgeKind = 'trial' | 'cancelling' | null;

export interface BillingStatusView {
  /** Plan slug is the free tier — no badge, no status line, ever. */
  isFree: boolean;
  /** Secondary status badge to render next to the plan chip, if any. */
  badgeKind: BillingBadgeKind;
  /** The one line of copy under the plan badge — "Renews …" / "Trial ends …" / "Access until …" — or null if there's nothing to say. */
  statusLine: string | null;
}

/**
 * Matches the exact `toLocaleDateString('en-US', { month: 'short', day:
 * 'numeric', year: 'numeric' })` formatting both screens already used inline
 * for `current_period_end` — extracted so it has one implementation and one
 * test, not two copies that could format differently.
 */
export function formatBillingDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function billingStatusView(sub: SubscriptionStatusFields | null | undefined): BillingStatusView {
  const planSlug = (sub?.plan ?? 'free').toLowerCase();
  const isFree = planSlug === 'free';

  if (isFree) {
    return { isFree, badgeKind: null, statusLine: null };
  }

  const status = (sub?.status ?? '').toLowerCase();

  if (status === 'trialing') {
    // trial.rs sets current_period_end === trial_ends_at, so either field
    // works — prefer trial_ends_at when present since it's the more
    // explicit contract, fall back to current_period_end for any client
    // response that hasn't been extended with the trial_ends_at field yet.
    const dateIso = sub?.trial_ends_at ?? sub?.current_period_end ?? null;
    return {
      isFree,
      badgeKind: 'trial',
      statusLine: dateIso ? `Trial ends ${formatBillingDate(dateIso)}` : null,
    };
  }

  if (status === 'cancelling') {
    const dateIso = sub?.current_period_end ?? null;
    return {
      isFree,
      badgeKind: 'cancelling',
      statusLine: dateIso ? `Access until ${formatBillingDate(dateIso)}` : null,
    };
  }

  const dateIso = sub?.current_period_end ?? null;
  return {
    isFree,
    badgeKind: null,
    statusLine: dateIso ? `Renews ${formatBillingDate(dateIso)}` : null,
  };
}
