/**
 * Honest, human sentences for the signup flow (task 1746, task 1709). One place,
 * pure, so every failure path is tested and none can leak a raw error, a status
 * code or native text onto a screen. Voice: honest over reassuring, no emojis.
 */

import type { ActionError } from './ports';

/** "about 45 seconds" / "about 3 minutes" / "about 1 hour", rounded UP. */
export function retryText(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return 'in a few minutes';
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `in about ${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `in about ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.ceil(m / 60);
  return `in about ${h} hour${h === 1 ? '' : 's'}`;
}

const OFFLINE = 'Could not reach the server. Check your connection and try again.';

/** Core ceremony failure code -> sentence. */
export function ceremonyMessage(code: string): string {
  switch (code) {
    case 'password_mismatch':
      return 'The two passwords do not match.';
    case 'password_too_short':
      return 'That password is too short.';
    case 'password_breached':
      return 'This password appears in known data breaches. Choose a different one.';
    case 'breach_check_blocked':
      return 'We could not check this password against known breaches, and we do not let you continue without that check. Try again.';
    case 'phrase_word_mismatch':
      return 'Those words do not match your recovery phrase. Check them against what you wrote down.';
    case 'breach_prefix_mismatch':
    case 'breach_check_stale':
    case 'breach_check_missing':
      return 'We could not check this password against known breaches. Try again.';
    case 'phrase_answer_count':
      return 'Fill in every word.';
    case 'unavailable':
      return 'Encryption is not available on this device. Update or reinstall the app and try again.';
    default:
      return 'Something went wrong on this device. Try again.';
  }
}

/** `email-start` failure. The success path never says whether the address is new (spec 5.9). */
export function emailStartMessage(err: ActionError): string {
  switch (err.code) {
    case 'rate_limited':
      return `Too many requests for this address. Try again ${retryText(err.retryAfterSeconds)}.`;
    case 'network':
      return OFFLINE;
    case 'pilot_key_required':
      return 'Sign-up currently needs a pilot access key.';
    case 'disposable_email':
      return 'That email domain cannot be used for new accounts. Use another address.';
    case 'signup_web_only':
      return 'Sign-up is not open in the app right now.';
    default:
      return 'We could not send the email. Check your connection and try again.';
  }
}

/** `email-verify` failure. The server gives ONE undifferentiated answer for wrong, expired and spent codes. */
export function verifyCodeMessage(err: ActionError): string {
  if (err.code === 'rate_limited') return `Too many tries. Wait ${retryText(err.retryAfterSeconds).replace(/^in /, '')} before trying again.`;
  if (err.code === 'network') return OFFLINE;
  return 'That code is not right, or it has expired.';
}

/** `create_account` failure before the account exists. */
export function createAccountMessage(rateLimited: boolean, code: string): string {
  if (rateLimited) return 'Too many sign-ups from this network. Try again later.';
  if (code === 'network') return `${OFFLINE} Nothing was stored.`;
  if (code === 'terms_version_stale') return 'The Terms changed while you were signing up. Go back and read the current version.';
  return 'We could not create your account. Nothing was stored. You can try again.';
}

export const TICKET_EXPIRED_NOTICE =
  'Your email code expired before the account was created. Request a new one. Your password and recovery phrase are kept.';

export const ACCOUNT_EXISTS_MESSAGE =
  'An account with this address already exists. Sign in instead. Nothing was changed.';

/**
 * register-finish was sent and no server verdict came back (or the session could not
 * be stored): the account may exist. Never "Nothing was stored", never "try again".
 */
export const UNKNOWN_OUTCOME_MESSAGE =
  'We could not confirm whether your account was created. Check by signing in; if the account exists, use your recovery phrase.';

/** The account exists but this device's vault did not adopt the key: name the phrase they just wrote down. */
export const VAULT_NOT_ADOPTED_MESSAGE =
  'Your account was created, but this device could not unlock your vault. Next, enter the recovery phrase you just wrote down.';
