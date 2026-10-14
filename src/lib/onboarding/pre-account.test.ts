// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { loadFixture } from './fixtures';
import { parseOnboardingDocument } from './parse';
import { canSignUpNatively } from './pre-account';

const doc = (name, mutate) => {
  const raw = JSON.parse(JSON.stringify(loadFixture(name)));
  if (mutate) mutate(raw);
  return { status: 'document', doc: parseOnboardingDocument(raw).doc };
};

describe('canSignUpNatively', () => {
  // Signup is web-only (tasks 1834/1836): the iOS fixture is web_only, so a native
  // document is the iOS fixture with its signup block set to what the web gets.
  const native = (r) => { r.signup.allowed = true; r.signup.mode = 'native'; r.signup.reason = null; };
  test('only a pre_account document with signup allowed AND native', () => {
    expect(canSignUpNatively(doc('pre_account.ios', native))).toBe(true);
    expect(canSignUpNatively(doc('pre_account.web'))).toBe(true);
  });
  test('the iOS fixture itself (web_only, not allowed) -> no', () => {
    expect(canSignUpNatively(doc('pre_account.ios'))).toBe(false);
  });
  test('web_only, not allowed, handoff, or an update_required client -> no', () => {
    expect(canSignUpNatively(doc('pre_account.ios', (r) => { native(r); r.signup.mode = 'web_only'; }))).toBe(false);
    expect(canSignUpNatively(doc('pre_account.ios', (r) => { native(r); r.signup.allowed = false; }))).toBe(false);
    expect(canSignUpNatively(doc('pre_account.ios', (r) => { native(r); r.signup.mode = 'web_handoff'; }))).toBe(false);
    expect(canSignUpNatively(doc('client.update_required.ios'))).toBe(false);
  });
  test('an account document, loading, unsupported schema and every legacy failure -> no (the old text line stays)', () => {
    expect(canSignUpNatively(doc('account.allowance.ios'))).toBe(false);
    expect(canSignUpNatively({ status: 'loading' })).toBe(false);
    expect(canSignUpNatively({ status: 'unsupported_schema' })).toBe(false);
    expect(canSignUpNatively({ status: 'legacy', reason: 'not_found' })).toBe(false);
  });
});
