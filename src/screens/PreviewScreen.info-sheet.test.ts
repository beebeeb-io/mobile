// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1583 — Guus's device report on build 219: the preview's top buttons
// "only hide the buttons instead of the preview", and the Info sheet had
// unreadable labels, the bottom bar floating over it, and muddled rows.
//
// Same source-text convention as PreviewScreen.chrome-layer.test.ts: bun test
// has no React reconciler here, so the JSX shape and the stacking numbers are
// what these guards can check. Mutation evidence is in task 1583's Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');
const infoSheetSource = readFileSync(
  join(import.meta.dir, '../components/preview/InfoSheet.tsx'),
  'utf-8',
);
// Task 1586 — the Info sheet renders through the shared BottomSheet; the
// geometry and the layer's zIndex slot are applied there.
const bottomSheetSource = readFileSync(
  join(import.meta.dir, '../components/sheet/BottomSheet.tsx'),
  'utf-8',
);

function styleZ(src: string, styleName: string): number {
  const m = src.match(new RegExp(`\\n  ${styleName}\\s*:\\s*\\{([^}]*)\\}`, 's'));
  if (!m) throw new Error(`style "${styleName}" not found`);
  return Number(m[1].match(/zIndex:\s*(\d+)/)?.[1] ?? 0);
}

/** The media branch: from `if (isMediaPreview) {` to the doc branch's return. */
function mediaBranch(): string {
  const start = source.indexOf('  if (isMediaPreview) {');
  const end = source.indexOf('onGestureEvent={onCloseGestureEvent}', source.indexOf('<InfoSheet', start));
  if (start === -1 || end === -1) throw new Error('media branch not found');
  return source.slice(start, end);
}

describe('media preview — the top chrome is above the content stage', () => {
  test('the chrome layer is rendered after the stage (later sibling wins hit-testing)', () => {
    const branch = mediaBranch();
    const stage = branch.indexOf('{showPager ? (');
    const chrome = branch.indexOf('style={[styles.chromeLayer');
    expect(stage).toBeGreaterThan(-1);
    expect(chrome).toBeGreaterThan(-1);
    expect(chrome).toBeGreaterThan(stage);
  });

  test('the chrome layer takes no touches while hidden', () => {
    const branch = mediaBranch();
    const at = branch.indexOf('style={[styles.chromeLayer');
    const tag = branch.slice(at, branch.indexOf('>', at));
    expect(tag).toContain("pointerEvents={chromeVisible ? 'auto' : 'none'}");
  });
});

describe('Info sheet stacking', () => {
  const sheetZ = Number(infoSheetSource.match(/INFO_SHEET_Z_INDEX = (\d+)/)?.[1] ?? 0);

  test('the sheet layer carries its zIndex on the root view', () => {
    // InfoSheet hands its slot to the shared sheet, which puts it on its root.
    expect(infoSheetSource).toMatch(/<BottomSheet[^>]*zIndex=\{INFO_SHEET_Z_INDEX\}/s);
    expect(bottomSheetSource).toMatch(/style=\{\[StyleSheet\.absoluteFill, zIndex != null \? \{ zIndex \} : null\]\}/);
  });

  test('the sheet sits above the floating bottom bar (the bar covered the Versions list)', () => {
    expect(sheetZ).toBeGreaterThan(styleZ(source, 'bottomBarWrap'));
  });

  test('the top chrome stays above the sheet (close and ⋯ work while it is open)', () => {
    expect(styleZ(source, 'chromeLayer')).toBeGreaterThan(sheetZ);
  });

  test('even the large detent stops below the top chrome (sim: the handle hid under the title capsule)', () => {
    expect(infoSheetSource).toMatch(/topClearance=\{insets\.top \+ PREVIEW_CHROME_CLEARANCE\}/);
    expect(Number(infoSheetSource.match(/PREVIEW_CHROME_CLEARANCE = (\d+)/)?.[1] ?? 0)).toBeGreaterThanOrEqual(64);
    expect(bottomSheetSource).toMatch(/computeDetents\(detentNames, containerHeight - keyboardHeight, topClearance \?\? insets\.top\)/);
  });

  test('the ⋯ menu stays above the sheet', () => {
    expect(styleZ(source, 'optionsLayer')).toBeGreaterThan(sheetZ);
  });
});

describe('Info sheet content', () => {
  test('row labels and values carry theme colours (they had none: black on the dark sheet)', () => {
    expect(infoSheetSource).toMatch(/kvLabel:\s*\{[^}]*color:\s*c\.ink2/);
    expect(infoSheetSource).toMatch(/kvValue:\s*\{[^}]*color:\s*c\.ink\b/);
    expect(infoSheetSource).not.toMatch(/opacity:\s*0\.55/);
  });

  test('both branches build the rows through buildInfoSheetRows', () => {
    const calls = source.match(/extraRows=\{buildInfoSheetRows\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  test('"Stored in" is labelled from the region, not the "EU region" stub', () => {
    expect(infoSheetSource).toContain('label="Stored in"');
    expect(infoSheetSource).toContain('storageLocationLabel(');
    expect(source).not.toMatch(/storageLocation=\{/);
  });

  test('"Versions" opens the sheet at the Versions section, "Info" at the top', () => {
    expect((source.match(/onPress: \(\) => openInfo\('versions'\)/g) ?? []).length).toBe(2);
    expect((source.match(/onPress: \(\) => openInfo\('info'\)/g) ?? []).length).toBe(2);
    expect((source.match(/focus=\{infoFocus\}/g) ?? []).length).toBe(2);
  });

  test('⋯ closes the Info sheet before opening the menu', () => {
    const at = source.indexOf('const handlePreviewOptions = useCallback(() => {');
    const body = source.slice(at, source.indexOf("if (Platform.OS === 'ios')", at));
    expect(body).toContain('setInfoVisible(false)');
  });
});

// Guus, device 2026-09-27: "Why does it seem that the info sheet is not full
// width?" Design section 03: `.sheet2{left:0;right:0;bottom:0;
// border-radius:9cqw 9cqw 0 0}` — edge to edge, bottom attached, top corners only.
describe('Info sheet geometry (design section 03)', () => {
  // Since 1586 the geometry lives in the shared BottomSheet (its own tests in
  // src/components/sheet/BottomSheet.test.ts); here: the Info sheet uses it
  // and does not re-style the sheet.
  function sheetStyle(): string {
    const m = bottomSheetSource.match(/\n  sheet:\s*\{([^}]*)\}/s);
    if (!m) throw new Error('BottomSheet "sheet" style not found');
    return m[1];
  }

  test('the Info sheet renders through the shared BottomSheet', () => {
    expect(infoSheetSource).toContain('<BottomSheet');
    expect(infoSheetSource).toContain('<BottomSheetScrollView');
    expect(infoSheetSource).not.toMatch(/\n    sheet:\s*\{/);
  });

  test('full width and attached to the bottom edge', () => {
    const s = sheetStyle();
    expect(s).toMatch(/\bleft:\s*0,/);
    expect(s).toMatch(/\bright:\s*0,/);
    expect(s).toMatch(/\bbottom:\s*0,/);
  });

  test('top corners rounded with the sheet token, bottom corners square', () => {
    const s = sheetStyle();
    expect(s).not.toMatch(/\bborderRadius:/);
    expect(s).toMatch(/borderTopLeftRadius:\s*GLASS_RADII\.sheet/);
    expect(s).toMatch(/borderTopRightRadius:\s*GLASS_RADII\.sheet/);
    expect(s).toMatch(/borderBottomLeftRadius:\s*0,/);
    expect(s).toMatch(/borderBottomRightRadius:\s*0,/);
  });

  test('the home-indicator inset is padding inside the sheet', () => {
    expect(bottomSheetSource).toMatch(/const safeBottom = sheetSafeBottom\(insets\.bottom\)/);
    expect(bottomSheetSource).toMatch(/return Math\.max\(insetBottom, 16\)/);
    expect(bottomSheetSource).toMatch(/paddingBottom:\s*bottomPad \+ restHidden/);
  });
});
