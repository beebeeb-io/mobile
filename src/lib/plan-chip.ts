/**
 * The account chip shared by Settings ("Subscription" row) and Storage ("Account"
 * card) — task 1821.
 *
 * Source of truth, in order:
 *  1. the server's onboarding document (`account.state`): allowance / trialing /
 *     trial_ended / lapsed / active ... See `onboarding/plan-card.ts`;
 *  2. without a document (older server, offline first paint): the
 *     `/billing/subscription` row through `billingStatusView`, whose stale-trial
 *     guard keeps an ended trial from showing a TRIAL chip.
 *
 * State only: no price, no plan to buy, no action (App Store 3.1.1 / 3.1.3).
 * Pure: no React, no network.
 */
import { billingBadgeLabel, billingStatusView, type SubscriptionStatusFields } from './billing-status';
import { effectivePlan, planDisplayName } from './effective-plan';
import { planCardFromDocument, type PlanCardView } from './onboarding/plan-card';
import type { OnboardingDocument } from './onboarding/types';

export interface ChipSubscription extends SubscriptionStatusFields {
  plan: string;
  effective_plan?: string | null;
  uploads_blocked_at?: string | null;
  access_until?: string | null;
}

/** The fields `billingStatusView` reads, from a subscription row and the entitled plan slug. */
export function billingFieldsOf(sub: ChipSubscription | null | undefined, planSlug: string): SubscriptionStatusFields {
  return {
    plan: planSlug,
    status: sub?.status ?? null,
    current_period_end: sub?.current_period_end ?? null,
    trial_ends_at: sub?.trial_ends_at ?? null,
    // Task 1037: lapsed / needs_plan and trial auto-conversion.
    account_state: sub?.account_state ?? null,
    data_deletion_at: sub?.data_deletion_at ?? null,
    trial_auto_converts: sub?.trial_auto_converts ?? null,
    // Task 1605.
    uploads_blocked_at: sub?.uploads_blocked_at ?? null,
    access_until: sub?.access_until ?? null,
  };
}

export function accountChip(input: {
  doc: OnboardingDocument | null | undefined;
  subscription: ChipSubscription | null | undefined;
  /** The plan slug to fall back on when there is no subscription row (usage.plan_name). */
  fallbackPlanSlug?: string | null;
  now?: Date;
}): PlanCardView | null {
  const { doc, subscription } = input;
  const slug = subscription ? effectivePlan(subscription) : input.fallbackPlanSlug ?? null;
  const fields = slug ? billingFieldsOf(subscription, slug) : null;
  const billing = billingStatusView(fields, input.now);

  if (doc?.account) {
    const own = slug && slug !== 'none' && slug !== 'free' ? planDisplayName(slug) : null;
    // The document is authoritative (PR #169 P2): a billing line is only used for an active
    // card when the row itself is active, never a stale lapsed / needs_plan / ended-trial line.
    const rowInactive =
      !subscription ||
      subscription.account_state === 'lapsed' ||
      subscription.account_state === 'needs_plan' ||
      subscription.account_state === 'trial_ended' ||
      !!subscription.uploads_blocked_at ||
      !!subscription.data_deletion_at ||
      billing.badgeKind === 'read_only';
    return planCardFromDocument(doc, { planName: own, activeLine: rowInactive ? null : billing.statusLine });
  }
  if (!slug) return null;
  return { label: planDisplayName(slug), badge: billingBadgeLabel(billing.badgeKind), statusLine: billing.statusLine };
}
