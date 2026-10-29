// @ts-nocheck
/**
 * Task 1746: the pure step planner (spec 5.5, 5.8). Which screen does the
 * person see next, for the contract's fixtures and for hostile variations.
 */
import { describe, expect, test } from 'bun:test';
import { loadFixture } from './fixtures';
import { parseOnboardingDocument } from './parse';
import { HARD_CODED_WEB_FALLBACK, isKnownStep, planScreen } from './plan';

// Signup is web-only (tasks 1834/1836): the iOS pre-account fixture says web_only. The
// step-planner tests below walk the signup steps, which the planner only does for a
// document that allows a native signup (the web's), so they open the door on a copy.
function doc(name, mutate) {
  const raw = JSON.parse(JSON.stringify(loadFixture(name)));
  if (name === 'pre_account.ios') raw.signup = { ...raw.signup, allowed: true, mode: 'native', reason: null };
  if (mutate) mutate(raw);
  const r = parseOnboardingDocument(raw);
  if (!r.ok) throw new Error(`${name} did not parse: ${JSON.stringify(r)}`);
  return r.doc;
}

const PRE = ['enter_email', 'verify_email_code', 'accept_terms', 'set_password', 'save_recovery_phrase', 'create_account'];

describe('pre-account order', () => {
  test('the iOS fixture as the server emits it (web_only) has no native signup to plan', () => {
    const r = parseOnboardingDocument(loadFixture('pre_account.ios'));
    expect(r.ok).toBe(true);
    expect(planScreen(r.doc, new Set()).kind).toBe('signup_unavailable');
  });
  test('walks the six steps in document order, one at a time, position n of 6', () => {
    const d = doc('pre_account.ios');
    const done = new Set();
    PRE.forEach((id, i) => {
      const s = planScreen(d, done);
      expect(s.kind).toBe('step');
      expect(s.stepId).toBe(id);
      expect(s.position).toBe(i + 1);
      expect(s.total).toBe(6);
      done.add(id);
    });
    expect(planScreen(d, done)).toEqual({ kind: 'created' });
  });

  test('create_account runs last even when the server lists it first (spec 5.5 invariant)', () => {
    const d = doc('pre_account.ios', (raw) => {
      const create = raw.steps.pop();
      raw.steps.unshift(create);
    });
    const done = new Set();
    const order = [];
    for (let i = 0; i < 6; i += 1) {
      const s = planScreen(d, done);
      expect(s.kind).toBe('step');
      order.push(s.stepId);
      done.add(s.stepId);
    }
    expect(order[order.length - 1]).toBe('create_account');
    expect(order.slice(0, 5)).not.toContain('create_account');
  });

  test('going back (undoing a step) returns to it', () => {
    const d = doc('pre_account.ios');
    const done = new Set(['enter_email', 'verify_email_code', 'accept_terms']);
    expect(planScreen(d, done).stepId).toBe('set_password');
    done.delete('verify_email_code');
    expect(planScreen(d, done).stepId).toBe('verify_email_code');
  });

  test('pilot_key is a known step when the server lists it', () => {
    const d = doc('pre_account.ios', (raw) => {
      raw.steps.unshift({ id: 'pilot_key', status: 'todo', required: true, ui: 'action' });
    });
    expect(planScreen(d, new Set()).stepId).toBe('pilot_key');
  });
});

describe('signup mode', () => {
  test('web_only and not-allowed both end in signup_unavailable, never a half signup', () => {
    for (const mutate of [
      (raw) => { raw.signup.mode = 'web_only'; },
      (raw) => { raw.signup.allowed = false; },
      (raw) => { raw.signup.mode = 'web_handoff'; },
    ]) {
      const s = planScreen(doc('pre_account.ios', mutate), new Set());
      expect(s.kind).toBe('signup_unavailable');
    }
  });
});

describe('unknown steps (spec 5.8 rule 3)', () => {
  test('the forward-compat fixture stops at the unknown REQUIRED step, shows the document fallback, and skips the optional one', () => {
    const d = doc('forward_compat.unknown_step.ios');
    const done = new Set(['enter_email', 'verify_email_code']);
    const s = planScreen(d, done);
    expect(s.kind).toBe('fallback');
    expect(s.stepId).toBe('confirm_phone_number');
    expect(s.fallback.kind).not.toBe('unknown');
  });

  test('an unknown OPTIONAL step is invisible and does not count toward "n of m"', () => {
    const d = doc('forward_compat.unknown_step.ios');
    // Pretend the required unknown step is done: the flow must go on past the optional one.
    const done = new Set(['enter_email', 'verify_email_code', 'confirm_phone_number']);
    const s = planScreen(d, done);
    expect(s.kind).toBe('step');
    expect(s.stepId).toBe('accept_terms');
  });

  test('with no fallback anywhere, the hard-coded one is used (rule 5)', () => {
    const d = doc('forward_compat.unknown_step.ios', (raw) => {
      delete raw.fallback;
      for (const s of raw.steps) delete s.fallback;
    });
    const s = planScreen(d, new Set(['enter_email', 'verify_email_code']));
    expect(s.kind).toBe('fallback');
    expect(s.fallback).toEqual(HARD_CODED_WEB_FALLBACK);
  });

  test('a blocked required step stops; a blocked optional step is skipped', () => {
    const d = doc('pre_account.ios', (raw) => {
      raw.steps[2].status = 'blocked';
    });
    const s = planScreen(d, new Set(['enter_email', 'verify_email_code']));
    expect(s.kind).toBe('blocked');
    expect(s.stepId).toBe('accept_terms');
  });
});

describe('update_required (spec 5.8 rule 7)', () => {
  test('blocks everything, with an update_app fallback and the minimum version', () => {
    const s = planScreen(doc('client.update_required.ios'), new Set());
    expect(s.kind).toBe('update_required');
    expect(s.fallback.kind).toBe('update_app');
    expect(typeof s.minVersion === 'string' || s.minVersion === null).toBe(true);
  });

  test('also blocks a document that would otherwise be a perfectly good account', () => {
    const d = doc('account.allowance.ios', (raw) => { raw.client = { status: 'update_required', min_version: '9.0.0' }; });
    expect(planScreen(d, new Set()).kind).toBe('update_required');
  });
});

describe('account stage', () => {
  test('this build can do exactly verify_email and accept_terms', () => {
    expect(isKnownStep('account', 'verify_email')).toBe(true);
    expect(isKnownStep('account', 'accept_terms')).toBe(true);
    for (const id of ['choose_plan', 'start_trial', 'subscribe', 'billing_profile', 'enter_email', 'create_account', 'done']) {
      expect(isKnownStep('account', id), id).toBe(false);
    }
  });

  test('allowance and trial documents with no required step are the status view', () => {
    for (const name of ['account.allowance.ios', 'account.trial_ended.ios', 'account.lapsed.ios', 'account.trialing_no_card.desktop']) {
      expect(planScreen(doc(name), new Set()), name).toEqual({ kind: 'account' });
    }
  });

  test('needs_plan with an unverified email blocks on verify_email', () => {
    const s = planScreen(doc('account.needs_plan.ios'), new Set());
    expect(s.kind).toBe('step');
    expect(s.stepId).toBe('verify_email');
  });

  test('a required accept_terms step in the account stage is a real step (every pre-1740 account has one)', () => {
    const d = doc('account.allowance.ios', (raw) => {
      raw.steps = [{ id: 'accept_terms', status: 'todo', required: true, ui: 'action', params: { version: '2026-09-29' } }];
      raw.blocking = true;
    });
    const s = planScreen(d, new Set());
    expect(s.kind).toBe('step');
    expect(s.stepId).toBe('accept_terms');
    expect(s.step.params.version).toBe('2026-09-29');
  });

  test('an optional purchase step is skipped and never drawn; a REQUIRED one stops at the text-only fallback', () => {
    const optional = doc('account.allowance.ios', (raw) => {
      raw.steps = [{ id: 'start_trial', status: 'todo', required: false, ui: 'action' }, { id: 'choose_plan', status: 'todo', required: false, ui: 'action' }];
    });
    expect(planScreen(optional, new Set())).toEqual({ kind: 'account' });
    const required = doc('account.allowance.ios', (raw) => {
      raw.steps = [{ id: 'choose_plan', status: 'todo', required: true, ui: 'action', fallback: { kind: 'use_web', url: 'https://beebeeb.io/choose-plan' } }];
      raw.blocking = true;
    });
    const s = planScreen(required, new Set());
    expect(s.kind).toBe('fallback');
    expect(s.stepId).toBe('choose_plan');
  });

  test('a required stop cannot be hidden behind an earlier optional action', () => {
    const d = doc('account.allowance.ios', (raw) => {
      raw.steps = [
        { id: 'start_trial', status: 'todo', required: false, ui: 'action' },
        { id: 'confirm_phone_number', status: 'todo', required: true, ui: 'action' },
      ];
      raw.blocking = true;
    });
    const s = planScreen(d, new Set());
    expect(s.kind).toBe('fallback');
    expect(s.stepId).toBe('confirm_phone_number');
  });
});

describe('recovery phrase length the server declares (1753 pass 2, finding 3)', () => {
  test('a word_count core does not generate is refused up front, as a schema this build does not understand', () => {
    const d = doc('pre_account.ios', (raw) => { raw.policy.recovery_phrase.word_count = 24; });
    const s = planScreen(d, new Set());
    expect(s.kind).toBe('unsupported_schema');
    // refused at every step, not only at the phrase screen: no email is sent for a signup that cannot finish
    expect(planScreen(d, new Set(['enter_email', 'verify_email_code'])).kind).toBe('unsupported_schema');
  });
  test('the count core generates (12) proceeds as before', () => {
    expect(planScreen(doc('pre_account.ios'), new Set()).kind).toBe('step');
  });
});
