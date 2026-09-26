// @ts-nocheck
// Task 1563 (App Review blocker, build 214) — text/markdown/code preview
// rendered nothing on-device (bb-ios27): the `react-native-webview` WebView
// this component used to render into mounted with correct, non-empty HTML
// (confirmed by a render-time trace and a native-hierarchy dump — never a
// data/decrypt bug) but painted nothing at all, and never appeared as a
// native view in the hierarchy — see the root-cause note atop CodeRenderer.tsx.
//
// The regression guard below (`usesReactNativeWebview`) is a source-text
// check, not a mock-and-render one: calling the real `CodeRenderer(props)`
// function directly (outside a React render pass) throws
// `TypeError: null is not an object (evaluating 'resolveDispatcher().useMemo')`
// regardless of WebView — bun:test has no React reconciler wired up, so
// hooks have no active dispatcher. That failure mode is orthogonal to the
// thing this guard cares about, so the guard reads the source instead.
// RED on the pre-fix component: reverting CodeRenderer.tsx's imports to
// `import { WebView } from 'react-native-webview'` and its render to
// `<WebView source={{ html }} .../>` (the pre-fix shape) and rerunning this
// suite fails exactly the assertion below — pasted in the task's Notes.
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const codeRendererSource = readFileSync(join(import.meta.dir, 'CodeRenderer.tsx'), 'utf-8');

// Minimal react-native stand-ins (module-load only — no component is ever
// actually rendered in this file, see the header comment on why not). Real
// `react-native` fails to load under bun:test at all (Flow syntax in its
// index.js), matching every other test in this repo that touches a file
// importing it.
mock.module('react-native', () => ({
  View: (props: unknown) => props,
  Text: (props: unknown) => props,
  ScrollView: (props: unknown) => props,
  StyleSheet: {
    create: (s: unknown) => s,
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    hairlineWidth: 1,
  },
}));
mock.module('../../theme', () => ({ fonts: { mono: 'JetBrainsMono-Regular' } }));

const { computeCodeView, highlightToLines, MAX_PREVIEW_CHARS } = await import('./CodeRenderer');

describe('CodeRenderer does not depend on react-native-webview', () => {
  test('the component source never imports react-native-webview', () => {
    // Matches an actual import/require statement, not the doc-comment above
    // (which deliberately names 'react-native-webview' in prose to explain
    // the fix) — a bare substring check would false-positive on its own docs.
    expect(codeRendererSource).not.toMatch(/from\s+['"]react-native-webview['"]|require\(\s*['"]react-native-webview['"]/);
  });

  test('the component source never mentions <WebView (the JSX tag) outside its own doc comment', () => {
    const codeOnly = codeRendererSource.replace(/\/\*[\s\S]*?\*\//, ''); // strip the leading /** ... */ block
    expect(codeOnly).not.toContain('<WebView');
  });
});

// ---------------------------------------------------------------------------
// highlightToLines — pure tokenizer, the core of the fix (WebView's HTML
// string builder replaced by this + native <Text> spans)
// ---------------------------------------------------------------------------

describe('highlightToLines', () => {
  test('splits plain (untagged) text into one entry per line, unescaping entities', () => {
    const lines = highlightToLines('line one\nline &lt;two&gt;\n');
    expect(lines.length).toBe(3); // trailing \n still yields a final empty line, matching hljs's own line count
    expect(lines[0]).toEqual([{ text: 'line one', color: '#abb2bf', bold: false, italic: false }]);
    expect(lines[1]).toEqual([{ text: 'line <two>', color: '#abb2bf', bold: false, italic: false }]);
    expect(lines[2]).toEqual([]);
  });

  test('colors a tagged span using the hljs class → palette mapping', () => {
    const lines = highlightToLines('<span class="hljs-string">&quot;hi&quot;</span>');
    expect(lines).toEqual([[{ text: '"hi"', color: '#98c379', bold: false, italic: false }]]);
  });

  test('closes nested tags correctly — text after a nested close reverts to the outer color, not the default', () => {
    // hljs commonly nests, e.g. a keyword inside a meta span. The tag-stack
    // walk must pop exactly one level per </span>, not clear the whole stack.
    const lines = highlightToLines(
      '<span class="hljs-meta">@<span class="hljs-keyword">decorator</span>(x)</span>',
    );
    expect(lines[0]).toEqual([
      { text: '@', color: '#61aeee', bold: false, italic: false }, // hljs-meta
      { text: 'decorator', color: '#c678dd', bold: false, italic: false }, // hljs-keyword (nested, wins)
      { text: '(x)', color: '#61aeee', bold: false, italic: false }, // back to hljs-meta after </span>
    ]);
  });

  test('marks hljs-comment spans italic (matches the old CSS: .hljs-comment{font-style:italic})', () => {
    const lines = highlightToLines('<span class="hljs-comment">// note</span>');
    expect(lines[0][0].italic).toBe(true);
  });

  test('real hljs JSON output: a key and a boolean literal get different colors', async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    const hljsJson = (await import('highlight.js/lib/languages/json')).default;
    hljs.registerLanguage('json', hljsJson);
    const highlighted = hljs.highlight('{"ok": true, "n": 3}', { language: 'json' }).value;
    const lines = highlightToLines(highlighted);
    const flat = lines[0];
    const keyToken = flat.find((s) => s.text.includes('ok'));
    const literalToken = flat.find((s) => s.text === 'true');
    expect(keyToken?.color).toBe('#d19a66'); // hljs-attr — the JSON grammar's key class
    expect(literalToken?.color).not.toBe('#abb2bf'); // must be highlighted, not the default text color
    expect(keyToken?.color).not.toBe(literalToken?.color);
  });
});

// ---------------------------------------------------------------------------
// computeCodeView — the pure computation CodeRenderer's useMemo wraps:
// no WebView, truncates large input
// ---------------------------------------------------------------------------

describe('computeCodeView', () => {
  test('does not truncate a file at or under MAX_PREVIEW_CHARS', () => {
    const code = 'a'.repeat(MAX_PREVIEW_CHARS);
    const view = computeCodeView(code, 'plaintext');
    expect(view.truncated).toBe(false);
  });

  test('truncates a file over MAX_PREVIEW_CHARS, instead of highlighting the whole thing', () => {
    const code = 'a'.repeat(MAX_PREVIEW_CHARS + 1);
    const view = computeCodeView(code, 'plaintext');
    expect(view.truncated).toBe(true);
    // Highlighted output is built from the truncated slice only — a
    // multi-megabyte file must not reach hljs.highlight() at full size.
    const totalChars = view.lines.reduce((n, line) => n + line.reduce((m, s) => m + s.text.length, 0), 0);
    expect(totalChars).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
  });

  test('MAX_PREVIEW_CHARS is well under 1MB (task 1563 verification: ">= 1MB shows a truncation notice")', () => {
    // The verification rung asks for >= 1MB to trigger truncation. 1MB of
    // single-byte text is 1_000_000+ chars, comfortably above the cap.
    expect(MAX_PREVIEW_CHARS).toBeLessThan(1_000_000);
  });

  test('a real ~1.2MB text file truncates instead of hanging', () => {
    const oneMbPlus = 'x'.repeat(1_200_000);
    const start = Date.now();
    const view = computeCodeView(oneMbPlus, 'plaintext');
    const elapsedMs = Date.now() - start;
    expect(view.truncated).toBe(true);
    expect(elapsedMs).toBeLessThan(2000); // generous CI-safe bound; a hang would blow well past this
  });
});
