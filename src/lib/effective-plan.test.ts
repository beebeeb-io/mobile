// @ts-nocheck
/**
 * Task 1601 — `effectivePlan()` is the one function every screen must use
 * instead of reading `subscription.plan` directly. Bug: a voluntarily
 * cancelled Pro subscription keeps `plan: 'pro'` with `status: 'cancelled'`
 * (prod row `43cc7529…`, 2026-09-28) — the mobile screens rendered "Pro"
 * over a Free-tier quota bar. Matches web's derivation exactly
 * (repos/web/src/pages/billing.tsx:710-717).
 *
 * Pure logic, no native imports — no `mock.module` needed.
 */
import { describe, expect, test } from 'bun:test';
import { effectivePlan } from './effective-plan';

describe('effectivePlan — no subscription / no row', () => {
  test('null subscription -> free', () => {
    expect(effectivePlan(null)).toBe('free');
  });

  test('undefined subscription -> free', () => {
    expect(effectivePlan(undefined)).toBe('free');
  });
});

describe('effectivePlan — derivation (no server effective_plan field)', () => {
  test("status 'cancelled': plan has elapsed -> free, even though plan='pro'", () => {
    expect(effectivePlan({ plan: 'pro', status: 'cancelled' })).toBe('free');
  });

  test("status 'canceled' (US spelling) also -> free", () => {
    expect(effectivePlan({ plan: 'business', status: 'canceled' })).toBe('free');
  });

  test("status is case-insensitive: 'Cancelled' -> free", () => {
    expect(effectivePlan({ plan: 'pro', status: 'Cancelled' })).toBe('free');
  });

  test("status 'cancelling': paid access continues until current_period_end -> the plan", () => {
    expect(effectivePlan({ plan: 'pro', status: 'cancelling' })).toBe('pro');
  });

  test("status 'active' -> the plan", () => {
    expect(effectivePlan({ plan: 'pro', status: 'active' })).toBe('pro');
  });

  test("status 'trialing' -> the plan", () => {
    expect(effectivePlan({ plan: 'pro', status: 'trialing' })).toBe('pro');
  });

  test('no status field at all -> the plan (never crashes)', () => {
    expect(effectivePlan({ plan: 'pro' })).toBe('pro');
  });

  test('plan missing entirely -> free', () => {
    expect(effectivePlan({ plan: undefined as unknown as string, status: 'active' })).toBe('free');
  });
});

describe('effectivePlan — server field precedence (task 1601, server half)', () => {
  test('effective_plan present wins outright, even over a contradicting status/plan', () => {
    expect(
      effectivePlan({ plan: 'pro', status: 'active', effective_plan: 'business' }),
    ).toBe('business');
  });

  test('effective_plan present on a cancelled row is trusted as-is (server already applied status)', () => {
    expect(
      effectivePlan({ plan: 'pro', status: 'cancelled', effective_plan: 'free' }),
    ).toBe('free');
  });

  test('effective_plan = null (explicit) falls through to derivation, not treated as a value', () => {
    expect(
      effectivePlan({ plan: 'pro', status: 'cancelling', effective_plan: null }),
    ).toBe('pro');
  });

  test('effective_plan = "" (empty string) falls through to derivation', () => {
    expect(
      effectivePlan({ plan: 'pro', status: 'cancelled', effective_plan: '' }),
    ).toBe('free');
  });

  test('effective_plan absent (older server, mid-rollout): derives client-side', () => {
    expect(effectivePlan({ plan: 'pro', status: 'cancelled' })).toBe('free');
  });
});
