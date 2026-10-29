// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { clampCodeLength, isBeebeebHttpsUrl, phraseWordCountSupported, shownTermsVersion } from './limits';

describe('phrase word count', () => {
  test('only the count core generates is supported', () => {
    expect(phraseWordCountSupported(12)).toBe(true);
    expect(phraseWordCountSupported(24)).toBe(false);
    expect(phraseWordCountSupported(0)).toBe(false);
  });
});

describe('clampCodeLength', () => {
  test('4..12 inclusive, clamped outside', () => {
    expect([clampCodeLength(0), clampCodeLength(3), clampCodeLength(4), clampCodeLength(8), clampCodeLength(12), clampCodeLength(13), clampCodeLength(10000)]).toEqual([4, 4, 4, 8, 12, 12, 12]);
    expect(clampCodeLength(NaN)).toBe(12);
  });
});

describe('isBeebeebHttpsUrl', () => {
  test('beebeeb.io and its subdomains over https only', () => {
    for (const ok of ['https://beebeeb.io', 'https://beebeeb.io/terms', 'https://www.beebeeb.io/privacy?x=1', 'https://app.eu.beebeeb.io/#a'])
      expect(isBeebeebHttpsUrl(ok), ok).toBe(true);
  });
  test('lookalikes, other hosts, http, userinfo, ports are refused', () => {
    for (const bad of [
      'http://beebeeb.io/terms',
      'https://evil.com/terms',
      'https://beebeeb.io.evil.com/terms',
      'https://evilbeebeeb.io/terms',
      'https://beebeeb.io@evil.com/',
      'https://evil.com/?https://beebeeb.io',
      'https://beebeeb.io:8443/',
      'https://beebeeb.io\\@evil.com',
      'javascript:alert(1)',
      '',
      null,
    ])
      expect(isBeebeebHttpsUrl(bad), String(bad)).toBe(false);
  });
});

describe('shownTermsVersion', () => {
  test('the step param (what was displayed) wins over the policy value', () => {
    expect(shownTermsVersion({ version: '2026-10-01' }, '2026-09-29')).toBe('2026-10-01');
  });
  test('falls back to the policy version when the step carries none', () => {
    expect(shownTermsVersion({}, '2026-09-29')).toBe('2026-09-29');
    expect(shownTermsVersion({ version: '' }, '2026-09-29')).toBe('2026-09-29');
    expect(shownTermsVersion({ version: 5 }, '2026-09-29')).toBe('2026-09-29');
  });
});
