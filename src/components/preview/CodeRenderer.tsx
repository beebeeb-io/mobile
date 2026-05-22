/**
 * CodeRenderer — syntax-highlighted source / config / markup viewer.
 *
 * Owns `highlight.js` (and the ~15 language modules we support) so the lib
 * only enters Hermes when the user opens a text/code file.
 */

import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
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

const ATOM_ONE_DARK_CSS = 'pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#abb2bf;background:#282c34}.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}.hljs-doctag,.hljs-formula,.hljs-keyword{color:#c678dd}.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e06c75}.hljs-literal{color:#56b6c2}.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#98c379}.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#d19a66}.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#61aeee}.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#e6c07b}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}';

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapHighlightedLines(highlighted: string, totalDigits: number): string {
  const open: string[] = [];
  let buf = '';
  const lines: string[] = [];
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
      buf += tag;
      if (tag.startsWith('</')) {
        if (open.length > 0) open.pop();
      } else if (!tag.endsWith('/>')) {
        open.push(tag);
      }
      i = end + 1;
    } else if (ch === '\n') {
      const closing = open.map(() => '</span>').join('');
      lines.push(buf + closing);
      buf = open.join('');
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  lines.push(buf);

  return lines
    .map((line, idx) => {
      const lineNum = String(idx + 1).padStart(totalDigits, ' ');
      const content = line.length === 0 ? ' ' : line;
      return `<div class="line"><span class="lineno">${lineNum}</span><span class="lc">${content}</span></div>`;
    })
    .join('');
}

function buildCodeHtml(code: string, language: string): string {
  let highlighted: string;
  try {
    if (language !== 'plaintext' && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } else {
      highlighted = escapeHtmlText(code);
    }
  } catch {
    highlighted = escapeHtmlText(code);
  }

  const lineCount = code.split('\n').length;
  const totalDigits = Math.max(2, String(lineCount).length);
  const wrapped = wrapHighlightedLines(highlighted, totalDigits);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=4" />
  <style>
    ${ATOM_ONE_DARK_CSS}
    html, body { margin: 0; padding: 0; background: #282c34; color: #abb2bf; }
    body {
      font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      -webkit-text-size-adjust: 100%;
    }
    .code { padding: 12px 0 32px; }
    .line { display: flex; align-items: flex-start; padding: 0 16px; min-height: 19.2px; }
    .lineno {
      color: #4b5263;
      min-width: ${totalDigits + 1}ch;
      text-align: right;
      padding-right: 16px;
      user-select: none;
      flex-shrink: 0;
    }
    .lc {
      white-space: pre;
      flex: 1 1 auto;
    }
    ::selection { background: rgba(82, 139, 255, 0.35); }
  </style>
</head>
<body>
  <div class="code hljs">${wrapped}</div>
</body>
</html>`;
}

export function CodeRenderer({ code, language }: CodeRendererProps) {
  const html = useMemo(() => buildCodeHtml(code, language), [code, language]);
  return (
    <WebView
      source={{ html }}
      style={[styles.codeWebView, { backgroundColor: '#282c34' }]}
      originWhitelist={['*']}
      showsHorizontalScrollIndicator
      showsVerticalScrollIndicator
    />
  );
}

const styles = StyleSheet.create({
  codeWebView: {
    flex: 1,
    width: '100%',
  },
});
