// @ts-nocheck
// Task 1564 [P0] — react-native-webview painted nothing (not even its own
// background) on iOS 27 when its DIRECT parent View set
// justifyContent:'center'/alignItems:'center' — confirmed by an isolated
// repro (7 build/device iterations on a dedicated iOS 27 sim, bb-1564):
// the SAME WebView child style (flex:1, percentage, or percentage plus an
// explicit alignSelf:'stretch') fails identically under a centered direct
// parent and succeeds once that parent's centering is removed. This is the
// real-device-confirmed root cause of the SVG preview bug (Guus, build 215,
// 2026-09-26 19:15: "an .svg preview shows an empty dark area") and,
// earlier, of CodeRenderer's pre-#121 blank WebView (same `previewArea`
// parent) — see PreviewScreen.tsx's SVG branch and DocxRenderer.tsx for the
// full write-up and the fix (a plain, non-centered flex:1 wrapper View
// between `previewArea` and the WebView).
//
// Same source-text convention as CodeRenderer.test.ts's
// `usesReactNativeWebview` guard (that file's own header explains why: bun
// test has no React reconciler wired up, so actually rendering these screens
// isn't possible here — the source is the only thing this guard can check).
//
// RED on the pre-fix shape: reverting the SVG branch to mount
// `<WebView style={styles.svgWebView} .../>` directly (no wrapping View) and
// rerunning this suite fails
// "the SVG WebView is not a direct child of the centered previewArea" with
// exactly the pre-fix JSX slice in the diff — pasted in task 1564's Notes,
// captured 2026-09-26. Same for DocxRenderer's `docxWebViewWrap` guard.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const previewScreenSource = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');
const docxRendererSource = readFileSync(
  join(import.meta.dir, '../components/preview/DocxRenderer.tsx'),
  'utf-8',
);

function styleObjectBody(source: string, styleName: string): string {
  // Matches `<styleName>: { ...anything up to the matching close brace... }`
  // inside a StyleSheet.create({...}) block. Good enough for the flat,
  // single-level style objects both files use.
  const re = new RegExp(`\\b${styleName}\\s*:\\s*\\{([^}]*)\\}`, 's');
  const m = source.match(re);
  if (!m) throw new Error(`style "${styleName}" not found in source`);
  return m[1];
}

describe('PreviewScreen SVG WebView — task 1564 centered-parent regression guard', () => {
  test('previewArea (the SVG branch\'s ancestor) still centers its children — if this ever stops being true, the wrapper below is no longer load-bearing and this whole guard should be revisited', () => {
    const previewArea = styleObjectBody(previewScreenSource, 'previewArea');
    expect(previewArea).toMatch(/justifyContent:\s*'center'/);
    expect(previewArea).toMatch(/alignItems:\s*'center'/);
  });

  test('the SVG WebView is wrapped in a NON-centered View (svgWebViewWrap), not a direct child of the centered previewArea', () => {
    // The fix: `<View style={styles.svgWebViewWrap}><WebView .../></View>`,
    // in that order, inside the `isSvg` branch. A plain string search (not
    // just "does svgWebViewWrap exist anywhere") so a fix that adds the
    // style but forgets to actually use it at the call site still fails.
    const svgBranch = previewScreenSource.slice(
      previewScreenSource.indexOf('isSvg ?'),
      previewScreenSource.indexOf('isPdf ?'),
    );
    expect(svgBranch).toContain('<View style={styles.svgWebViewWrap}>');
    const webviewIndex = svgBranch.indexOf('<WebView');
    const wrapIndex = svgBranch.indexOf('<View style={styles.svgWebViewWrap}>');
    expect(wrapIndex).toBeGreaterThan(-1);
    expect(webviewIndex).toBeGreaterThan(wrapIndex);
  });

  test('svgWebViewWrap does not itself re-introduce centering', () => {
    const wrap = styleObjectBody(previewScreenSource, 'svgWebViewWrap');
    expect(wrap).not.toMatch(/justifyContent:\s*'center'/);
    expect(wrap).not.toMatch(/alignItems:\s*'center'/);
  });
});

describe('DocxRenderer WebView — task 1564 centered-parent regression guard', () => {
  test('the WebView is wrapped in a NON-centered View (docxWebViewWrap), not returned bare (its caller in PreviewScreen is the centered previewArea, with only a Suspense boundary — which adds no native view — in between)', () => {
    expect(docxRendererSource).toContain('<View style={styles.docxWebViewWrap}>');
    const webviewIndex = docxRendererSource.indexOf('<WebView');
    const wrapIndex = docxRendererSource.indexOf('<View style={styles.docxWebViewWrap}>');
    expect(wrapIndex).toBeGreaterThan(-1);
    expect(webviewIndex).toBeGreaterThan(wrapIndex);
  });

  test('docxWebViewWrap does not itself introduce centering', () => {
    const wrap = styleObjectBody(docxRendererSource, 'docxWebViewWrap');
    expect(wrap).not.toMatch(/justifyContent:\s*'center'/);
    expect(wrap).not.toMatch(/alignItems:\s*'center'/);
  });
});

describe('DevicePairingShowScreen / ConstellationSendScreen — task 1564 scope note', () => {
  // These two were GROUPED with the SVG/DocxRenderer bug by association (same
  // WebView component family) in this task's original write-up, but were
  // never independently confirmed broken on a real device. Per the isolated
  // repro above, the trigger is specifically a CENTERED direct parent — and
  // both screens' WebView sits in a plain flex:1 (non-centered) container
  // already (`constellation`/`webview` styles, both files). This guard pins
  // that fact so a future edit that adds centering there gets caught, rather
  // than re-opening a bug this task's fix doesn't touch.
  test('DevicePairingShowScreen\'s WebView parent is not centered', () => {
    const src = readFileSync(
      join(import.meta.dir, 'DevicePairingShowScreen.tsx'),
      'utf-8',
    );
    const constellation = styleObjectBody(src, 'constellation');
    expect(constellation).not.toMatch(/justifyContent:\s*'center'/);
    expect(constellation).not.toMatch(/alignItems:\s*'center'/);
  });

  test('ConstellationSendScreen\'s WebView parent is not centered', () => {
    const src = readFileSync(
      join(import.meta.dir, 'ConstellationSendScreen.tsx'),
      'utf-8',
    );
    const constellation = styleObjectBody(src, 'constellation');
    expect(constellation).not.toMatch(/justifyContent:\s*'center'/);
    expect(constellation).not.toMatch(/alignItems:\s*'center'/);
  });
});
