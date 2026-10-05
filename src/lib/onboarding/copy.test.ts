// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { ActionError } from './ports';
import {
  ACCOUNT_EXISTS_MESSAGE, TICKET_EXPIRED_NOTICE, ceremonyMessage, createAccountMessage, emailStartMessage, retryText, verifyCodeMessage,
} from './copy';

const err = (code, retry = null) => new ActionError(code, 'RAW SERVER TEXT 500 {"error":"x"}', retry);

describe('retryText', () => {
  test('rounds up to seconds, minutes, hours', () => {
    expect(retryText(1)).toBe('in about 1 second');
    expect(retryText(59.2)).toBe('in about 1 minute');
    expect(retryText(45)).toBe('in about 45 seconds');
    expect(retryText(60)).toBe('in about 1 minute');
    expect(retryText(61)).toBe('in about 2 minutes');
    expect(retryText(3600)).toBe('in about 1 hour');
    expect(retryText(7300)).toBe('in about 3 hours');
  });
  test('unknown or non-positive is a generic wait', () => {
    expect(retryText(null)).toBe('in a few minutes');
    expect(retryText(0)).toBe('in a few minutes');
  });
});

describe('no raw server text, status code or JSON ever reaches a screen', () => {
  test('every code for every surface produces a clean sentence', () => {
    const codes = ['rate_limited', 'network', 'pilot_key_required', 'disposable_email', 'signup_web_only', 'wrong_code', 'weird', 'signup_ticket_invalid'];
    for (const c of codes) {
      for (const text of [emailStartMessage(err(c, 90)), verifyCodeMessage(err(c, 90)), createAccountMessage(c === 'rate_limited', c)]) {
        expect(text, c).not.toMatch(/RAW SERVER|\{|"error"|\b500\b|ApiError|ERR_/);
        expect(text.endsWith('.'), `${c}: ${text}`).toBe(true);
      }
    }
    for (const c of ['password_mismatch', 'password_too_short', 'password_breached', 'breach_check_blocked', 'phrase_word_mismatch', 'breach_prefix_mismatch', 'breach_check_stale', 'breach_check_missing', 'phrase_answer_count', 'unavailable', 'crypto', 'step_not_done', 'zzz']) {
      const t = ceremonyMessage(c);
      expect(t, c).not.toMatch(/ERR_|\{|_/);
      expect(t.endsWith('.')).toBe(true);
    }
  });
  test('rate limits quote the server\'s wait', () => {
    expect(emailStartMessage(err('rate_limited', 120))).toBe('Too many requests for this address. Try again in about 2 minutes.');
    expect(verifyCodeMessage(err('rate_limited', 120))).toBe('Too many tries. Wait about 2 minutes before trying again.');
  });
  test('a wrong, expired or spent code is one undifferentiated sentence', () => {
    expect(verifyCodeMessage(err('wrong_code'))).toBe('That code is not right, or it has expired.');
    expect(verifyCodeMessage(err('whatever'))).toBe('That code is not right, or it has expired.');
  });
  test('the email-start success path is never described, only failures (anti-enumeration)', () => {
    for (const c of ['rate_limited', 'network', 'pilot_key_required', 'disposable_email', 'signup_web_only', 'x']) {
      expect(emailStartMessage(err(c))).not.toMatch(/already|exists|registered|new address|no account/i);
    }
  });
  test('fixed notices', () => {
    expect(TICKET_EXPIRED_NOTICE).toContain('password and recovery phrase are kept');
    expect(ACCOUNT_EXISTS_MESSAGE).toContain('Sign in instead');
  });
});

describe('post-commit copy (1753 pass 2, findings 4 and 5)', () => {
  const { UNKNOWN_OUTCOME_MESSAGE, VAULT_NOT_ADOPTED_MESSAGE } = require('./copy');
  test('an unknown outcome tells the person to check by signing in and never claims nothing was stored', () => {
    expect(UNKNOWN_OUTCOME_MESSAGE).toContain('Check by signing in');
    expect(UNKNOWN_OUTCOME_MESSAGE).toContain('recovery phrase');
    expect(UNKNOWN_OUTCOME_MESSAGE).not.toMatch(/nothing was stored|try again/i);
  });
  test('a vault that did not adopt the key names the recovery phrase just written down, in one sentence-pair', () => {
    expect(VAULT_NOT_ADOPTED_MESSAGE).toContain('recovery phrase you just wrote down');
    expect(VAULT_NOT_ADOPTED_MESSAGE).not.toMatch(/nothing was stored/i);
  });
});
