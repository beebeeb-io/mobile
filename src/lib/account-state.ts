/**
 * Account state (task 1037): whether this account may use the app.
 *
 * `GET /api/v1/billing/subscription` now carries `account_state`:
 *  - `ok`: normal. This covers every entitled account and grandfathered Free.
 *  - `needs_plan`: an account created on the web that never started a trial
 *    or plan. Upload quota is 0. The app blocks the file UI behind a full
 *    screen (App.tsx `NeedsPlanScreen`).
 *  - `lapsed`: a trial or plan that ended unpaid. The vault is read-only
 *    (quota 0): browse, download and export still work. The data is deleted
 *    at `data_deletion_at`.
 *
 * A missing or unknown value is `ok`. An older server mid-rollout must never
 * lock anyone out, and the server enforces the quota regardless.
 *
 * No copy here names a price or a purchase action (task 1400, App Review
 * 3.1.1(a): there is no In-App Purchase product and no billing link-out).
 */
import { formatBillingDate } from './billing-status';

export type AccountState = 'ok' | 'needs_plan' | 'lapsed';

export interface AccountStateFields {
  account_state?: string | null;
  data_deletion_at?: string | null;
  /**
   * Task 1605 (server PR #129). Set the instant a never-paid MANDATED trial
   * is cancelled — uploads/shares are refused from this moment even though
   * `account_state` stays `ok` (the trial hasn't lapsed, it's cancelled
   * early) and `status` stays `cancelling`. Null for every other state.
   */
  uploads_blocked_at?: string | null;
  /** Task 1605. The date view/download stop working for that same cancelled trial. */
  access_until?: string | null;
}

export type AccountGate =
  | { kind: 'ok' }
  | { kind: 'needs_plan' }
  | { kind: 'lapsed'; dataDeletionAt: string | null }
  | { kind: 'trial_cancelled_read_only'; accessUntil: string | null; dataDeletionAt: string | null }
  /**
   * Task 1746 (onboarding document, spec 4b.7): a no-card trial ended and usage is
   * above the allowance. Read-only above the allowance; download, export, delete
   * and empty-trash stay. `bannerText` is the server's sentence (one that passed
   * `noPurchaseCopy`), or null to use the client wording.
   */
  | { kind: 'trial_ended'; dataDeletionAt: string | null; bannerText: string | null };

export function normalizeAccountState(raw: string | null | undefined): AccountState {
  if (raw === 'needs_plan' || raw === 'lapsed') return raw;
  return 'ok';
}

export function accountGateFor(sub: AccountStateFields | null | undefined): AccountGate {
  const state = normalizeAccountState(sub?.account_state);
  if (state === 'needs_plan') return { kind: 'needs_plan' };
  if (state === 'lapsed') return { kind: 'lapsed', dataDeletionAt: sub?.data_deletion_at ?? null };
  // Task 1605 — account_state stays 'ok' for this case (see the field doc
  // above); uploads_blocked_at is the server's own, deliberate signal for it.
  if (sub?.uploads_blocked_at) {
    return {
      kind: 'trial_cancelled_read_only',
      accessUntil: sub?.access_until ?? null,
      dataDeletionAt: sub?.data_deletion_at ?? null,
    };
  }
  return { kind: 'ok' };
}

/** Uploads, new files and camera/contacts/calendar backup are refused by the server (quota 0). */
export function uploadsBlocked(gate: AccountGate): boolean {
  return gate.kind !== 'ok';
}

function validDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

export function formatDeletionDate(iso: string | null | undefined): string | null {
  const valid = validDate(iso);
  return valid ? formatBillingDate(valid) : null;
}

/** The persistent banner shown in Files for a lapsed account. */
export function lapsedBannerText(dataDeletionAt: string | null | undefined): string {
  const date = formatDeletionDate(dataDeletionAt);
  return date
    ? `Your trial has ended. Your vault is read-only and will be deleted on ${date}.`
    : 'Your trial has ended. Your vault is read-only.';
}

/**
 * Task 1746: the persistent Files banner for a `trial_ended` gate (spec 4b.7). The
 * server's sentence when it passed `noPurchaseCopy`, else client wording from the
 * deletion date. Facts only: the "Plans are managed..." sentence of the spec lives
 * on Storage & Plan, not here (DEVIATIONS.md, task 1746).
 */
export function trialEndedBannerText(gate: { dataDeletionAt: string | null; bannerText: string | null }): string {
  if (gate.bannerText) return gate.bannerText;
  const date = formatDeletionDate(gate.dataDeletionAt);
  return date
    ? `Your trial ended. Files above your allowance are read-only and will be deleted on ${date} unless you free up space.`
    : 'Your trial ended. Files above your allowance are read-only.';
}

export const READ_ONLY_TITLE = 'Your vault is read-only';

/**
 * Shown instead of a generic upload error (and as the backup "blocked"
 * reason) while uploads are refused. Null when uploads are allowed.
 */
export function readOnlyUploadMessage(gate: AccountGate): string | null {
  if (gate.kind === 'trial_ended') {
    return 'Your trial has ended, so files above your allowance are read-only: uploads and backup are off. You can still browse, download and delete your files.';
  }
  if (gate.kind === 'lapsed') {
    return 'Your trial has ended, so your vault is read-only: uploads and backup are off. You can still browse and download your files.';
  }
  if (gate.kind === 'needs_plan') {
    return 'Choose your plan on the web at beebeeb.io to start uploading.';
  }
  // Task 1605 — a never-paid trial cancelled before its first charge:
  // uploads/backup/new shares are off immediately, distinct from `lapsed`
  // (the trial hasn't ended — it's cancelled early, and resuming it, or
  // paying, restores uploads right away).
  if (gate.kind === 'trial_cancelled_read_only') {
    return 'You cancelled your trial before its first payment, so uploads and backup are off. Resume your trial on the web to upload again.';
  }
  return null;
}

/** Task 1605 — the Storage & Plan compact status line for this gate: "Uploads stopped · Access until <date> · Files deleted on <date>" — never "Renews". Null for any other gate. */
export function trialCancelledReadOnlyStatusLine(
  gate: AccountGate,
  formatDate: (iso: string) => string,
): string | null {
  if (gate.kind !== 'trial_cancelled_read_only') return null;
  const parts = ['Uploads stopped'];
  if (gate.accessUntil) parts.push(`Access until ${formatDate(gate.accessUntil)}`);
  if (gate.dataDeletionAt) parts.push(`Files deleted on ${formatDate(gate.dataDeletionAt)}`);
  return parts.join(' · ');
}

/**
 * Server refusal codes (task 1037 contract). For an account without a plan,
 * upload init (`/uploads/init`, `/files/upload/init`, legacy `/files/upload`)
 * and share creation answer `409 {"error":"plan_required"|"account_lapsed"}`.
 */
export const PLAN_REQUIRED_ERROR = 'plan_required';
export const ACCOUNT_LAPSED_ERROR = 'account_lapsed';
/** Task 1605 (server PR #129) — a never-paid trial cancelled before its first charge. */
export const TRIAL_CANCELLED_READ_ONLY_ERROR = 'trial_cancelled_read_only';
/** Task 1746 (spec 5.6): upload/share refused because a no-card trial ended over the allowance. */
export const TRIAL_ENDED_ERROR = 'trial_ended';

/**
 * The gate an error code proves, or null when the code is not an account
 * refusal. `quota_exceeded` only counts once the account is already known to
 * be blocked: for an `ok` account it really is "storage full".
 */
export function gateForRefusalCode(code: string | null | undefined, current: AccountGate): AccountGate | null {
  if (code === PLAN_REQUIRED_ERROR) return { kind: 'needs_plan' };
  if (code === ACCOUNT_LAPSED_ERROR) {
    return { kind: 'lapsed', dataDeletionAt: current.kind === 'lapsed' ? current.dataDeletionAt : null };
  }
  if (code === TRIAL_CANCELLED_READ_ONLY_ERROR) {
    return {
      kind: 'trial_cancelled_read_only',
      accessUntil: current.kind === 'trial_cancelled_read_only' ? current.accessUntil : null,
      dataDeletionAt: current.kind === 'trial_cancelled_read_only' ? current.dataDeletionAt : null,
    };
  }
  if (code === TRIAL_ENDED_ERROR) {
    return {
      kind: 'trial_ended',
      dataDeletionAt: current.kind === 'trial_ended' ? current.dataDeletionAt : null,
      bannerText: current.kind === 'trial_ended' ? current.bannerText : null,
    };
  }
  if (code === 'quota_exceeded' && current.kind !== 'ok') return current;
  return null;
}

/** Upload errors after which the app should re-read the account state. */
export function isAccountRefusalCode(code: string | null | undefined): boolean {
  return (
    code === PLAN_REQUIRED_ERROR ||
    code === ACCOUNT_LAPSED_ERROR ||
    code === TRIAL_CANCELLED_READ_ONLY_ERROR ||
    code === TRIAL_ENDED_ERROR ||
    code === 'quota_exceeded'
  );
}

// ---------------------------------------------------------------------------
// Process-wide mirror of the signed-in account's gate.
//
// `AccountStateProvider` (account-state-context.tsx) owns the value. The copy
// here lets non-React code (`friendlyError` in api.ts) turn a `quota_exceeded`
// upload error into the read-only message instead of "Storage full", and lets
// an upload failure ask the provider to re-check the account.
// ---------------------------------------------------------------------------

let currentGate: AccountGate = { kind: 'ok' };
let refreshRequester: (() => void) | null = null;

export function getCurrentAccountGate(): AccountGate {
  return currentGate;
}

export function setCurrentAccountGate(gate: AccountGate): void {
  currentGate = gate;
}

/** Registered by the provider; returns an unregister function. */
export function registerAccountStateRefresher(fn: () => void): () => void {
  refreshRequester = fn;
  return () => {
    if (refreshRequester === fn) refreshRequester = null;
  };
}

/**
 * Ask the provider to re-read `/billing/subscription`, for example after an
 * upload was refused for quota. That is how a trial that lapsed while the app
 * was open gets noticed. A no-op when no provider is mounted.
 */
export function requestAccountStateRefresh(): void {
  refreshRequester?.();
}
