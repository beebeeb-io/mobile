/**
 * DocxRenderer — preview for .docx files via mammoth.
 *
 * Owns the `mammoth/mammoth.browser` import so the library only enters Hermes
 * when the user actually opens a Word document. Converts the doc to HTML and
 * renders it in a WebView with brand styling.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
// @ts-ignore — mammoth/mammoth.browser ships no .d.ts.
import mammoth from 'mammoth/mammoth.browser';
// 1346 — the static `colors` (light-only) import that used to live here was
// removed: it was shadowing the `c` prop (`colors: c` below, the real
// scheme-aware palette) and got read by mistake in two error/loading
// states, see the comment at those sites.
import { radii } from '../../theme';
import type { Colors } from '../../theme';

interface DocxRendererProps {
  data: ArrayBuffer;
  colors: Colors;
  isDark: boolean;
}

function buildDocxHtml(bodyHtml: string, c: Colors, isDark: boolean): string {
  const bg = c.paper;
  const ink = c.ink;
  const ink3 = c.ink3;
  const line = c.line;
  const amber = c.amber;
  const codeBg = c.paper2;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=4" />
  <style>
    :root { color-scheme: ${isDark ? 'dark' : 'light'}; }
    html, body { background: ${bg}; color: ${ink}; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      padding: 24px 20px 96px;
      -webkit-text-size-adjust: 100%;
    }
    h1, h2, h3, h4, h5, h6 { color: ${ink}; line-height: 1.25; margin: 1.4em 0 0.5em; }
    h1 { font-size: 1.9em; font-weight: 700; }
    h2 { font-size: 1.55em; font-weight: 700; }
    h3 { font-size: 1.3em; font-weight: 600; }
    h4 { font-size: 1.15em; font-weight: 600; }
    h5, h6 { font-size: 1em; font-weight: 600; }
    p { margin: 0 0 1em; }
    a { color: ${amber}; text-decoration: underline; }
    ul, ol { margin: 0 0 1em 1.25em; padding-left: 1em; }
    li { margin-bottom: 0.3em; }
    blockquote {
      margin: 1em 0; padding: 0.5em 1em;
      border-left: 3px solid ${amber}; color: ${ink3};
    }
    code, pre {
      font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.92em; background: ${codeBg}; border-radius: 4px;
    }
    code { padding: 1px 4px; }
    pre { padding: 12px; overflow-x: auto; }
    pre code { background: transparent; padding: 0; }
    hr { border: 0; border-top: 1px solid ${line}; margin: 1.5em 0; }
    table { border-collapse: collapse; margin: 1em 0; width: 100%; }
    td, th { border: 1px solid ${line}; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: ${codeBg}; font-weight: 600; }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    ::selection { background: ${amber}; color: ${ink}; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function DocxRenderer({ data, colors: c, isDark }: DocxRendererProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      try {
        const result = await mammoth.convertToHtml({ arrayBuffer: data });
        if (cancelled) return;
        const body = (result?.value as string) ?? '';
        setHtml(buildDocxHtml(body || '<p><em>This document is empty.</em></p>', c, isDark));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to convert document.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, c, isDark]);

  if (error) {
    // 1346 review finding — `colors` here was the module-level STATIC
    // import from '../../theme' (line ~19), silently shadowing the `c`
    // prop (the real, scheme-aware palette this component was given —
    // see `colors: c` in the destructure below). `colors.white` is a
    // fixed #FFFFFF in both palettes, so this read as white text on
    // PreviewScreen's doc-branch root, which follows the app's resolved
    // scheme (c.paper) since this task — invisible in light mode. Fixed
    // to use the `c` prop's semantic ink tokens, same as every other
    // colour in this file already correctly does (buildDocxHtml, the
    // WebView background below).
    return (
      <View style={styles.imageStatus}>
        <Text style={[styles.imageStatusTitle, { color: c.ink }]}>
          Couldn't open document
        </Text>
        <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>{error}</Text>
      </View>
    );
  }

  if (!html) {
    return (
      <View style={styles.imageStatus}>
        <ActivityIndicator color={c.amber} />
        <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>Converting document…</Text>
      </View>
    );
  }

  return (
    <WebView
      originWhitelist={['*']}
      source={{ html }}
      style={[styles.docxWebView, { backgroundColor: c.paper }]}
      showsVerticalScrollIndicator
    />
  );
}

const styles = StyleSheet.create({
  docxWebView: {
    flex: 1,
    width: '100%',
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  imageStatus: {
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  imageStatusTitle: { fontSize: 16, fontWeight: '600' },
  imageStatusSub: { fontSize: 12, opacity: 0.85, textAlign: 'center' },
});
