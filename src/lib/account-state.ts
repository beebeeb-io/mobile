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
}

export type AccountGate =
  | { kind: 'ok' }
  | { kind: 'needs_plan' }
  | { kind: 'lapsed'; dataDeletionAt: string | null };

export function normalizeAccountState(raw: string | null | undefined): AccountState {
  if (raw === 'needs_plan' || raw === 'lapsed') return raw;
  return 'ok';
}

export function accountGateFor(sub: AccountStateFields | null | undefined): AccountGate {
  const state = normalizeAccountState(sub?.account_state);
  if (state === 'needs_plan') return { kind: 'needs_plan' };
  if (state === 'lapsed') return { kind: 'lapsed', dataDeletionAt: sub?.data_deletion_at ?? null };
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

export const READ_ONLY_TITLE = 'Your vault is read-only';

/**
 * Shown instead of a generic upload error (and as the backup "blocked"
 * reason) while uploads are refused. Null when uploads are allowed.
 */
export function readOnlyUploadMessage(gate: AccountGate): string | null {
  if (gate.kind === 'lapsed') {
    return 'Your trial has ended, so your vault is read-only: uploads and backup are off. You can still browse and download your files.';
  }
  if (gate.kind === 'needs_plan') {
    return 'Choose your plan on the web at beebeeb.io to start uploading.';
  }
  return null;
}

/**
 * Server refusal codes (task 1037 contract). For an account without a plan,
 * upload init (`/uploads/init`, `/files/upload/init`, legacy `/files/upload`)
 * and share creation answer `409 {"error":"plan_required"|"account_lapsed"}`.
 */
export const PLAN_REQUIRED_ERROR = 'plan_required';
export const ACCOUNT_LAPSED_ERROR = 'account_lapsed';

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
  if (code === 'quota_exceeded' && current.kind !== 'ok') return current;
  return null;
}

/** Upload errors after which the app should re-read the account state. */
export function isAccountRefusalCode(code: string | null | undefined): boolean {
  return code === PLAN_REQUIRED_ERROR || code === ACCOUNT_LAPSED_ERROR || code === 'quota_exceeded';
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
