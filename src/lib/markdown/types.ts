/**
 * Markdown AST — Beebeeb's own small, stable node shapes.
 *
 * Task 1563: the mobile markdown preview renders NATIVE React Native
 * components (no WebView — see CodeRenderer.tsx's doc comment for why: RNW
 * paints nothing on iOS 27). `parse.ts` walks `marked`'s lexer output and
 * maps it into these node types; the renderer (`MarkdownRenderer.tsx`) only
 * ever has to know about THIS shape, not `marked`'s own token internals.
 * Decoupling the two means a `marked` upgrade that renames/reshapes its
 * token fields can only ever break `parse.ts` (and its unit tests would
 * catch it) — the renderer and its tests stay untouched.
 */

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: MdInline[] }
  | { kind: 'italic'; children: MdInline[] }
  | { kind: 'strike'; children: MdInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: MdInline[] }
  | { kind: 'break' };

export interface MdListItem {
  /** Inline content of the item, flattened from any leading text token(s). */
  inline: MdInline[];
  task: boolean;
  checked: boolean;
  /** Nested sub-list, when the item contains one (one level is all Beebeeb renders). */
  sublist: MdListNode | null;
}

export interface MdListNode {
  ordered: boolean;
  start: number;
  items: MdListItem[];
}

export type MdBlock =
  | { kind: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; inline: MdInline[] }
  | { kind: 'paragraph'; inline: MdInline[] }
  | { kind: 'list'; list: MdListNode }
  | { kind: 'blockquote'; blocks: MdBlock[] }
  | { kind: 'code'; lang: string | null; text: string }
  | {
      kind: 'table';
      align: MdAlign[];
      header: MdInline[][];
      rows: MdInline[][][];
    }
  | { kind: 'hr' };
