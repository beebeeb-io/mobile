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
  test('it reads the source tree and finds the known billingStatusView call sites', () => {
    expect(files.length).toBeGreaterThan(100);
    const callers = files.filter((f) => f.text.includes('billingStatusView(')).map((f) => f.rel);
    expect(callers).toContain('screens/StorageScreen.tsx');
    expect(callers).toContain('screens/SettingsScreen.tsx');
  });
});

describe('every billingStatusView caller passes uploads_blocked_at and access_until', () => {
  test('no call site omits either field (task 1605 — the SettingsScreen regression this sweep exists to catch)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const callArgs = billingStatusViewCallArgs(f.text);
      callArgs.forEach((arg, index) => {
        const label = callArgs.length > 1 ? `${f.rel} (call ${index + 1})` : f.rel;
        if (!/uploads_blocked_at\s*:/.test(arg)) offenders.push(`${label}: missing uploads_blocked_at`);
        if (!/access_until\s*:/.test(arg)) offenders.push(`${label}: missing access_until`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
