// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { APP_STORE_URL, SUPPORT_MAILTO, fallbackAction } from './fallback-action';

describe('fallbackAction on a store build', () => {
  test('update_app opens the App Store page of this app, whatever URL the server named', () => {
    expect(fallbackAction({ kind: 'update_app', url: 'https://evil.example/' }, false)).toEqual({ kind: 'open', url: APP_STORE_URL, label: 'Update in the App Store' });
    expect(APP_STORE_URL.startsWith('itms-apps://apps.apple.com/app/id')).toBe(true);
  });
  test('contact_support is a mail to support, never the server URL', () => {
    expect(fallbackAction({ kind: 'contact_support', url: 'https://evil.example/' }, false)).toEqual({ kind: 'open', url: SUPPORT_MAILTO, label: 'Contact support' });
  });
  test('use_web is PLAIN TEXT while web links are off (App Review 3.1.1(a))', () => {
    const a = fallbackAction({ kind: 'use_web', url: 'https://beebeeb.io/signup' }, false);
    expect(a.kind).toBe('text');
    expect(JSON.stringify(a)).not.toContain('https://');
  });
  test('use_web is a link only with links on AND an https URL', () => {
    expect(fallbackAction({ kind: 'use_web', url: 'https://beebeeb.io/signup' }, true)).toEqual({ kind: 'open', url: 'https://beebeeb.io/signup', label: 'Continue on the web' });
    expect(fallbackAction({ kind: 'use_web', url: null }, true).kind).toBe('text');
  });
  test('unknown or missing fallback is text', () => {
    expect(fallbackAction({ kind: 'unknown', url: 'https://beebeeb.io/x' }, true).kind).toBe('text');
    expect(fallbackAction(null, true).kind).toBe('text');
    expect(fallbackAction(undefined, false).kind).toBe('text');
  });
});
