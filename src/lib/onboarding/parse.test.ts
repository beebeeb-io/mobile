// @ts-nocheck
/**
 * Task 1746: the tolerant onboarding-document parser (spec 5.8), driven by the
 * contract's golden fixtures plus hand-made hostile input. Pure, no native mocks.
 */
import { describe, expect, test } from 'bun:test';
import { fixtureNames, loadFixture } from './fixtures';
import { parseOnboardingDocument, safeHttpsUrl, sameOriginApiPath } from './parse';
import { COMPILED_PURCHASE_SURFACES, SUPPORTED_SCHEMA } from './types';

describe('contract fixtures', () => {
  test('there are 19 fixtures and every one parses (count asserted, not "ok")', () => {
    const names = fixtureNames();
    expect(names.length).toBe(19);
    for (const name of names) {
      const r = parseOnboardingDocument(loadFixture(name));
      expect(r.ok, `${name} must parse`).toBe(true);
    }
  });

  test('the launch binary implements no purchase surface', () => {
    expect(COMPILED_PURCHASE_SURFACES.length).toBe(0);
    expect(SUPPORTED_SCHEMA).toBe(1);
  });

  test('cta_allowed is false for EVERY fixture, including the desktop ones that say true', () => {
    let serverSaidTrue = 0;
    for (const name of fixtureNames()) {
      const raw = loadFixture(name);
      if (raw.purchase?.cta_allowed === true) serverSaidTrue += 1;
      const r = parseOnboardingDocument(raw);
      if (r.ok && r.doc.purchase) expect(r.doc.purchase.ctaAllowed, name).toBe(false);
    }
    // The check above is only worth something if it saw documents that allow purchase.
    expect(serverSaidTrue).toBeGreaterThan(0);
  });

  test('the model has no offers, no methods and no checkout: nothing to render', () => {
    for (const name of fixtureNames()) {
      const r = parseOnboardingDocument(loadFixture(name));
      if (!r.ok) continue;
      const keys = Object.keys(r.doc);
      expect(keys).not.toContain('offers');
      expect(keys).not.toContain('trialOffer');
      if (r.doc.purchase) {
        expect(Object.keys(r.doc.purchase).sort()).toEqual(['copy', 'ctaAllowed', 'priceVisibility', 'surface']);
      }
    }
  });
});

describe('the iOS pre-account document', () => {
  const doc = () => {
    const r = parseOnboardingDocument(loadFixture('pre_account.ios'));
    if (!r.ok) throw new Error('did not parse');
    return r.doc;
  };

  test('signup is native and the policy carries the numbers the server declared', () => {
    const d = doc();
    expect(d.stage).toBe('pre_account');
    expect(d.signup).toEqual({
      allowed: true,
      mode: 'native',
      reason: null,
      webUrl: 'https://app.beebeeb.io/signup',
    });
    expect(d.policy.password.minLength).toBe(12);
    expect(d.policy.password.breachCheck).toEqual({ endpoint: '/api/v1/auth/pwned-range/{prefix}', failOpen: true });
    expect(d.policy.recoveryPhrase).toEqual({ wordCount: 12, verifyWordCount: 3 });
    expect(d.policy.emailCode.length).toBe(8);
    expect(d.policy.emailCode.resendAfterSeconds).toBe(60);
    expect(d.steps.map((s) => s.id)).toEqual([
      'enter_email',
      'verify_email_code',
      'accept_terms',
      'set_password',
      'save_recovery_phrase',
      'create_account',
    ]);
  });
});

describe('forward compatibility (spec 5.8)', () => {
  const base = () => JSON.parse(JSON.stringify(loadFixture('pre_account.ios')));

  test('a schema major above ours is rejected as unsupported, not guessed', () => {
    const raw = base();
    raw.schema = 2;
    expect(parseOnboardingDocument(raw)).toEqual({ ok: false, reason: 'unsupported_schema', schema: 2 });
  });

  test('garbage is malformed, never a throw', () => {
    for (const bad of [null, undefined, 7, 'x', [], {}, { schema: 1 }, { schema: 1, stage: 'nope', steps: [] }]) {
      const r = parseOnboardingDocument(bad);
      expect(r.ok).toBe(false);
    }
  });

  test('an unknown step status is blocked; a missing "required" means required', () => {
    const raw = base();
    raw.steps[0].status = 'someday';
    delete raw.steps[1].required;
    const r = parseOnboardingDocument(raw);
    expect(r.ok).toBe(true);
    expect(r.doc.steps[0].status).toBe('blocked');
    expect(r.doc.steps[1].required).toBe(true);
  });

  test('unknown top-level and policy fields are ignored', () => {
    const raw = base();
    raw.shiny_new_thing = { a: 1 };
    raw.policy.shiny = true;
    expect(parseOnboardingDocument(raw).ok).toBe(true);
  });

  test('an unknown purchase surface is none, an unknown fallback kind is unknown', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('account.allowance.ios')));
    raw.purchase.surface = 'teleport';
    raw.fallback = { kind: 'carrier_pigeon', url: 'https://beebeeb.io/x' };
    const r = parseOnboardingDocument(raw);
    expect(r.doc.purchase.surface).toBe('none');
    expect(r.doc.fallback.kind).toBe('unknown');
  });

  test('capabilities outside the closed v1 set are dropped (rule 11)', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('account.allowance.ios')));
    raw.account.capabilities.teleport = { allowed: true };
    const r = parseOnboardingDocument(raw);
    expect(Object.keys(r.doc.account.capabilities).sort()).toEqual(['download', 'share', 'upload']);
  });

  test('update_required reaches the parser even when the stage block is missing (rule 7)', () => {
    const raw = { schema: 1, stage: 'account', steps: [], blocking: true, client: { status: 'update_required', min_version: '9.9.9' }, fallback: { kind: 'update_app' } };
    const r = parseOnboardingDocument(raw);
    expect(r.ok).toBe(true);
    expect(r.doc.client).toEqual({ status: 'update_required', minVersion: '9.9.9', recommendedVersion: null });
  });

  test('a pre_account document without signup and policy is malformed', () => {
    const raw = base();
    delete raw.policy;
    expect(parseOnboardingDocument(raw)).toEqual({ ok: false, reason: 'malformed', detail: 'pre_account without signup and policy' });
  });
});

describe('links and request paths in the document are checked once, here', () => {
  test('safeHttpsUrl accepts https and nothing else', () => {
    expect(safeHttpsUrl('https://beebeeb.io/terms')).toBe('https://beebeeb.io/terms');
    expect(safeHttpsUrl('https://beebeeb.io:8443/x?y=1#z')).toBe('https://beebeeb.io:8443/x?y=1#z');
    for (const bad of [
      'http://beebeeb.io/terms',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//evil.example/x',
      '/terms',
      'https://exa mple.com',
      'https://good.example@evil.example/x',
      'https://',
      'ftp://beebeeb.io',
      '',
      null,
      7,
    ]) {
      expect(safeHttpsUrl(bad), String(bad)).toBeNull();
    }
  });

  test('sameOriginApiPath accepts /api/v1/ paths and rejects everything that could leave the origin', () => {
    expect(sameOriginApiPath('/api/v1/auth/pwned-range/{prefix}')).toBe('/api/v1/auth/pwned-range/{prefix}');
    for (const bad of [
      'https://evil.example/api/v1/x',
      '//evil.example/api/v1/x',
      '/api/v2/x',
      '/api/v1/../admin',
      '/api/v1//x',
      'api/v1/x',
      '/api/v1/x y',
      null,
    ]) {
      expect(sameOriginApiPath(bad), String(bad)).toBeNull();
    }
  });

  test('a breach endpoint that is not same-origin, or lacks the prefix slot, is dropped (an outage in the ceremony)', () => {
    const mk = (endpoint) => {
      const raw = JSON.parse(JSON.stringify(loadFixture('pre_account.ios')));
      raw.policy.password.breach_check.endpoint = endpoint;
      return parseOnboardingDocument(raw).doc.policy.password.breachCheck;
    };
    expect(mk('https://evil.example/{prefix}').endpoint).toBeNull();
    expect(mk('/api/v1/auth/pwned-range/fixed').endpoint).toBeNull();
    expect(mk('/api/v1/{prefix}/{prefix}').endpoint).toBeNull();
    expect(mk('/api/v1/auth/pwned-range/{prefix}').endpoint).toBe('/api/v1/auth/pwned-range/{prefix}');
  });

  test('fail_open follows the document and defaults to open only when it is not "false"', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('pre_account.ios')));
    raw.policy.password.breach_check.fail_open = false;
    expect(parseOnboardingDocument(raw).doc.policy.password.breachCheck.failOpen).toBe(false);
  });
});
