/**
 * The plan a user is actually ENTITLED to right now — task 1601.
 *
 * THE BUG. `SettingsScreen.tsx` and `StorageScreen.tsx` both read
 * `subscription.plan` directly. That field is the plan on the row, not the
 * plan the user has access to: a voluntarily-cancelled subscription keeps
 * `plan = 'pro'` (row 43cc7529…, `status: 'cancelled'`, prod, 2026-09-28)
 * while the quota endpoint already only grants paid quota to
 * `status IN ('active', 'trialing', 'cancelling')` — so the plan chip said
 * "Pro" over a 5 GB (free-tier) quota bar. Same class of bug web already
 * fixed for the `'cancelling'` case (`billing.tsx:710-717`) but the mobile
 * screens never had a `'cancelled'` branch for it at all.
 *
 * THE FIX. One function, one definition of "entitled", used by every screen
 * that shows a plan name or a plan-derived quota:
 *  - the server's own `effective_plan` field (`GET /subscription`, added by
 *    the server half of task 1601) is authoritative when present — it is
 *    computed from the SAME status set the quota endpoint uses, so the plan
 *    chip and the quota bar can never disagree again.
 *  - otherwise (older server build mid-rollout), derive it exactly the way
 *    web already does: no row → free; `status` `'cancelled'`/`'canceled'` →
 *    free (the period has elapsed); anything else, including
 *    `'cancelling'` (paid access continues until `current_period_end`) →
 *    the row's own `plan`.
 */

export interface EffectivePlanSubscription {
  plan: string;
  status?: string | null;
  /** Additive server field (task 1601) — the entitled plan, when the server sends one. */
  effective_plan?: string | null;
}

export function effectivePlan(
  subscription: EffectivePlanSubscription | null | undefined,
): string {
  // Server field wins outright when present — it already folds in status,
  // so no further derivation happens once we have it.
  if (subscription?.effective_plan) return subscription.effective_plan;

  if (!subscription) return 'free';

  const status = (subscription.status ?? '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'free';

  // 'cancelling' (paid until current_period_end), 'active', 'trialing', or
  // any other status the server ever adds: the row's plan is what the user
  // is entitled to.
  return subscription.plan ?? 'free';
}

/**
 * Display name for a plan slug. It used to be duplicated in SettingsScreen and
 * StorageScreen, and neither copy knew `starter` or `none`. Task 1037: `none`
 * is the `effective_plan` of a `needs_plan` or `lapsed` account. The server is
 * migrating personal -> basic and data_hoarder -> business, so the legacy
 * slugs map to the new labels.
 */
const PLAN_DISPLAY_NAMES: Record<string, string> = {
  none: 'No plan',
  free: 'Free',
  starter: 'Starter',
  basic: 'Basic',
  personal: 'Basic',
  pro: 'Pro',
  business: 'Business',
  data_hoarder: 'Business',
  team: 'Team',
};

export function planDisplayName(slug: string): string {
  return PLAN_DISPLAY_NAMES[slug.toLowerCase()] ?? slug;
}
