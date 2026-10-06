// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
//
// Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLxE) — source sweep:
// every `billingStatusView(...)` call site must pass BOTH `uploads_blocked_at`
// and `access_until`, or the cancelling-trial branch (billing-status.ts's
// "Uploads stopped · Access until … · Files deleted on …" line) silently
// never fires for that caller and it falls through to the ordinary
// "Access until <date>" copy — the exact bug this thread found in
// `SettingsScreen.tsx` (it called `billingStatusView` without either field,
// so Settings disagreed with Storage & Plan for the same account).
//
// Mirrors `src/components/sheet/sheet-sweep.test.ts`'s pattern (walk the
// source tree, regex/scan every real call site, fail the sweep if ANY
// offends) rather than hardcoding the two known call sites by name — a
// THIRD caller added later without both fields would otherwise regress
// silently again, exactly as SettingsScreen's did.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !full.endsWith('billing-status.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, 'utf-8') }));

/**
 * Find every `billingStatusView(` call and return the balanced-paren text of
 * its argument (from just after the opening `(` to its matching `)`), for
 * every occurrence in `text`. A plain paren-depth walk, not a regex, because
 * the argument is itself either a plain object literal (`{ ... }`) or a
 * ternary guarding one (`cond ? { ... } : null`) — both contain nested
 * `(`/`)` from other expressions in the wild.
 */
function billingStatusViewCallArgs(text: string): string[] {
  const needle = 'billingStatusView(';
  const args: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(needle, searchFrom);
    if (start === -1) break;
    const argStart = start + needle.length;
    let depth = 1;
    let i = argStart;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
      i += 1;
    }
    args.push(text.slice(argStart, i - 1));
    searchFrom = i;
  }
  return args;
}

describe('the sweep sees the callers', () => {
  test('it reads the source tree; the only billingStatusView caller is lib/plan-chip.ts (task 1821: no screen builds its own)', () => {
    expect(files.length).toBeGreaterThan(100);
    const callers = files.filter((f) => f.text.includes('billingStatusView(')).map((f) => f.rel);
    expect(callers).toEqual(['lib/plan-chip.ts']);
  });
});

describe('every billingStatusView caller passes uploads_blocked_at and access_until', () => {
  test('the argument is built by billingFieldsOf, which carries both fields (task 1605 — the SettingsScreen regression this sweep exists to catch)', () => {
    const chip = files.find((f) => f.rel === 'lib/plan-chip.ts');
    const callArgs = billingStatusViewCallArgs(chip.text);
    expect(callArgs.length).toBeGreaterThan(0);
    for (const arg of callArgs) expect(arg).toMatch(/^\s*fields\b/);
    const helper = chip.text.slice(chip.text.indexOf('export function billingFieldsOf'), chip.text.indexOf('export function accountChip'));
    expect(helper).toMatch(/uploads_blocked_at\s*:/);
    expect(helper).toMatch(/access_until\s*:/);
  });

  test('screens use accountChip, never billingStatusView directly', () => {
    for (const f of files.filter((x) => x.rel.startsWith('screens/'))) {
      expect(f.text.includes('billingStatusView('), f.rel).toBe(false);
    }
    for (const rel of ['screens/SettingsScreen.tsx', 'screens/StorageScreen.tsx']) {
      expect(files.find((x) => x.rel === rel).text.includes('accountChip('), rel).toBe(true);
    }
  });
});
