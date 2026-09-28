// @ts-nocheck
/**
 * Task 1037: accounts are created on the web, not in the app. This covers
 * two things. First, how the web app's base URL is resolved for a build: an
 * explicit override, then derived from the API URL, then production. Second,
 * the copy the login and needs_plan screens show while billing link-outs stay
 * off (task 1400, App Review 3.1.1(a)).
 *
 * Pure logic, no native imports, so no `mock.module` is needed.
 */
import { describe, expect, test } from 'bun:test';
import {
  WEB_ACCOUNT_LINKS_ENABLED,
  createAccountCopy,
  needsPlanCopy,
  resolveWebAppUrl,
  webAppLink,
} from './web-links';

describe('resolveWebAppUrl', () => {
  test('production API resolves to the production web app', () => {
    expect(resolveWebAppUrl({ apiUrl: 'https://api.beebeeb.io' })).toBe('https://app.beebeeb.io');
  });

  test('an explicit override wins (trailing slash trimmed)', () => {
    expect(
      resolveWebAppUrl({ configuredAppUrl: 'https://app.staging.example.test/', apiUrl: 'https://api.beebeeb.io' }),
    ).toBe('https://app.staging.example.test');
  });

  test('blank override is ignored', () => {
    expect(resolveWebAppUrl({ configuredAppUrl: '  ', apiUrl: 'https://api.beebeeb.io' })).toBe('https://app.beebeeb.io');
  });

  test('a staging API on api.<host> maps to app.<host>', () => {
    expect(resolveWebAppUrl({ apiUrl: 'https://api.staging.beebeeb.io' })).toBe('https://app.staging.beebeeb.io');
  });

  test('local API maps to the local web dev server (vite :5173) on the same host', () => {
    expect(resolveWebAppUrl({ apiUrl: 'http://localhost:3001' })).toBe('http://localhost:5173');
    expect(resolveWebAppUrl({ apiUrl: 'http://127.0.0.1:3001' })).toBe('http://127.0.0.1:5173');
    expect(resolveWebAppUrl({ apiUrl: 'http://10.0.2.2:3001' })).toBe('http://10.0.2.2:5173');
  });

  test('an unrecognised API host falls back to production, never to the API host itself', () => {
    expect(resolveWebAppUrl({ apiUrl: 'https://beebeeb.internal:8443' })).toBe('https://app.beebeeb.io');
    expect(resolveWebAppUrl({ apiUrl: 'garbage' })).toBe('https://app.beebeeb.io');
  });
});

describe('webAppLink', () => {
  test('joins base and path with exactly one slash', () => {
    expect(webAppLink('https://app.beebeeb.io', '/signup')).toBe('https://app.beebeeb.io/signup');
    expect(webAppLink('https://app.beebeeb.io/', 'choose-plan')).toBe('https://app.beebeeb.io/choose-plan');
  });
});

describe('link-out switch (task 1400)', () => {
  test('ships OFF: text-only, no billing/sign-up link in the app', () => {
    expect(WEB_ACCOUNT_LINKS_ENABLED).toBe(false);
  });
});

describe('createAccountCopy', () => {
  test('links off: one non-tappable sentence, no URL', () => {
    const copy = createAccountCopy(false);
    expect(copy.linkLabel).toBeNull();
    expect(copy.text).toBe('Create your account on the web at beebeeb.io, then sign in here.');
    expect(copy.text).not.toMatch(/https?:\/\//);
  });

  test('links on: a short prompt plus a link label', () => {
    const copy = createAccountCopy(true);
    expect(copy.linkLabel).toBe('Create account');
    expect(copy.text).not.toMatch(/https?:\/\//);
  });
});

describe('needsPlanCopy', () => {
  test('links off: tells the user to choose a plan on the web, then refresh; no link label', () => {
    const copy = needsPlanCopy(false);
    expect(copy.linkLabel).toBeNull();
    expect(copy.title).toBe('Finish setting up your account');
    expect(copy.body).toMatch(/beebeeb\.io/);
    expect(copy.body).toMatch(/Refresh/);
    expect(copy.body).not.toMatch(/https?:\/\//);
  });

  test('links on: carries a neutral link label', () => {
    expect(needsPlanCopy(true).linkLabel).toBe('Open beebeeb.io');
  });

  test('no price or purchase wording either way', () => {
    for (const on of [false, true]) {
      const { title, body, linkLabel } = needsPlanCopy(on);
      expect(`${title} ${body} ${linkLabel ?? ''}`).not.toMatch(/€|\$|upgrad|subscribe|buy|purchase|price/i);
    }
  });
});
