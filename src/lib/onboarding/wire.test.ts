// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { ONBOARDING_ERROR_CODES, ONBOARDING_SCHEMA_HEADER, isOnboardingErrorCode, sameOriginPath } from './wire';

describe('wire constants', () => {
  test('the schema header names the highest major this build understands', () => {
    expect(ONBOARDING_SCHEMA_HEADER).toBe('1');
  });
  test('the signup machine codes that request() must keep are explicit', () => {
    for (const c of ['signup_ticket_invalid', 'account_exists', 'terms_version_stale', 'pilot_key_required', 'recovery_binding_required']) {
      expect(isOnboardingErrorCode(c), c).toBe(true);
    }
    expect(ONBOARDING_ERROR_CODES.length).toBe(11);
  });
  test('other server codes are NOT swept in (request() behaviour for everything else is unchanged)', () => {
    for (const c of ['quota_exceeded', 'object_budget_exceeded', 'forbidden', '', null, undefined, 4]) {
      expect(isOnboardingErrorCode(c), String(c)).toBe(false);
    }
  });
  test('sameOriginPath is the contract rule-8 check', () => {
    expect(sameOriginPath('/api/v1/auth/pwned-range/{prefix}')).toBe('/api/v1/auth/pwned-range/{prefix}');
    expect(sameOriginPath('https://evil.example/api/v1/x')).toBeNull();
  });
});
