/**
 * Account-stage view model (task 1746, spec 4b.7, 4b.8, 5.4 B to E, 5.6).
 *
 * `summarizeAccount(doc)` turns an `account` document into plain strings and
 * numbers a component can lay out. It is pure so every `account.state` fixture
 * can be asserted without a DOM.
 *
 * STATUS ONLY. The iOS binary has no purchase UI (App Store 3.1.3, task 1400),
 * so nothing here produces a button label, a price, a plan name to buy, a link
 * or an offer. Every sentence below is a fact about the account or the server's
 * own copy rendered verbatim. `src/lib/onboarding/no-purchase.test.ts` asserts
 * this for every account fixture in the contract.
 *
 * Copy rules:
 *   - Anything the server says in `copy` / `purchase.copy` wins over client
 *     wording (the server owns the sentence that depends on its numbers).
 *   - The client only writes generic framing. It never states a price, a charge
 *     date or a trial length that the document did not carry.
 *   - An unknown `account.state` is only a label: the headline falls back to a
 *     generic one and the capability rows carry the truth (rule 4).
 *   - Sizes are decimal (2 GB = 2_000_000_000), matching the server.
 */

import type { Capability, CapabilityName, OnboardingDocument } from './types';

/**
 * Words that turn a status sentence into a call to action or a price. The server
 * writes ONE copy per account state, not per client, so a sentence meant for a
 * desktop account ("...unless you subscribe or free up space.", server
 * `account_copy`) can arrive on an iOS account. This binary has no purchase UI
 * (App Store 3.1.3), so server copy is rendered through `noPurchaseCopy`.
 */
const PURCHASE_WORDS =
  /subscribe|subscription|upgrade|\bbuy\b|purchase|checkout|\bprices?\b|pricing|€|\$|per (month|year)|choose (a|your) plan|start (a |the |your )?(\d+-day )?trial|pay now/i;

/** The one known clause, removed with its connective: "unless you subscribe or free up space". */
const SUBSCRIBE_CLAUSE = /\bsubscribe or (free up space)/i;

/**
 * A server sentence made safe for a store build with no purchase surface:
 *   1. verbatim when it has no purchase vocabulary (the normal case, spec 5.3);
 *   2. the known "subscribe or free up space" clause reduced to "free up space"
 *      (the server's trial-end sentence, same facts, no call to action);
 *   3. anything else with purchase vocabulary is dropped (null): money fails
 *      closed, and the caller falls back to client-authored status text.
 */
export function noPurchaseCopy(sentence: string | null | undefined): string | null {
  if (!sentence) return null;
  if (!PURCHASE_WORDS.test(sentence)) return sentence;
  const reduced = sentence.replace(SUBSCRIBE_CLAUSE, '$1');
  return PURCHASE_WORDS.test(reduced) ? null : reduced;
}

export type Tone = 'neutral' | 'attention' | 'restricted';

export interface CapabilityRow {
  name: CapabilityName;
  label: string;
  allowed: boolean;
  /** What the person reads next to the row, e.g. "Up to 2 GB" or "Not available". */
  detail: string;
}

export interface UsageSummary {
  usedBytes: number;
  quotaBytes: number;
  allowanceBytes: number | null;
  overAllowance: boolean;
  /**
   * One sentence under the bar when usage is above the allowance, or null.
   * During a trial the bar's "of N" is the TRIAL cap, so the sentence says so
   * and says the smaller allowance applies after it.
   */
  overAllowanceNote: string | null;
  /** used / quota clamped to 0..1; 0 when the quota is 0. */
  fraction: number;
}

export interface AccountSummary {
  state: string;
  headline: string;
  /** Sentences, in order. Server copy first when present. */
  lines: string[];
  tone: Tone;
  usage: UsageSummary | null;
  rows: CapabilityRow[];
  /** The server's "plans are managed on the web" sentence, verbatim, or null. */
  plansManagedNote: string | null;
}

const MB = 1_000_000;
const GB = 1_000_000_000;
const TB = 1_000_000_000_000;

/** "2 GB", "6.3 GB", "10 GB", "500 MB". Decimal units. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''));
  if (bytes >= TB) return `${trim(Math.round((bytes / TB) * 10) / 10)} TB`;
  if (bytes >= GB) return `${trim(Math.round((bytes / GB) * 10) / 10)} GB`;
  if (bytes >= MB) return `${trim(Math.round(bytes / MB))} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/** "18 Oct 2026", or null for a missing or unparseable value. */
export function formatDay(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

const REASON_TEXT: Record<string, string> = {
  plan_required: 'Not available on this account',
  account_lapsed: 'Plan ended',
  trial_cancelled_read_only: 'Trial cancelled',
  trial_ended: 'Trial ended',
  email_unverified: 'Verify your email first',
  billing_read_only: 'Read-only',
  account_frozen: 'Account frozen',
};

const CAPABILITY_LABEL: Record<CapabilityName, string> = {
  download: 'Download',
  upload: 'Upload',
  share: 'Share links',
  delete: 'Delete',
};

function capabilityRow(name: CapabilityName, cap: Capability | undefined): CapabilityRow {
  // Closed set per major (rule 11): absent means not allowed.
  const label = CAPABILITY_LABEL[name];
  if (!cap || !cap.allowed) {
    const phrased = cap?.reason ? REASON_TEXT[cap.reason] : undefined;
    return { name, label, allowed: false, detail: phrased ?? 'Not available' };
  }
  let detail = 'Allowed';
  if (cap.limitBytes !== null) detail = `Up to ${formatSize(cap.limitBytes)}`;
  else if (cap.activeLinksLimit !== null) detail = `Up to ${cap.activeLinksLimit} active links`;
  return { name, label, allowed: true, detail };
}

function overAllowanceNote(
  state: string,
  s: { quotaBytes: number; allowanceBytes: number | null; overAllowance: boolean | null | undefined },
): string | null {
  if (s.overAllowance !== true || s.allowanceBytes === null) return null;
  const allowance = formatSize(s.allowanceBytes);
  if (state === 'trialing_no_card' || state === 'trialing') {
    return `The trial allows up to ${formatSize(s.quotaBytes)}. After it ends, the ${allowance} allowance applies.`;
  }
  return `Your usage is above the ${allowance} allowance.`;
}

function usageOf(doc: OnboardingDocument): UsageSummary | null {
  const s = doc.account?.storage;
  if (!s) return null;
  return {
    usedBytes: s.usedBytes,
    quotaBytes: s.quotaBytes,
    allowanceBytes: s.allowanceBytes,
    overAllowance: s.overAllowance === true,
    overAllowanceNote: overAllowanceNote(doc.account?.state ?? '', s),
    fraction: s.quotaBytes > 0 ? Math.min(1, Math.max(0, s.usedBytes / s.quotaBytes)) : 0,
  };
}

/**
 * A `trial_ended` account whose files are KEPT (PR #168 review). Absence is not
 * evidence: this needs the document to say so explicitly (storage present with
 * `over_allowance === false`) and to carry no deletion date. Missing storage or a
 * missing/null `over_allowance` is "unknown", which the callers treat as read-only.
 */
export function trialEndedFilesKept(doc: OnboardingDocument): boolean {
  const storage = doc.account?.storage;
  if (!storage || storage.overAllowance !== false) return false;
  return (doc.account?.lifecycle?.dataDeletionAt ?? null) === null;
}

/** The one sentence for the kept shape, shared by the summary and the Files banner. */
export function trialEndedKeptSentence(allowanceBytes: number | null | undefined): string {
  return allowanceBytes != null
    ? `Your files are kept. They are within your ${formatSize(allowanceBytes)} allowance, so nothing will be deleted.`
    : 'Your files are kept. They are within your allowance, so nothing will be deleted.';
}

export function summarizeAccount(doc: OnboardingDocument, timeZone?: string): AccountSummary {
  const account = doc.account;
  if (!account) throw new Error('summarizeAccount: not an account document');

  const state = account.state;
  const trial = account.trial;
  const life = account.lifecycle;
  const usage = usageOf(doc);
  const lines: string[] = [];
  let headline: string;
  let tone: Tone = 'neutral';

  const trialEnd = formatDay(trial?.endsAt, timeZone);
  const deletion = formatDay(life?.dataDeletionAt, timeZone);

  switch (state) {
    case 'allowance': {
      const gb = usage?.allowanceBytes ?? usage?.quotaBytes ?? null;
      headline = gb !== null ? `You have ${formatSize(gb)} to start with` : 'You have a starting allowance';
      lines.push('Your files are encrypted on this device before they leave it.');
      break;
    }
    case 'trialing_no_card':
      headline = trialEnd ? `Trial: ${trial?.capBytes != null ? `${formatSize(trial.capBytes)} until ${trialEnd}` : `until ${trialEnd}`}` : 'Your trial is running';
      if (trial?.kind === 'no_card') lines.push('No card is on file, so nothing will be charged.');
      {
        // Server copy, but never a call to action (see `noPurchaseCopy`).
        const overNote = noPurchaseCopy(doc.copy.trial_end_over_allowance);
        if (overNote) lines.push(overNote);
        else if (usage?.overAllowance && trialEnd && usage.allowanceBytes !== null) {
          lines.push(`Your trial ends on ${trialEnd}. After that, files above ${formatSize(usage.allowanceBytes)} are read-only.`);
        }
      }
      if (usage?.overAllowance) tone = 'attention';
      break;
    case 'trial_ended': {
      headline = 'Your trial has ended';
      // Task 1820. Two shapes (server 1755, spec 4b.4): a DEADLINE (usage over the
      // allowance, files above it deleted on `data_deletion_at`) or files KEPT
      // (usage within the allowance, nothing pending, nothing deleted).
      const allowance = usage?.allowanceBytes != null ? formatSize(usage.allowanceBytes) : null;
      const above = allowance ? `Files above ${allowance}` : 'Files above your allowance';
      if (trialEndedFilesKept(doc)) {
        tone = 'neutral';
        lines.push(trialEndedKeptSentence(usage?.allowanceBytes));
        break;
      }
      tone = 'restricted';
      lines.push(
        noPurchaseCopy(doc.copy.trial_ended_over_allowance) ??
          (deletion
            ? `${above} are read-only and will be deleted on ${deletion} unless you free up space.`
            : `${above} are read-only.`),
      );
      break;
    }
    case 'needs_plan':
      headline = account.emailVerified ? 'Uploads are paused on this account' : 'Verify your email to continue';
      tone = 'restricted';
      break;
    case 'trialing':
      headline = trialEnd ? `Your trial runs until ${trialEnd}` : 'Your trial is running';
      {
        const charge = formatDay(trial?.firstChargeAt, timeZone);
        if (charge) lines.push(`The first payment is on ${charge}.`);
      }
      break;
    case 'trial_cancelling':
      headline = 'Your trial is cancelled';
      tone = 'attention';
      lines.push(trialEnd ? `You can still download until ${trialEnd}.` : 'You can still download your files.');
      break;
    case 'active':
      headline = 'Your plan is active';
      break;
    case 'past_due':
      headline = 'A payment did not go through';
      tone = 'attention';
      break;
    case 'read_only':
      headline = 'Your account is read-only';
      tone = 'restricted';
      break;
    case 'frozen':
      headline = 'Your account is frozen';
      tone = 'restricted';
      break;
    case 'lapsed':
      headline = 'Your plan has ended';
      tone = 'restricted';
      lines.push(deletion ? `Files are deleted on ${deletion}.` : 'Your files are read-only.');
      break;
    case 'legacy_free':
      headline = 'You are on the free plan';
      break;
    default:
      // Rule 4: unknown state is only a label; the rows below carry the truth.
      headline = 'Your account';
      break;
  }

  const rows = (['download', 'upload', 'share', 'delete'] as const)
    .filter((n) => n !== 'delete' || account.capabilities.delete !== undefined)
    .map((n) => capabilityRow(n, account.capabilities[n]));

  const note = noPurchaseCopy(doc.purchase?.copy.plans_managed_on_web ?? doc.copy.plans_managed_on_web);

  return { state, headline, lines, tone, usage, rows, plansManagedNote: note };
}
