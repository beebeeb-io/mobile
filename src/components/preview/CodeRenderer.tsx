/**
 * CodeRenderer — syntax-highlighted source / config / markup viewer.
 *
 * Owns `highlight.js` (and the ~15 language modules we support) so the lib
 * only enters Hermes when the user opens a text/code file.
 *
 * Task 1563 (App Review blocker, build 214/App Review submission): this used
 * to render via a `react-native-webview` `<WebView source={{ html }}>`
 * showing a hand-built HTML document. On-device (bb-ios27, iOS 27.0) that
 * WebView mounted with correct, non-empty HTML — confirmed both by a
 * render-time trace (`html.length` matched the real document, e.g. 2016
 * chars for a 69-byte file) and by the surrounding container rendering
 * correctly when swapped for a plain `<View>` — but painted NOTHING: not
 * the code, not even its own `#282c34` background, and the native WebView
 * never appeared in a `maestro hierarchy` dump at all, under three
 * different sizing strategies (`flex:1`, explicit `height:'100%'`,
 * `StyleSheet.absoluteFillObject`) and both lazy- and eagerly-imported. In
 * the same slot, on the same build, a `react-native-pdf` `<Pdf>` view (a
 * different native/Fabric view) rendered correctly — so this is not a
 * general "native views are broken in this build" problem, it is specific
 * to `react-native-webview`'s Fabric component never materializing on this
 * OS/build (consistent with known upstream Fabric-codegen registration
 * issues in that library — see react-native-webview#3697/#3777). Root-causing
 * that further needs an Xcode-console-attached device run, out of scope here.
 *
 * Fix: render the highlighted code as NATIVE `<Text>` (no WebView at all).
 * `highlightToLines` walks the same `hljs.highlight()` output the old HTML
 * builder consumed and turns each line into a run of {text, color} spans
 * instead of an HTML string, so the token-level coloring survives — this
 * is not a "plain text" downgrade, it's the same highlighter, a different
 * (native, proven-to-render) paint target.
 */

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme';
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('javascript', hljsJavascript);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('markdown', hljsMarkdown);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('typescript', hljsTypescript);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('yaml', hljsYaml);

interface CodeRendererProps {
  code: string;
  language: string;
}

// Same Atom One Dark palette the old CSS build used, keyed by hljs class name.
// Order matters when a token carries more than one class (rare) — the LAST
// matching entry wins, mirroring CSS's own cascade for the equivalent rule.
const TOKEN_COLORS: Record<string, string> = {
  'hljs-comment': '#5c6370',
  'hljs-quote': '#5c6370',
  'hljs-doctag': '#c678dd',
  'hljs-formula': '#c678dd',
  'hljs-keyword': '#c678dd',
  'hljs-deletion': '#e06c75',
  'hljs-name': '#e06c75',
  'hljs-section': '#e06c75',
  'hljs-selector-tag': '#e06c75',
  'hljs-subst': '#e06c75',
  'hljs-literal': '#56b6c2',
  'hljs-addition': '#98c379',
  'hljs-attribute': '#98c379',
  'hljs-regexp': '#98c379',
  'hljs-string': '#98c379',
  'hljs-attr': '#d19a66',
  'hljs-number': '#d19a66',
  'hljs-selector-attr': '#d19a66',
  'hljs-selector-class': '#d19a66',
  'hljs-selector-pseudo': '#d19a66',
  'hljs-template-variable': '#d19a66',
  'hljs-type': '#d19a66',
  'hljs-variable': '#d19a66',
  'hljs-bullet': '#61aeee',
  'hljs-link': '#61aeee',
  'hljs-meta': '#61aeee',
  'hljs-selector-id': '#61aeee',
  'hljs-symbol': '#61aeee',
  'hljs-title': '#61aeee',
  'hljs-built_in': '#e6c07b',
  'hljs-class': '#e6c07b',
};

const DEFAULT_TEXT_COLOR = '#abb2bf';

function colorForClasses(classes: string[]): string {
  let color = DEFAULT_TEXT_COLOR;
  for (const cls of classes) {
    if (TOKEN_COLORS[cls]) color = TOKEN_COLORS[cls];
  }
  return color;
}

function unescapeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface HighlightedSpan {
  text: string;
  color: string;
  bold: boolean;
  italic: boolean;
}

/**
 * Walk `hljs.highlight()`'s output (HTML-escaped text + `<span class="hljs-*">`
 * tags) and turn it into per-line arrays of colored text runs, without ever
 * building or parsing an actual HTML/DOM tree. Mirrors the tag-stack walk the
 * old `wrapHighlightedLines` used to split lines and track nesting, but emits
 * `HighlightedSpan[]` instead of an HTML string.
 */
export function highlightToLines(highlighted: string): HighlightedSpan[][] {
  const openClasses: string[] = [];
  const lines: HighlightedSpan[][] = [];
  let currentLine: HighlightedSpan[] = [];
  let buf = '';

  const flushBuf = () => {
    if (buf.length === 0) return;
    currentLine.push({
      text: unescapeHtmlEntities(buf),
      color: colorForClasses(openClasses),
      bold: openClasses.includes('hljs-strong'),
      italic: openClasses.includes('hljs-emphasis') || openClasses.includes('hljs-comment') || openClasses.includes('hljs-quote'),
    });
    buf = '';
  };

  let i = 0;
  while (i < highlighted.length) {
    const ch = highlighted[i];
    if (ch === '<') {
      const end = highlighted.indexOf('>', i);
      if (end === -1) {
        buf += highlighted.slice(i);
        break;
      }
      const tag = highlighted.slice(i, end + 1);
      flushBuf();
      if (tag.startsWith('</')) {
        openClasses.pop();
      } else if (!tag.endsWith('/>')) {
        const classMatch = tag.match(/class="([^"]*)"/);
        openClasses.push(classMatch ? classMatch[1] : '');
      }
      i = end + 1;
    } else if (ch === '\n') {
      flushBuf();
      lines.push(currentLine);
      currentLine = [];
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  flushBuf();
  lines.push(currentLine);

  return lines;
}

// Above this many characters, `hljs.highlight()` + several thousand nested
// native <Text> spans risk a genuinely frozen UI thread on-device rather
// than just a slow one — cap the input BEFORE highlighting, not after,
// since highlighting itself is the expensive step for a large file (task
// 1563 verification requirement: "a large text file (>= 1MB) shows a
// truncation notice rather than freezing"). ~300k chars is comfortably
// under a phone's frame budget while still showing a meaningfully large
// excerpt (not just the first screenful).
export const MAX_PREVIEW_CHARS = 300_000;

function highlightCode(code: string, language: string): HighlightedSpan[][] {
  let highlighted: string;
  try {
    if (language !== 'plaintext' && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } else {
      highlighted = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  } catch {
    highlighted = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  return highlightToLines(highlighted);
}

export interface CodeView {
  lines: HighlightedSpan[][];
  truncated: boolean;
}

/** Pure computation behind CodeRenderer's `useMemo` — no React needed, so it
 * is directly unit-testable without a renderer/reconciler. */
export function computeCodeView(code: string, language: string): CodeView {
  const truncated = code.length > MAX_PREVIEW_CHARS;
  const visibleCode = truncated ? code.slice(0, MAX_PREVIEW_CHARS) : code;
  return { lines: highlightCode(visibleCode, language), truncated };
}

export function CodeRenderer({ code, language }: CodeRendererProps) {
  const { lines, truncated } = useMemo(() => computeCodeView(code, language), [code, language]);
  const totalDigits = Math.max(2, String(lines.length).length);

  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.hScroll}>
        <ScrollView showsVerticalScrollIndicator style={styles.vScroll}>
          {truncated && (
            <Text style={styles.truncationNotice}>
              Showing the first {MAX_PREVIEW_CHARS.toLocaleString()} characters — download the file for the full version.
            </Text>
          )}
          <View style={styles.code}>
            {lines.map((spans, idx) => (
              <View key={idx} style={styles.line}>
                <Text style={[styles.lineno, { minWidth: (totalDigits + 1) * 7.2 }]}>
                  {String(idx + 1).padStart(totalDigits, ' ')}
                </Text>
                <Text style={styles.lineContent}>
                  {spans.length === 0 ? ' ' : spans.map((s, j) => (
                    <Text
                      key={j}
                      style={{
                        color: s.color,
                        fontWeight: s.bold ? '700' : '400',
                        fontStyle: s.italic ? 'italic' : 'normal',
                      }}
                    >
                      {s.text}
                    </Text>
                  ))}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const MONOSPACE_FONT = fonts.mono;

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#282c34',
  },
  hScroll: {
    flex: 1,
  },
  vScroll: {
    flex: 1,
  },
  code: {
    paddingVertical: 12,
    paddingBottom: 32,
    minWidth: '100%',
  },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    minHeight: 19.2,
  },
  lineno: {
    color: '#4b5263',
    textAlign: 'right',
    paddingRight: 16,
    fontFamily: MONOSPACE_FONT,
    fontSize: 12,
    lineHeight: 19.2,
  },
  lineContent: {
    color: DEFAULT_TEXT_COLOR,
    fontFamily: MONOSPACE_FONT,
    fontSize: 12,
    lineHeight: 19.2,
  },
  truncationNotice: {
    color: '#8b949e',
    fontFamily: MONOSPACE_FONT,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#21262d',
  },
});
