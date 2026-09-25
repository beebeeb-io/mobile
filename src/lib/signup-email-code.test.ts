// @ts-nocheck
/**
 * Task 1551 — pure logic for the mobile signup email-code step.
 *
 * No native-module mocking needed: `./signup-email-code` imports nothing
 * (see its own header comment for why `isLegacyFallbackError` /
 * `isTicketInvalidError` are duck-typed instead of `instanceof ApiError`).
 */
import { describe, expect, test } from 'bun:test';
import {
  EMAIL_CODE_LENGTH,
  sanitizeCode,
  isLegacyFallbackError,
  isTicketInvalidError,
  initialSignupFlowState,
  signupFlowReducer,
  withSignupTicket,
} from './signup-email-code';

describe('EMAIL_CODE_LENGTH', () => {
  test('is 8 — the server widened 6→8 digits (task 1525 deviation note)', () => {
    expect(EMAIL_CODE_LENGTH).toBe(8);
  });
});

describe('sanitizeCode', () => {
  test('strips non-digit characters', () => {
    expect(sanitizeCode('12-34 56.78')).toBe('12345678');
  });

  test('strips text copied along with the code from the email', () => {
    expect(sanitizeCode('Your code: 12345678')).toBe('12345678');
  });

  test('clips to EMAIL_CODE_LENGTH by default', () => {
    expect(sanitizeCode('123456789999')).toBe('12345678');
  });

  test('respects a custom maxLength', () => {
    expect(sanitizeCode('123456789999', 4)).toBe('1234');
  });

  test('empty / all-non-digit input sanitizes to an empty string', () => {
    expect(sanitizeCode('')).toBe('');
    expect(sanitizeCode('abc-def')).toBe('');
  });
});

describe('isLegacyFallbackError', () => {
  test('true for a 404 ApiError-shaped object', () => {
    expect(isLegacyFallbackError({ status: 404, message: 'not found' })).toBe(true);
  });

  test('false for 400/429/network errors — those are real refusals, not a legacy server', () => {
    expect(isLegacyFallbackError({ status: 400, message: 'bad request' })).toBe(false);
    expect(isLegacyFallbackError({ status: 429, message: 'rate limited' })).toBe(false);
    expect(isLegacyFallbackError({ status: 0, message: 'network' })).toBe(false);
  });

  test('false for a plain Error with no status field', () => {
    expect(isLegacyFallbackError(new Error('boom'))).toBe(false);
  });

  test('false for null/undefined/non-object input', () => {
    expect(isLegacyFallbackError(null)).toBe(false);
    expect(isLegacyFallbackError(undefined)).toBe(false);
    expect(isLegacyFallbackError('404')).toBe(false);
  });
});

describe('isTicketInvalidError', () => {
  // Verified against a live server (task 1551 local smoke test, server #95
  // head 3c5f706): the real 403 body is
  // `{"error":"signup_ticket_invalid","message":"Verify your email again to
  // get a new signup link."}` — mobile's generic `request()` picks
  // `err.message` (the human text) over `err.error` whenever both are
  // present, and has no `.code` field at all, so the literal string
  // "signup_ticket_invalid" never reaches the thrown ApiError. This function
  // checks status alone for that reason — see its own doc comment.
  test('true for a 403 carrying the real server\'s human-readable message (not the literal code string)', () => {
    expect(
      isTicketInvalidError({ status: 403, message: 'Verify your email again to get a new signup link.' }),
    ).toBe(true);
  });

  test('true for a 403 regardless of message content', () => {
    expect(isTicketInvalidError({ status: 403, message: 'anything at all' })).toBe(true);
    expect(isTicketInvalidError({ status: 403, message: '' })).toBe(true);
    expect(isTicketInvalidError({ status: 403 })).toBe(true);
  });

  test('false for a 401/404 — only 403 is the ticket-rejection status', () => {
    expect(isTicketInvalidError({ status: 401, message: 'signup_ticket_invalid' })).toBe(false);
    expect(isTicketInvalidError({ status: 404, message: 'signup_ticket_invalid' })).toBe(false);
  });

  test('false for null/non-object input', () => {
    expect(isTicketInvalidError(null)).toBe(false);
    expect(isTicketInvalidError('signup_ticket_invalid')).toBe(false);
  });
});

describe('signupFlowReducer — step machine', () => {
  test('initial state starts at the email step with no ticket', () => {
    expect(initialSignupFlowState.step).toBe('email');
    expect(initialSignupFlowState.ticket).toBeUndefined();
    expect(initialSignupFlowState.legacyFlow).toBe(false);
  });

  test('EMAIL_START_SUCCESS moves email -> code, records the email, clears legacyFlow/ticket', () => {
    const next = signupFlowReducer(initialSignupFlowState, {
      type: 'EMAIL_START_SUCCESS',
      email: 'guus@beebeeb.io',
    });
    expect(next.step).toBe('code');
    expect(next.email).toBe('guus@beebeeb.io');
    expect(next.legacyFlow).toBe(false);
    expect(next.ticket).toBeUndefined();
  });

  test('EMAIL_START_LEGACY_FALLBACK (404) moves email -> password directly, legacyFlow true, no ticket', () => {
    const next = signupFlowReducer(initialSignupFlowState, {
      type: 'EMAIL_START_LEGACY_FALLBACK',
      email: 'guus@beebeeb.io',
    });
    expect(next.step).toBe('password');
    expect(next.legacyFlow).toBe(true);
    expect(next.ticket).toBeUndefined();
  });

  test('CODE_VERIFIED moves code -> password and carries the ticket', () => {
    const codeState = signupFlowReducer(initialSignupFlowState, {
      type: 'EMAIL_START_SUCCESS',
      email: 'guus@beebeeb.io',
    });
    const next = signupFlowReducer(codeState, { type: 'CODE_VERIFIED', ticket: 'tkt_abc123' });
    expect(next.step).toBe('password');
    expect(next.ticket).toBe('tkt_abc123');
  });

  test('WRONG_EMAIL from the code step goes back to email and drops the ticket', () => {
    const codeState = signupFlowReducer(initialSignupFlowState, {
      type: 'EMAIL_START_SUCCESS',
      email: 'guus@beebeeb.io',
    });
    const next = signupFlowReducer(codeState, { type: 'WRONG_EMAIL' });
    expect(next.step).toBe('email');
    expect(next.ticket).toBeUndefined();
  });

  test('TICKET_REJECTED from the password step bounces back to code with the error message, ticket cleared', () => {
    const passwordState = signupFlowReducer(
      signupFlowReducer(initialSignupFlowState, { type: 'EMAIL_START_SUCCESS', email: 'x@y.com' }),
      { type: 'CODE_VERIFIED', ticket: 'tkt_expired' },
    );
    const next = signupFlowReducer(passwordState, {
      type: 'TICKET_REJECTED',
      message: 'That verification expired. Please request a new code.',
    });
    expect(next.step).toBe('code');
    expect(next.ticket).toBeUndefined();
    expect(next.codeStepError).toBe('That verification expired. Please request a new code.');
  });

  test('a fresh EMAIL_START_SUCCESS after TICKET_REJECTED clears codeStepError again', () => {
    const rejected = signupFlowReducer(initialSignupFlowState, {
      type: 'TICKET_REJECTED',
      message: 'expired',
    });
    expect(rejected.codeStepError).toBe('expired');
    const next = signupFlowReducer(rejected, { type: 'EMAIL_START_SUCCESS', email: 'x@y.com' });
    expect(next.codeStepError).toBeUndefined();
  });
});

describe('withSignupTicket', () => {
  test('adds signup_ticket when a ticket is present', () => {
    expect(withSignupTicket({ email: 'x@y.com' }, 'tkt_1')).toEqual({
      email: 'x@y.com',
      signup_ticket: 'tkt_1',
    });
  });

  test('leaves the body untouched (no signup_ticket key at all) when ticket is undefined', () => {
    const body = { email: 'x@y.com' };
    const result = withSignupTicket(body, undefined);
    expect(result).toEqual({ email: 'x@y.com' });
    expect('signup_ticket' in result).toBe(false);
  });

  test('leaves the body untouched when ticket is an empty string (falsy — harmless to omit)', () => {
    const result = withSignupTicket({ email: 'x@y.com' }, '');
    expect('signup_ticket' in result).toBe(false);
  });

  test('does not mutate the original body object', () => {
    const body = { email: 'x@y.com' };
    withSignupTicket(body, 'tkt_1');
    expect(body).toEqual({ email: 'x@y.com' });
  });
});
