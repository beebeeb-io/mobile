/**
 * Markdown parsing — tokenize with `marked` (small, dependency-free, MIT,
 * already vetted elsewhere in the Beebeeb workspace — `repos/admin` pins the
 * same `marked@18.0.5`, task 1563 PR), then map its token tree into
 * Beebeeb's own `MdBlock`/`MdInline` shapes (`./types.ts`).
 *
 * Why a mapping layer instead of rendering `marked`'s tokens directly: the
 * native RN renderer (`MarkdownRenderer.tsx`, no WebView — see
 * CodeRenderer.tsx's doc comment) only ever needs to understand OUR node
 * set, so a future `marked` upgrade that renames/reshapes a token field can
 * only break this file (and its unit tests catch that immediately) — the
 * renderer and ITS tests are insulated from `marked`'s internals.
 *
 * Scope (task 1563 verification list): headings, paragraphs, bold/italic,
 * lists (+ one level of nesting), GFM task lists, inline code, fenced code
 * blocks, tables, blockquotes, links. Raw HTML blocks/inline HTML and link
 * reference definitions are intentionally dropped (out of scope) rather than
 * mis-rendered.
 */

import { marked, type Token, type Tokens } from 'marked';
import type { MdAlign, MdBlock, MdInline, MdListItem, MdListNode } from './types';

function isTokenArray(tokens: unknown): tokens is Token[] {
  return Array.isArray(tokens);
}

/** Map one inline-level token to zero-or-one `MdInline` nodes (recursing into children). */
function mapInlineToken(token: Token): MdInline | null {
  switch (token.type) {
    case 'text': {
      // Note: `mapInline()` (the array-level walker, below) special-cases
      // 'text' tokens itself so it can flatten a nested `.tokens` payload
      // into multiple sibling nodes — something a function returning a
      // single `MdInline | null` cannot do. This branch only runs for a
      // plain (non-nested) text token reached some other way; kept correct
      // and simple rather than duplicating that flattening here.
      return { kind: 'text', text: (token as Tokens.Text).text };
    }
    case 'escape':
      return { kind: 'text', text: (token as Tokens.Escape).text };
    case 'strong':
      return { kind: 'bold', children: mapInline((token as Tokens.Strong).tokens) };
    case 'em':
      return { kind: 'italic', children: mapInline((token as Tokens.Em).tokens) };
    case 'del':
      return { kind: 'strike', children: mapInline((token as Tokens.Del).tokens) };
    case 'codespan':
      return { kind: 'code', text: (token as Tokens.Codespan).text };
    case 'link': {
      const l = token as Tokens.Link;
      return { kind: 'link', href: l.href, children: mapInline(l.tokens) };
    }
    case 'image': {
      // No image fetching/decryption in the markdown preview (task 1563
      // scope) — show the alt text so the document is still legible rather
      // than silently dropping the reference.
      const img = token as Tokens.Image;
      return { kind: 'text', text: img.text ? `[image: ${img.text}]` : '[image]' };
    }
    case 'br':
      return { kind: 'break' };
    case 'checkbox':
      // Handled by the list-item mapper (task/checked), never emitted inline.
      return null;
    case 'html':
    case 'def':
      // Raw HTML / link-reference definitions: out of scope, dropped.
      return null;
    default:
      return null;
  }
}

/**
 * `marked` sometimes wraps a leaf `text` token's payload in its OWN nested
 * `tokens` (seen for list-item text) instead of a flat `.text` string. The
 * one branch above that needs that can't produce a `children`-bearing
 * `text` node (our `MdInline` type has no such variant), so unwrap it here
 * instead: a `text` token with nested tokens maps to THOSE tokens directly.
 */
function mapInline(tokens: Token[] | undefined): MdInline[] {
  if (!tokens) return [];
  const out: MdInline[] = [];
  for (const token of tokens) {
    if (token.type === 'text') {
      const t = token as Tokens.Text;
      if (isTokenArray(t.tokens) && t.tokens.length > 0) {
        out.push(...mapInline(t.tokens));
        continue;
      }
      out.push({ kind: 'text', text: t.text });
      continue;
    }
    const mapped = mapInlineToken(token);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapListItem(item: Tokens.ListItem): MdListItem {
  const inline: MdInline[] = [];
  let sublist: MdListNode | null = null;
  for (const token of item.tokens) {
    if (token.type === 'checkbox') continue;
    if (token.type === 'list') {
      sublist = mapList(token as Tokens.List);
      continue;
    }
    if (token.type === 'text') {
      const t = token as Tokens.Text;
      if (isTokenArray(t.tokens) && t.tokens.length > 0) {
        inline.push(...mapInline(t.tokens));
      } else if (t.text) {
        inline.push({ kind: 'text', text: t.text });
      }
      continue;
    }
    const mapped = mapInlineToken(token);
    if (mapped) inline.push(mapped);
  }
  return {
    inline,
    task: item.task,
    checked: item.checked ?? false,
    sublist,
  };
}

function mapList(token: Tokens.List): MdListNode {
  return {
    ordered: token.ordered,
    start: typeof token.start === 'number' && token.start > 0 ? token.start : 1,
    items: token.items.map(mapListItem),
  };
}

function mapTableCells(cells: Tokens.TableCell[]): MdInline[][] {
  return cells.map((cell) => mapInline(cell.tokens));
}

function normalizeAlign(align: 'center' | 'left' | 'right' | null): MdAlign {
  return align;
}

/** Map one block-level token to zero-or-one `MdBlock` nodes. */
function mapBlockToken(token: Token): MdBlock | null {
  switch (token.type) {
    case 'space':
    case 'def':
    case 'html':
      return null;
    case 'hr':
      return { kind: 'hr' };
    case 'heading': {
      const h = token as Tokens.Heading;
      const depth = Math.min(6, Math.max(1, h.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
      return { kind: 'heading', depth, inline: mapInline(h.tokens) };
    }
    case 'paragraph':
      return { kind: 'paragraph', inline: mapInline((token as Tokens.Paragraph).tokens) };
    case 'code': {
      const c = token as Tokens.Code;
      const lang = c.lang?.trim() || null;
      return { kind: 'code', lang, text: c.text };
    }
    case 'blockquote':
      return { kind: 'blockquote', blocks: mapBlocks((token as Tokens.Blockquote).tokens) };
    case 'list':
      return { kind: 'list', list: mapList(token as Tokens.List) };
    case 'table': {
      const tbl = token as Tokens.Table;
      return {
        kind: 'table',
        align: tbl.align.map(normalizeAlign),
        header: mapTableCells(tbl.header),
        rows: tbl.rows.map((row) => mapTableCells(row)),
      };
    }
    default:
      return null;
  }
}

function mapBlocks(tokens: Token[]): MdBlock[] {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    const mapped = mapBlockToken(token);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Parse a markdown source string into Beebeeb's own block AST. Pure — no I/O. */
export function parseMarkdown(source: string): MdBlock[] {
  const tokens = marked.lexer(source, { gfm: true, breaks: false });
  return mapBlocks(tokens);
}
