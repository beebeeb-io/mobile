/**
 * The account chip on Settings and on Storage, drawn from the server's onboarding
 * document (task 1821, spec 4b.7, 4b.8).
 *
 * Why this exists. Both screens used to read the raw `/billing/subscription` row:
 * a trial on the personal plan said "BASIC TRIAL", a trial that had already ended
 * still said "TRIAL / Trial ends ...", and an account with no plan said "No plan plan".
 * The document's `account.state` is the one name for what the account is right now
 * (allowance / trialing / trial_ended / lapsed / active ...), so the chip reads it.
 *
 * STATE ONLY (App Store 3.1.1 / 3.1.3, task 1400): a label for what the account is,
 * and one line of facts. No price, no plan to buy, no action. The one plan name that
 * can appear is the account's OWN plan, for the states where it holds one.
 *
 * Pure: no React, no network.
 */
import { formatDay, formatSize, summarizeAccount } from './account-summary';
import type { OnboardingDocument } from './types';

export interface PlanCardView {
  /** The chip text, e.g. "Allowance", "Trial", "Trial ended". Never "<x> plan". */
  label: string;
  /** A second chip, or null. Only a cancelled trial has one. */
  badge: string | null;
  /** One line of facts under the chip, or null. */
  statusLine: string | null;
}

export interface PlanCardOptions {
  /**
   * The account's own plan name ("Basic"), for the states where it holds one
   * (active, past_due, ...). Ignored for allowance and trial states.
   */
  planName?: string | null;
  /** The line to show for an `active` account, e.g. "Renews 12 Oct 2026". */
  activeLine?: string | null;
  timeZone?: string;
}

export function planCardFromDocument(doc: OnboardingDocument, opts: PlanCardOptions = {}): PlanCardView {
  const account = doc.account;
  if (!account) throw new Error('planCardFromDocument: not an account document');
  const tz = opts.timeZone;
  const summary = summarizeAccount(doc, tz);
  const usage = summary.usage;
  const own = opts.planName || null;
  const trialEnd = formatDay(account.trial?.endsAt, tz);
  const deletion = formatDay(account.lifecycle?.dataDeletionAt, tz);

  switch (account.state) {
    case 'allowance':
      return {
        label: 'Allowance',
        badge: null,
        statusLine: usage?.allowanceBytes != null ? `${formatSize(usage.allowanceBytes)} of storage` : null,
      };
    case 'trialing_no_card':
    case 'trialing':
      return { label: 'Trial', badge: null, statusLine: trialEnd ? `Ends ${trialEnd}` : null };
    case 'trial_cancelling':
      return { label: 'Trial', badge: 'CANCELLED', statusLine: trialEnd ? `Access until ${trialEnd}` : summary.lines[0] ?? null };
    case 'trial_ended': {
      const over = usage?.overAllowance === true || deletion !== null;
      if (over) return { label: 'Trial ended', badge: null, statusLine: deletion ? `Read-only · deleted on ${deletion}` : 'Read-only' };
      return {
        label: 'Trial ended',
        badge: null,
        statusLine: usage?.allowanceBytes != null ? `Files kept · ${formatSize(usage.allowanceBytes)} allowance` : 'Files kept',
      };
    }
    case 'needs_plan':
      return { label: 'No plan', badge: null, statusLine: 'Uploads are off' };
    case 'lapsed':
      return { label: 'Plan ended', badge: null, statusLine: deletion ? `Read-only · deleted on ${deletion}` : 'Read-only' };
    case 'active':
      return { label: own ?? 'Active', badge: null, statusLine: opts.activeLine ?? null };
    case 'past_due':
      return { label: own ?? 'Account', badge: null, statusLine: summary.headline };
    case 'read_only':
      return { label: 'Read-only', badge: null, statusLine: null };
    case 'frozen':
      return { label: 'Frozen', badge: null, statusLine: null };
    case 'legacy_free':
      return { label: 'Free', badge: null, statusLine: null };
    default:
      // An unknown state is only a label (rule 4): the capability rows carry the truth.
      return { label: 'Account', badge: null, statusLine: null };
  }
}
