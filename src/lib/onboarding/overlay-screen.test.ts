// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { loadFixture } from './fixtures';
import { overlayScreen } from './overlay-screen';
import { parseOnboardingDocument } from './parse';

const doc = (name, mutate) => {
  const raw = JSON.parse(JSON.stringify(loadFixture(name)));
  if (mutate) mutate(raw);
  return parseOnboardingDocument(raw).doc;
};

describe('overlayScreen', () => {
  test('a working vault is never covered: allowance, trial states, lapsed', () => {
    for (const name of ['account.allowance.ios', 'account.trial_ended.ios', 'account.lapsed.ios', 'account.trialing_no_card.desktop', 'account.active.web', 'account.read_only.web', 'account.frozen.desktop']) {
      expect(overlayScreen(doc(name), false), name).toBeNull();
    }
  });
  test('an unverified email is covered by the verify_email step', () => {
    const s = overlayScreen(doc('account.needs_plan.ios'), false);
    expect(s.kind).toBe('step');
    expect(s.stepId).toBe('verify_email');
  });
  test('an outstanding accept_terms is covered too', () => {
    const s = overlayScreen(doc('account.allowance.ios', (r) => {
      r.steps = [{ id: 'accept_terms', status: 'todo', required: true, ui: 'action', params: { version: '2026-09-29' } }];
      r.blocking = true;
    }), false);
    expect(s.kind).toBe('step');
    expect(s.stepId).toBe('accept_terms');
  });
  test('update_required covers everything', () => {
    expect(overlayScreen(doc('account.allowance.ios', (r) => { r.client = { status: 'update_required' }; }), false).kind).toBe('update_required');
  });
  test('a required step this build cannot do covers with its fallback; blocked covers with Check again', () => {
    const f = overlayScreen(doc('account.allowance.ios', (r) => { r.steps = [{ id: 'confirm_phone_number', status: 'todo', required: true, ui: 'action' }]; r.blocking = true; }), false);
    expect(f.kind).toBe('fallback');
    const b = overlayScreen(doc('account.allowance.ios', (r) => { r.steps = [{ id: 'verify_email', status: 'blocked', required: true, ui: 'action' }]; r.blocking = true; }), false);
    expect(b.kind).toBe('blocked');
  });
  test('an optional purchase step never covers anything', () => {
    expect(overlayScreen(doc('account.allowance.ios', (r) => { r.steps = [{ id: 'start_trial', status: 'todo', required: false, ui: 'action' }]; }), false)).toBeNull();
  });
  test('no document and no problem covers nothing; a newer schema covers with update', () => {
    expect(overlayScreen(null, false)).toBeNull();
    expect(overlayScreen(null, true).kind).toBe('unsupported_schema');
  });
});
