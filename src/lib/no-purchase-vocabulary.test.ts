// @ts-nocheck
/**
 * Task 1821: no purchase vocabulary in any user-visible string of the iOS app
 * (App Store 3.1.1 / 3.1.3, task 1400). The app shows account STATE only.
 *
 * Every string literal, template piece and JSX text under src/ (tests excluded) is
 * scanned (scripts/purchase-vocabulary-scan.ts). A hit fails the test unless it is
 * in ALLOWED below: an explicit, reviewed list keyed by file and exact string, each
 * with the reason it is not a purchase hint. An allowlist entry that no longer
 * matches anything also fails, so the list cannot rot into a blanket pass.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { isPurchaseWording, scanSource } from '../../scripts/purchase-vocabulary-scan';

const SRC = join(__dirname, '..');
const ROOT = join(SRC, '..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) && !/\.d\.ts$/.test(e)) out.push(f);
  }
  return out;
}

/** [file relative to repo root, exact normalised string, why it is not a purchase hint] */
const ALLOWED = [
  // Account state, stated as a fact about the account (spec 4b.8). No action, no price, no product.
  ['src/lib/effective-plan.ts', 'No plan', 'account-state label for an account without a plan'],
  ['src/lib/onboarding/plan-card.ts', 'No plan', 'chip label for an account without a plan: a state'],
  ['src/lib/onboarding/plan-card.ts', 'Plan ended', 'chip label for a lapsed account: a state'],
  ['src/lib/onboarding/account-summary.ts', 'Plan ended', 'capability reason for a lapsed account: a state'],
  ['src/lib/onboarding/account-summary.ts', 'Your plan is active', 'headline for the active state: a state'],
  ['src/lib/onboarding/account-summary.ts', 'Your plan has ended', 'headline for the lapsed state: a state'],
  ['src/lib/onboarding/account-summary.ts', 'You are on the free plan', 'headline for the legacy free state: a state'],
  ['src/lib/onboarding/account-summary.ts', 'A payment did not go through', 'headline for past_due: a state, no action offered'],
  ['src/lib/onboarding/account-summary.ts', 'The first payment is on', 'a trial that already has a card on file: the date is a fact'],
  // Account and password management (security), not a plan or a payment.
  ['src/screens/SettingsScreen.tsx', 'Manage account on the web', 'row that opens account security (password, 2FA); no plan or billing behind it'],
  ['src/screens/SettingsScreen.tsx', 'Manage your password on the web at app.beebeeb.io.', 'password management note; no plan or billing'],
  // Renewal date of a subscription that already exists, shown as a fact ("Renews 12 Oct 2026").
  ['src/lib/billing-status.ts', 'Renews', 'date of an existing active subscription; no price, no action'],
  // Not user-visible: keyword and error tables.
  ['src/lib/api.ts', 'payment required', 'HTTP reason phrase in the raw-server-text filter'],
  ['src/lib/api.ts', 'Server changed the upload chunk plan', 'internal invariant error, "plan" means the chunk layout'],
  ['src/lib/doc-summary.ts', 'payment terms', 'invoice keyword table for on-device document typing'],
  ['src/lib/onboarding/parse.ts', 'account without account and purchase', 'internal parse diagnostic about the contract shape'],
  ['src/lib/AndroidThumbnailRepairWorker.tsx', 'Resume tomorrow to keep your data plan happy', 'mobile data plan (cellular), Android only'],
];

describe('no purchase vocabulary in user-visible strings (task 1821)', () => {
  const files = walk(SRC);
  const rel = (f) => relative(ROOT, f);

  test('we scanned the real source tree', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  test('the scanner can go red: known purchase sentences are caught, state sentences pass', () => {
    const red = [
      'Choose your plan on the web at beebeeb.io to start uploading.',
      'Storage full. Free up space or upgrade your plan to keep uploading.',
      'Subscribe to unlock more storage',
      'Prices in EUR. Annual billing includes a discount.',
      'Manage your plan from your account on the web.',
      'Resume your trial on the web to upload again.',
      'Pay now',
      'Buy more storage',
      'Open checkout',
      'Only 4,99 €/mo',
    ];
    for (const s of red) expect(isPurchaseWording(s), s).toBe(true);
    const green = [
      'Uploads are paused on this account.',
      'This account has reached its storage limit.',
      'Your trial has ended',
      'Create your account on the web at beebeeb.io, then sign in here.',
      'Choose a different one.',
      'Select Google Photos and choose your export format.',
    ];
    for (const s of green) expect(isPurchaseWording(s), s).toBe(false);
    const hits = scanSource('x.tsx', "const a = <Text>Upgrade your plan</Text>; const b = `Pay ${x} now`; const c = 'needs_plan';");
    expect(hits.map((h) => h.text)).toEqual(['Upgrade your plan', 'Pay']);
  });

  test('every hit is in the reviewed allowlist, and every allowlist entry is still needed', () => {
    const used = new Set();
    const unlisted = [];
    for (const f of files) {
      for (const h of scanSource(f, readFileSync(f, 'utf8'))) {
        const idx = ALLOWED.findIndex(([file, text]) => file === rel(f) && h.text.startsWith(text));
        if (idx >= 0) used.add(idx);
        else unlisted.push(`${rel(f)}:${h.line}: ${h.text}`);
      }
    }
    expect(unlisted).toEqual([]);
    const stale = ALLOWED.filter((_, i) => !used.has(i)).map(([file, text]) => `${file}: ${text}`);
    expect(stale).toEqual([]);
  });

  test('every allowlist entry carries a reason', () => {
    for (const [file, text, why] of ALLOWED) expect(why.length, `${file}: ${text}`).toBeGreaterThan(10);
  });
});

// The native engine (Swift) writes user-visible stop reasons too (camera backup paused ...).
// Same vocabulary, same rule, over the string literals of the app's own Swift modules.
const NATIVE_ALLOWED = [
  ['modules/beebeeb-crypto/ios/NativeManualUploader.swift', 'Upload session was planned for', 'chunk layout ("plan"), a developer diagnostic'],
];

function swiftFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'Pods' || e === 'node_modules' || e === 'build' || e.startsWith('.')) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) swiftFiles(f, out);
    else if (/\.swift$/.test(e) && !/Tests?\.swift$/.test(e)) out.push(f);
  }
  return out;
}

describe('no purchase vocabulary in the native Swift modules (task 1821)', () => {
  const files = swiftFiles(join(ROOT, 'modules'));
  const literals = (src) =>
    src
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .flatMap((l, i) => [...l.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => ({ line: i + 1, text: m[1].replace(/\\\([^)]*\)/g, '{}').replace(/\s+/g, ' ').trim() })))
      .filter((x) => /\s/.test(x.text) && isPurchaseWording(x.text));

  test('we scanned the real Swift module set, and the Swift scanner can go red', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(literals('let a = "Choose your plan on the web at beebeeb.io to start uploading."').length).toBe(1);
    expect(literals('// "Pay now please"\nlet a = "Uploads are paused on this account."').length).toBe(0);
  });

  test('every hit is allowlisted and every allowlist entry is still needed', () => {
    const used = new Set();
    const unlisted = [];
    for (const f of files) {
      for (const h of literals(readFileSync(f, 'utf8'))) {
        const idx = NATIVE_ALLOWED.findIndex(([file, text]) => file === relative(ROOT, f) && h.text.startsWith(text));
        if (idx >= 0) used.add(idx);
        else unlisted.push(`${relative(ROOT, f)}:${h.line}: ${h.text}`);
      }
    }
    expect(unlisted).toEqual([]);
    expect(NATIVE_ALLOWED.filter((_, i) => !used.has(i)).map(([file, text]) => `${file}: ${text}`)).toEqual([]);
  });
});

