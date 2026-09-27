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
    expect(infoSheetSource).toMatch(/StyleSheet\.absoluteFill, \{ zIndex: INFO_SHEET_Z_INDEX \}/);
  });

  test('the sheet sits above the floating bottom bar (the bar covered the Versions list)', () => {
    expect(sheetZ).toBeGreaterThan(styleZ(source, 'bottomBarWrap'));
  });

  test('the top chrome stays above the sheet (close and ⋯ work while it is open)', () => {
    expect(styleZ(source, 'chromeLayer')).toBeGreaterThan(sheetZ);
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
