// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1586 — source sweep: no bottom sheet may float inset again.
//
// Guus, build 221: "make sure that every sheet going from bottom to
// 70%-isch, is full width". Every partial-height sheet renders through the
// shared BottomSheet; this file fails if a sheet style or a sheet screen
// reintroduces a horizontal inset / four rounded corners / its own
// bottom-anchored overlay. The inventory (every sheet, file:line, verdict) is
// in task 1586's Notes. Mutation evidence is there too.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, 'utf-8') }));

/** Material specimens in the __DEV__ glass gallery — inline A/B swatches on a
 * scrolling page, not presented sheets (see the inventory). */
const SPECIMEN_FILES = new Set(['screens/GlassGalleryScreen.tsx', 'components/glass/GlassSheet.tsx']);

/** Style blocks whose key ends in "sheet"/"Sheet" (sheet, opaqueSheet, …). */
function sheetStyleBlocks(text: string): { key: string; body: string }[] {
  const out: { key: string; body: string }[] = [];
  const re = /\n\s+(\w*[sS]heet):\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ key: m[1], body: m[2] });
  return out;
}

describe('the sweep sees the sheets', () => {
  test('it reads the source tree and finds the known sheet styles', () => {
    expect(files.length).toBeGreaterThan(100);
    const keys = files.flatMap((f) => sheetStyleBlocks(f.text).map((b) => `${f.rel}:${b.key}`));
    expect(keys).toContain('components/sheet/BottomSheet.tsx:sheet');
    expect(keys).toContain('components/BBActionSheet.tsx:sheet');
  });
});

describe('no bottom sheet floats inset', () => {
  test('no sheet style has a horizontal inset, a lifted bottom or four rounded corners', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (SPECIMEN_FILES.has(f.rel)) continue;
      for (const { key, body } of sheetStyleBlocks(f.text)) {
        if (/margin(Horizontal|Left|Right)\s*:\s*(?!0\b)/.test(body)) offenders.push(`${f.rel}:${key} margin`);
        if (/\b(left|right|bottom)\s*:\s*(?!0\b)[\w.]+/.test(body)) offenders.push(`${f.rel}:${key} edge inset`);
        if (/\bborderRadius\s*:/.test(body)) offenders.push(`${f.rel}:${key} four rounded corners`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the floating-sheet radius (38 on all four corners) only lives in the glass tokens and specimens', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('components/glass/') && !SPECIMEN_FILES.has(f.rel))
      .filter((f) => /\bborderRadius:\s*(38\b|GLASS_RADII\.sheet)/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test('no screen/component builds its own bottom-anchored overlay for a sheet', () => {
    // A flex-end overlay/root (the pre-1586 Share + Trust sheets) is a sheet
    // that bypasses the shared primitive.
    const offenders = files
      .filter((f) => /\n\s+(overlay|root|container|modalOverlay)\w*:\s*\{[^}]*justifyContent:\s*'flex-end'/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('every partial-height sheet renders through the shared BottomSheet', () => {
  const consumers = ['components/preview/InfoSheet.tsx', 'screens/ShareSheetScreen.tsx', 'components/TrustDetailsSheet.tsx', 'components/NewFileSheet.tsx'];
  for (const rel of consumers) {
    test(rel, () => {
      const f = files.find((x) => x.rel === rel);
      expect(f).toBeDefined();
      expect(f.text).toContain("from '");
      expect(f.text).toMatch(/import \{ BottomSheet, BottomSheetScrollView \} from '[./]*(components\/)?sheet\/BottomSheet'/);
      expect(f.text).toContain('<BottomSheet');
      expect(f.text).toContain('<BottomSheetScrollView');
      expect(f.text).not.toContain('KeyboardAvoidingView');
    });
  }
});
