/**
 * The no-card trial's typed refusals (task 1820, server task 1755).
 *
 * The server answers these with a code AND a sentence, but several of the server's
 * sentences point at buying ("Choose a plan", "Subscribe to unlock", "pay at
 * checkout"). This binary has no purchase surface (App Store 3.1.x, task 1400): it
 * shows account state only. So the client maps by CODE and prints its own
 * sentence, which says what is true about the account and offers nothing.
 *
 * The codes are the whole set 1755 can produce for a client that does not sell:
 *  - 409 `trial_previously_subscribed`: a start refused, the account has paid before.
 *  - 409 `trial_already_used`: a start refused, the trial was used.
 *  - 409 `trial_sharing_unavailable` / `trial_share_limit_reached`: share creation
 *    during a no-card trial (off, or 5 active links).
 *  - 409 `no_subscription_to_cancel`: cancel on a trial that has no card.
 *  - 409 `trial_convert_unavailable`: convert on a trial that has no card.
 *  - 409 `trial_checkout_retired`: the old trial checkout, retired.
 *  - 409 `trial_temporarily_unavailable` / 429 `trial_rate_limited`: a start refused
 *    for capacity or network volume.
 *
 * This file is pure: no React, no network.
 */
import { formatSize } from './onboarding/account-summary';

const COPY: Readonly<Record<string, string>> = {
  trial_previously_subscribed:
    'This account has had a paid period before, and a trial is only for accounts that have not. Nothing on this account has changed.',
  trial_already_used: 'This account has already used its trial. Nothing on this account has changed.',
  trial_sharing_unavailable: 'Sharing is not available during a trial. Your files stay private.',
  trial_share_limit_reached: 'A trial can hold 5 active share links. Revoke one to create another.',
  no_subscription_to_cancel:
    'Your trial has no card on file, so there is nothing to cancel and nothing will be charged. It ends by itself on its end date.',
  trial_convert_unavailable: 'This trial has no card on file, so there is nothing to convert. Nothing was changed or charged.',
  trial_checkout_retired: 'This option is no longer available. Nothing was changed or charged.',
  trial_temporarily_unavailable: 'New trials are paused right now. Your account is unchanged; try again later.',
  trial_rate_limited: 'Too many trials were started from this network today. Try again later.',
};

export const TRIAL_REFUSAL_CODES: readonly string[] = Object.keys(COPY);

export function isTrialRefusalCode(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(COPY, code);
}

/** The authored, purchase-free sentence for a trial refusal code, or null when the code is not one of these. */
export function trialRefusalMessage(code: string | null | undefined): string | null {
  return isTrialRefusalCode(code) ? COPY[code] : null;
}

/** Older servers and the mandated trial: 25 GB. */
const MANDATED_TRIAL_CAP_BYTES = 25_000_000_000;

/**
 * The upload refusal for the storage cap of a never-paid trial (413 `quota_exceeded`
 * with `is_trial_cap`). The number is the cap the server enforced (`limit_bytes`): a
 * no-card trial's cap is configurable (10 GB by default), the older mandated trial's
 * is 25 GB. A missing or unusable limit keeps the old 25 GB number. No call to action, no
 * price, no plan: "until your first payment" and "manage your plan" (task 1605) hinted at one.
 */
export function trialCapMessage(limitBytes: number | null | undefined): string {
  const bytes = typeof limitBytes === 'number' && Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : MANDATED_TRIAL_CAP_BYTES;
  return `This account is on the ${formatSize(bytes)} trial storage cap. Free up space to keep uploading.`;
}
