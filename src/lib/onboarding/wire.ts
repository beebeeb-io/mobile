/**
 * Wire-level constants and checks for the onboarding calls (task 1746). Pure, so
 * `api.ts` can import it and tests can exercise it without native mocks.
 */

import { SUPPORTED_SCHEMA } from './types';
import { sameOriginApiPath } from './parse';

/** Value of `X-Beebeeb-Onboarding-Schema`: the highest contract major this build understands. */
export const ONBOARDING_SCHEMA_HEADER = String(SUPPORTED_SCHEMA);

/**
 * Machine codes of the signup path that must survive into `ApiError.code`.
 * `request()` drops `error` when the server also sends a human `message` (the
 * 1551 lesson: "the machine-readable string never reaches the thrown ApiError"),
 * so these are kept explicitly. Additive: nothing else changes.
 */
export const ONBOARDING_ERROR_CODES: readonly string[] = [
  'signup_ticket_invalid',
  'account_exists',
  'terms_version_stale',
  'terms_version_invalid',
  'terms_version_required',
  'recovery_binding_required',
  'pilot_key_required',
  'signup_web_only',
  'legacy_signup_retired',
  'disposable_email',
  'email_unverified',
];

export function isOnboardingErrorCode(code: unknown): code is string {
  return typeof code === 'string' && ONBOARDING_ERROR_CODES.includes(code);
}

/** A same-origin `/api/v1/...` path template, or null (contract README rule 8). */
export function sameOriginPath(v: unknown): string | null {
  return sameOriginApiPath(v);
}
