// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { ActionError, toActionError } from './ports';

describe('toActionError', () => {
  test('status 0 is network, 429 is rate_limited with the retry hint', () => {
    expect(toActionError({ status: 0, message: 'Could not reach the server.' }, 'x').code).toBe('network');
    const r = toActionError({ status: 429, message: 'slow down', retryAfterSeconds: 90 }, 'x');
    expect(r.code).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(90);
  });
  test('a server machine code survives', () => {
    expect(toActionError({ status: 403, code: 'signup_ticket_invalid', message: 'Verify your email again' }, 'x').code).toBe('signup_ticket_invalid');
    expect(toActionError({ status: 409, code: 'account_exists', message: 'm' }, 'x').code).toBe('account_exists');
  });
  test('otherwise the fallback code', () => {
    expect(toActionError({ status: 400, message: 'invalid or expired code' }, 'wrong_code').code).toBe('wrong_code');
    expect(toActionError(new Error('x'), 'fb').code).toBe('fb');
    expect(toActionError(null, 'fb').code).toBe('fb');
  });
  test('an ActionError passes through unchanged', () => {
    const e = new ActionError('mine', 'm');
    expect(toActionError(e, 'other')).toBe(e);
  });
});
