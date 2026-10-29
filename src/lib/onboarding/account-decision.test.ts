// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { decideAccountState } from './account-decision';
import { loadFixture } from './fixtures';
import { parseOnboardingDocument } from './parse';

const doc = (name) => parseOnboardingDocument(loadFixture(name)).doc;
const OK = { gate: { kind: 'ok' }, document: null, unsupportedSchema: false };
const NEEDS_PLAN_SUB = { account_state: 'needs_plan' };

describe('a usable account document decides', () => {
  test('allowance with the legacy label needs_plan is OK (the whole point), the document is kept', () => {
    const d = doc('account.allowance.ios');
    const r = decideAccountState({ subscription: NEEDS_PLAN_SUB, outcome: { kind: 'document', doc: d }, previous: OK });
    expect(r).toEqual({ gate: { kind: 'ok' }, document: d, unsupportedSchema: false });
  });
  test('trial_ended is read-only with the deletion date even if the subscription says ok', () => {
    const d = doc('account.trial_ended.ios');
    const r = decideAccountState({ subscription: { account_state: 'ok' }, outcome: { kind: 'document', doc: d }, previous: OK });
    expect(r.gate.kind).toBe('trial_ended');
  });
  test('works without a subscription at all (it failed to load)', () => {
    const d = doc('account.lapsed.ios');
    expect(decideAccountState({ subscription: null, outcome: { kind: 'document', doc: d }, previous: OK }).gate.kind).toBe('lapsed');
  });
  test('a document that cannot decide falls back to the legacy gate but is still kept', () => {
    const raw = JSON.parse(JSON.stringify(loadFixture('account.allowance.ios')));
    raw.account.capabilities = {};
    const d = parseOnboardingDocument(raw).doc;
    const r = decideAccountState({ subscription: { account_state: 'lapsed', data_deletion_at: '2026-12-01T00:00:00Z' }, outcome: { kind: 'document', doc: d }, previous: OK });
    expect(r.gate.kind).toBe('lapsed');
    expect(r.document).toBe(d);
  });
});

describe('rule 6: a document we cannot use is the legacy gate, and the stale document is dropped', () => {
  for (const reason of ['not_found', 'malformed', 'unauthorized']) {
    test(reason, () => {
      const previous = { gate: { kind: 'ok' }, document: doc('account.allowance.ios'), unsupportedSchema: false };
      const r = decideAccountState({ subscription: NEEDS_PLAN_SUB, outcome: { kind: 'legacy', reason }, previous });
      expect(r).toEqual({ gate: { kind: 'needs_plan' }, document: null, unsupportedSchema: false });
    });
  }
  test('a pre_account document for a signed-in caller is unusable', () => {
    const r = decideAccountState({ subscription: NEEDS_PLAN_SUB, outcome: { kind: 'document', doc: doc('pre_account.ios') }, previous: OK });
    expect(r.document).toBeNull();
    expect(r.gate.kind).toBe('needs_plan');
  });
});

describe('rule 5: a newer schema major', () => {
  test('is remembered, the vault stays usable through the legacy gate, the document is dropped', () => {
    const r = decideAccountState({ subscription: { account_state: 'ok' }, outcome: { kind: 'unsupported_schema' }, previous: OK });
    expect(r).toEqual({ gate: { kind: 'ok' }, document: null, unsupportedSchema: true });
  });
});

describe('a flaky connection never changes what was last known', () => {
  test('network failure keeps the previous gate AND document, even if the subscription loaded', () => {
    const d = doc('account.trial_ended.ios');
    const previous = { gate: { kind: 'trial_ended', dataDeletionAt: null, bannerText: null }, document: d, unsupportedSchema: false };
    const r = decideAccountState({ subscription: { account_state: 'ok' }, outcome: { kind: 'legacy', reason: 'network' }, previous });
    expect(r).toEqual(previous);
  });
  test('first load, network failure on the document, subscription ok: legacy gate', () => {
    const r = decideAccountState({ subscription: { account_state: 'lapsed' }, outcome: { kind: 'legacy', reason: 'network' }, previous: OK });
    expect(r.gate.kind).toBe('lapsed');
  });
  test('nothing loaded at all keeps the previous gate (a network error never locks anyone out)', () => {
    const r = decideAccountState({ subscription: null, outcome: null, previous: OK });
    expect(r).toEqual(OK);
    const locked = { gate: { kind: 'lapsed', dataDeletionAt: null }, document: null, unsupportedSchema: false };
    expect(decideAccountState({ subscription: null, outcome: { kind: 'legacy', reason: 'network' }, previous: locked })).toEqual(locked);
  });
});
