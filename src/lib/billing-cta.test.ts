// @ts-nocheck
/**
 * Task 1540 findings 3, 5, 8, 9 — every "Upgrade" affordance in the iOS app
 * led to a screen or destination with NO actual purchase/upgrade mechanism
 * (task 1400 deliberately stripped StorageScreen's purchase CTA for App
 * Review 3.1.1(a) — the app has no IAP product). SettingsScreen's amber
 * "Upgrade" button, its two quota toasts, and FilesScreen's storage-full
 * banner (hint text + Alert copy) all still promised an "upgrade" action the
 * app cannot deliver.
 *
 * Fix (task 1400's own precedent — remove the CTA, keep informational-only
 * copy that names no purchase mechanism): the literal word "upgrade" no
 * longer appears anywhere in SettingsScreen.tsx or FilesScreen.tsx — task
 * 1400's own verification already proved zero occurrences in StorageScreen.tsx
 * (`grep -rniE "upgrade|pricing|subscribe" src/screens`), so this test
 * extends that same invariant to the two files this sweep found still
 * carrying the dead CTA. `handleUpgrade` (SettingsScreen.tsx:1629-1632,
 * navigated to a screen with nothing tappable on it) is removed entirely,
 * not just unwired, so it can't be re-attached to a new button later without
 * anyone noticing it still goes nowhere.
 *
 * A real, working action must remain reachable: FilesScreen's storage-full
 * message still tells the user to delete files (something the app can
 * actually do), and still points to "the web" for plan management —
 * matching StorageScreen's PLAN_MANAGEMENT_NOTE, so the story is consistent
 * across all three screens instead of silently dropping the escape hatch.
 *
 * Static source scan — same pattern as `plaintext-storage.test.ts` /
 * `glass-recipe.test.ts`. Reads files off disk; imports nothing native, so
 * needs no `mock.module` calls.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SETTINGS_SCREEN = join(REPO_ROOT, 'src', 'screens', 'SettingsScreen.tsx');
const FILES_SCREEN = join(REPO_ROOT, 'src', 'screens', 'FilesScreen.tsx');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('findings 3, 5, 9: SettingsScreen — the dead "Upgrade" CTA is removed, not just unwired', () => {
  const source = read(SETTINGS_SCREEN);

  test('zero occurrences of "upgrad" anywhere in the file (case-insensitive) — matches task 1400\'s own StorageScreen.tsx bar', () => {
    const hits = source.match(/upgrad/gi) ?? [];
    expect(hits).toEqual([]);
  });

  test('handleUpgrade is gone entirely, not left as dead unreferenced code', () => {
    expect(source).not.toMatch(/\bhandleUpgrade\b/);
  });

  test('accessibilityLabel="Upgrade plan" is gone', () => {
    expect(source).not.toContain('Upgrade plan');
  });
});

describe('findings 5, 8: FilesScreen — the storage-full banner no longer promises "upgrade"', () => {
  const source = read(FILES_SCREEN);

  test('zero occurrences of "upgrad" anywhere in the file (case-insensitive)', () => {
    const hits = source.match(/upgrad/gi) ?? [];
    expect(hits).toEqual([]);
  });

  test('the storage-full copy still tells the user to delete files — the one real, working action stays', () => {
    expect(source).toMatch(/delete files/i);
  });

  test('the storage-full copy still points to managing the plan on the web (consistent with StorageScreen\'s PLAN_MANAGEMENT_NOTE)', () => {
    expect(source).toMatch(/web/i);
  });
});

// Note: StorageScreen.tsx is deliberately NOT checked here for a "zero
// upgrad" bar — it already carries two informational, non-CTA mentions on
// main ("Plans shown as upgrade options" doc comment; "% used — consider
// upgrading" passive copy directly above its own PLAN_MANAGEMENT_NOTE
// disclaimer). Neither is cited by any finding in task 1540, and task 1400's
// own verification grep (`upgrade|pricing|subscribe`) checked for tappable
// CTAs, not a literal zero-substring bar — so holding StorageScreen.tsx to
// that stricter bar here would be scope creep past what was found broken.
