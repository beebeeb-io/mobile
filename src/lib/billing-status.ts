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
 *  - `status === 'cancelled'` / `'canceled'` (task 1601): the paid period has
 *    ELAPSED — the row can still carry `plan: 'pro'` (or any paid slug) with
 *    no more entitlement behind it (prod row `43cc7529…`, 2026-09-28). This
 *    module forces Free/no-badge/no-line for that status regardless of what
 *    `plan` the caller passed in, so a caller that (by mistake) still reads
 *    `subscription.plan` instead of `effectivePlan(subscription)` cannot
 *    reintroduce the "Pro chip over a Free quota bar" bug.
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
  /**
   * Task 1037 (additive server fields; missing means `ok` / null / false).
   * `account_state` `lapsed` is a read-only vault that is deleted at
   * `data_deletion_at`. `needs_plan` never picked a plan. `trial_auto_converts`
   * is true for a trial backed by a payment mandate, which becomes the paid
   * plan at `trial_ends_at` on its own.
   */
  account_state?: string | null;
  data_deletion_at?: string | null;
  trial_auto_converts?: boolean | null;
}

export type BillingBadgeKind = 'trial' | 'cancelling' | 'read_only' | null;

/** The one place a badge kind becomes the text on its chip. */
export function billingBadgeLabel(kind: BillingBadgeKind): string | null {
  if (kind === 'trial') return 'TRIAL';
  if (kind === 'cancelling') return 'CANCELLING';
  if (kind === 'read_only') return 'READ-ONLY';
  return null;
}

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

function isValidIso(iso: string | null | undefined): iso is string {
  return !!iso && !Number.isNaN(new Date(iso).getTime());
}

export function billingStatusView(sub: SubscriptionStatusFields | null | undefined): BillingStatusView {
  const status = (sub?.status ?? '').toLowerCase();

  // Task 1037: the account state outranks the row's status. A lapsed row is
  // usually `cancelled` too, but it is a read-only vault on its way to
  // deletion, not a Free account.
  if (sub?.account_state === 'lapsed') {
    const deletion = sub.data_deletion_at;
    return {
      isFree: false,
      badgeKind: 'read_only',
      statusLine: isValidIso(deletion) ? `Read-only · deleted on ${formatBillingDate(deletion)}` : 'Read-only',
    };
  }
  if (sub?.account_state === 'needs_plan') {
    return { isFree: false, badgeKind: null, statusLine: 'No plan yet' };
  }

  // Task 1601: an ended subscription is never the paid plan and never
  // "Renews" — checked before the plan slug so this holds even if a caller
  // passes the raw (pre-`effectivePlan`) plan through.
  if (status === 'cancelled' || status === 'canceled') {
    return { isFree: true, badgeKind: null, statusLine: null };
  }

  const planSlug = (sub?.plan ?? 'free').toLowerCase();
  const isFree = planSlug === 'free';

  if (isFree) {
    return { isFree, badgeKind: null, statusLine: null };
  }

  if (status === 'trialing') {
    // trial.rs sets current_period_end === trial_ends_at, so either field
    // works — prefer trial_ends_at when present since it's the more
    // explicit contract, fall back to current_period_end for any client
    // response that hasn't been extended with the trial_ends_at field yet.
    const dateIso = sub?.trial_ends_at ?? sub?.current_period_end ?? null;
    // Task 1037: a trial started with a payment mandate becomes the paid plan
    // by itself at the end date. A legacy no-card trial does not (it lapses
    // unless converted on the web), so it keeps the plain line.
    const suffix = sub?.trial_auto_converts === true ? ' · continues automatically' : '';
    return {
      isFree,
      badgeKind: 'trial',
      statusLine: dateIso ? `Trial ends ${formatBillingDate(dateIso)}${suffix}` : null,
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
