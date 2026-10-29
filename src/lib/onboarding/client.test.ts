// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { fetchOnboardingDocument, outcomeFromRaw } from './client';
import { loadFixture } from './fixtures';

describe('fetchOnboardingDocument (spec 5.8 rule 6: every outcome is a value)', () => {
  test('a good document', async () => {
    const out = await fetchOnboardingDocument(async () => loadFixture('pre_account.ios'), false);
    expect(out.kind).toBe('document');
    expect(out.doc.stage).toBe('pre_account');
  });
  test('the transport is told whether a session exists', async () => {
    const seen = [];
    await fetchOnboardingDocument(async (s) => { seen.push(s); return loadFixture('account.allowance.ios'); }, true);
    expect(seen).toEqual([true]);
  });
  test('404 and 405 (old server) -> legacy not_found', async () => {
    for (const status of [404, 405]) {
      const out = await fetchOnboardingDocument(async () => { throw { status }; }, false);
      expect(out).toEqual({ kind: 'legacy', reason: 'not_found' });
    }
  });
  test('401 -> legacy unauthorized, never a downgrade to a signup screen', async () => {
    expect(await fetchOnboardingDocument(async () => { throw { status: 401 }; }, true)).toEqual({ kind: 'legacy', reason: 'unauthorized' });
  });
  test('network failure and any other status -> legacy network', async () => {
    for (const err of [{ status: 0 }, { status: 500 }, new Error('offline'), null]) {
      const out = await fetchOnboardingDocument(async () => { throw err; }, false);
      expect(out).toEqual({ kind: 'legacy', reason: 'network' });
    }
  });
  test('a document we cannot draw is legacy malformed; a newer major is unsupported_schema', () => {
    expect(outcomeFromRaw({ nope: true })).toEqual({ kind: 'legacy', reason: 'malformed' });
    expect(outcomeFromRaw({ ...loadFixture('pre_account.ios'), schema: 2 })).toEqual({ kind: 'unsupported_schema' });
  });
});
