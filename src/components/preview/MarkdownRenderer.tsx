/**
 * MarkdownRenderer — formatted markdown preview, NATIVE components only.
 *
 * Task 1563 (Guus, build 215 feedback: "i'm missing a proper preview of
 * markdown, meaning it parses straight away"): renders the `MdBlock[]` AST
 * from `src/lib/markdown/parse.ts` as real React Native views/text, the
 * same "no WebView" decision CodeRenderer.tsx already made and documented
 * (react-native-webview paints nothing on iOS 27 — see that file's doc
 * comment, task 1564 / PR #121).
 *
 * Fenced code blocks reuse `computeCodeView`/`highlightToLines` from
 * CodeRenderer.tsx (same highlighter, same token colors) rather than a
 * second highlighting implementation.
 */

import React, { Fragment, useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../../theme';
import type { Colors } from '../../theme';
import { parseMarkdown } from '../../lib/markdown/parse';
import type { MdBlock, MdInline, MdListNode } from '../../lib/markdown/types';
import { computeCodeView } from './CodeRenderer';

interface MarkdownRendererProps {
  markdown: string;
  colors: Colors;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(nodes: MdInline[], colors: Colors, keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'bold':
        return (
          <Text key={key} style={styles.bold}>
            {renderInline(node.children, colors, key)}
          </Text>
        );
      case 'italic':
        return (
          <Text key={key} style={styles.italic}>
            {renderInline(node.children, colors, key)}
          </Text>
        );
      case 'strike':
        return (
          <Text key={key} style={styles.strike}>
            {renderInline(node.children, colors, key)}
          </Text>
        );
      case 'code':
        return (
          <Text
            key={key}
            style={[styles.inlineCode, { backgroundColor: colors.paper2, color: colors.ink }]}
          >
            {' '}{node.text}{' '}
          </Text>
        );
      case 'link':
        return (
          <Text
            key={key}
            style={[styles.link, { color: colors.amber }]}
            onPress={() => { void Linking.openURL(node.href).catch(() => {}); }}
            accessibilityRole="link"
          >
            {renderInline(node.children, colors, key)}
          </Text>
        );
      case 'break':
        return <Fragment key={key}>{'\n'}</Fragment>;
      default:
        return null;
    }
  });
}

// ---------------------------------------------------------------------------
// List rendering (one level of nesting)
// ---------------------------------------------------------------------------

function ListView({ list, colors, depth = 0 }: { list: MdListNode; colors: Colors; depth?: number }) {
  return (
    <View style={depth > 0 ? styles.sublist : undefined}>
      {list.items.map((item, i) => {
        const marker = item.task
          ? null
          : list.ordered
            ? `${list.start + i}.`
            : '•';
        return (
          <Fragment key={i}>
            <View style={styles.listRow}>
              {item.task ? (
                <Ionicons
                  name={item.checked ? 'checkbox' : 'square-outline'}
                  size={16}
                  color={item.checked ? colors.amber : colors.ink3}
                  style={styles.taskIcon}
                />
              ) : (
                <Text style={[styles.listMarker, { color: colors.ink3 }]}>{marker}</Text>
              )}
              <Text
                style={[
                  styles.listText,
                  { color: item.task && item.checked ? colors.ink3 : colors.ink },
                  item.task && item.checked ? styles.strike : null,
                ]}
              >
                {renderInline(item.inline, colors, `li-${depth}-${i}`)}
              </Text>
            </View>
            {item.sublist && <ListView list={item.sublist} colors={colors} depth={depth + 1} />}
          </Fragment>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fenced code block — reuses CodeRenderer's highlighter, wrapped (not
// horizontally scrolling), consistent with the CodeRenderer soft-wrap fix.
// ---------------------------------------------------------------------------

function MdCodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const { lines } = useMemo(() => computeCodeView(text, lang ?? 'plaintext'), [text, lang]);
  return (
    <View style={styles.codeBlock}>
      {lines.map((spans, idx) => (
        <Text key={idx} style={styles.codeBlockLine}>
          {spans.length === 0
            ? ' '
            : spans.map((s, j) => (
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
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function alignToTextAlign(align: 'left' | 'center' | 'right' | null): TextStyle['textAlign'] {
  return align ?? 'left';
}

function TableView({
  header,
  rows,
  align,
  colors,
}: {
  header: MdInline[][];
  rows: MdInline[][][];
  align: ('left' | 'center' | 'right' | null)[];
  colors: Colors;
}) {
  return (
    <View style={[styles.table, { borderColor: colors.line }]}>
      <View style={[styles.tableRow, styles.tableHeaderRow, { borderColor: colors.line, backgroundColor: colors.paper2 }]}>
        {header.map((cell, i) => (
          <Text
            key={i}
            style={[styles.tableCell, styles.tableHeaderCell, { color: colors.ink, textAlign: alignToTextAlign(align[i] ?? null) }]}
          >
            {renderInline(cell, colors, `th-${i}`)}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} style={[styles.tableRow, { borderColor: colors.line }]}>
          {row.map((cell, c) => (
            <Text
              key={c}
              style={[styles.tableCell, { color: colors.ink, textAlign: alignToTextAlign(align[c] ?? null) }]}
            >
              {renderInline(cell, colors, `td-${r}-${c}`)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

const HEADING_SIZE: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 26,
  2: 22,
  3: 19,
  4: 17,
  5: 15,
  6: 14,
};

function renderBlock(block: MdBlock, colors: Colors, key: string): React.ReactNode {
  switch (block.kind) {
    case 'heading':
      return (
        <Text
          key={key}
          style={[
            styles.heading,
            { fontSize: HEADING_SIZE[block.depth], color: colors.ink },
            block.depth <= 2 ? { borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 6 } : null,
          ]}
        >
          {renderInline(block.inline, colors, key)}
        </Text>
      );
    case 'paragraph':
      return (
        <Text key={key} style={[styles.paragraph, { color: colors.ink }]}>
          {renderInline(block.inline, colors, key)}
        </Text>
      );
    case 'list':
      return (
        <View key={key} style={styles.listBlock}>
          <ListView list={block.list} colors={colors} />
        </View>
      );
    case 'blockquote':
      return (
        <View key={key} style={[styles.blockquote, { borderLeftColor: colors.amber, backgroundColor: colors.paper2 }]}>
          {block.blocks.map((b, i) => renderBlock(b, colors, `${key}-${i}`))}
        </View>
      );
    case 'code':
      return <MdCodeBlock key={key} lang={block.lang} text={block.text} />;
    case 'table':
      return <TableView key={key} header={block.header} rows={block.rows} align={block.align} colors={colors} />;
    case 'hr':
      return <View key={key} style={[styles.hr, { backgroundColor: colors.line }]} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarkdownRenderer({ markdown, colors }: MarkdownRendererProps) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <View style={[styles.root, { backgroundColor: colors.paper }]}>
      {blocks.map((block, i) => renderBlock(block, colors, `b-${i}`))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    paddingBottom: 48,
  },
  heading: {
    fontFamily: fonts.sans,
    fontWeight: '700',
    marginTop: 18,
    marginBottom: 10,
  },
  paragraph: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: 13.5,
    borderRadius: 4,
  },
  link: {
    textDecorationLine: 'underline',
  },
  listBlock: {
    marginBottom: 12,
  },
  sublist: {
    paddingLeft: 20,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  listMarker: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    width: 20,
  },
  taskIcon: {
    width: 20,
    marginTop: 3,
  },
  listText: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
  },
  blockquote: {
    borderLeftWidth: 3,
    paddingLeft: 14,
    paddingVertical: 8,
    paddingRight: 10,
    marginBottom: 12,
    borderRadius: 4,
  },
  codeBlock: {
    backgroundColor: '#282c34',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  codeBlockLine: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    color: '#abb2bf',
    flexWrap: 'wrap',
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    marginBottom: 14,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tableHeaderRow: {
    borderTopWidth: 0,
  },
  tableCell: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tableHeaderCell: {
    fontWeight: '700',
  },
  hr: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 16,
  },
});
