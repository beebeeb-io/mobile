/**
 * Task 1563 — pure text transforms for the mobile editor's InputAccessoryView
 * key row (Tab, brackets, and the markdown shortcuts). Kept separate from
 * `TextEditorView.tsx` so the cursor/selection math is unit-testable without
 * mounting a TextInput.
 */

export interface Selection {
  start: number;
  end: number;
}

export interface TextEdit {
  text: string;
  selection: Selection;
}

/** Insert `insert` at the cursor (or replacing the selection), cursor lands right after it. */
function insertAtCursor(text: string, sel: Selection, insert: string): TextEdit {
  const before = text.slice(0, sel.start);
  const after = text.slice(sel.end);
  const nextText = before + insert + after;
  const pos = before.length + insert.length;
  return { text: nextText, selection: { start: pos, end: pos } };
}

/** Wrap the current selection in `open`/`close`; with no selection, place the cursor between them. */
function wrapSelection(text: string, sel: Selection, open: string, close: string): TextEdit {
  const before = text.slice(0, sel.start);
  const selected = text.slice(sel.start, sel.end);
  const after = text.slice(sel.end);
  const nextText = `${before}${open}${selected}${close}${after}`;
  if (selected.length === 0) {
    const pos = before.length + open.length;
    return { text: nextText, selection: { start: pos, end: pos } };
  }
  const start = before.length + open.length;
  const end = start + selected.length;
  return { text: nextText, selection: { start, end } };
}

/** Start-of-line index for the line containing `pos`. */
function lineStart(text: string, pos: number): number {
  const idx = text.lastIndexOf('\n', pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

/** Insert `prefix` at the start of the current line (e.g. "# ", "- "). */
function prefixLine(text: string, sel: Selection, prefix: string): TextEdit {
  const start = lineStart(text, sel.start);
  const nextText = text.slice(0, start) + prefix + text.slice(start);
  const shift = prefix.length;
  return {
    text: nextText,
    selection: { start: sel.start + shift, end: sel.end + shift },
  };
}

export type AccessoryKey =
  | 'tab'
  | 'brace'
  | 'bracket'
  | 'paren'
  | 'heading'
  | 'bullet'
  | 'link'
  | 'backtick';

/** Apply one accessory-bar key to `text`/`sel`, returning the new text + selection. */
export function applyAccessoryKey(text: string, sel: Selection, key: AccessoryKey): TextEdit {
  switch (key) {
    case 'tab':
      return insertAtCursor(text, sel, '\t');
    case 'brace':
      return wrapSelection(text, sel, '{', '}');
    case 'bracket':
      return wrapSelection(text, sel, '[', ']');
    case 'paren':
      return wrapSelection(text, sel, '(', ')');
    case 'heading':
      return prefixLine(text, sel, '# ');
    case 'bullet':
      return prefixLine(text, sel, '- ');
    case 'link': {
      const selected = text.slice(sel.start, sel.end);
      if (selected.length === 0) return insertAtCursor(text, sel, '[](url)');
      return wrapSelection(text, sel, '[', '](url)');
    }
    case 'backtick':
      return wrapSelection(text, sel, '`', '`');
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Undo/redo history — a bounded stack of {text, selection} snapshots.
// RN's TextInput has no JS-callable native undo; this is a JS-side
// equivalent driven by the accessory bar's Undo/Redo buttons.
// ---------------------------------------------------------------------------

export interface EditorHistory {
  past: TextEdit[];
  present: TextEdit;
  future: TextEdit[];
}

const MAX_HISTORY = 100;

export function initHistory(present: TextEdit): EditorHistory {
  return { past: [], present, future: [] };
}

/** Push a new present state, clearing redo (a normal edit — not undo/redo itself). */
export function pushHistory(history: EditorHistory, next: TextEdit): EditorHistory {
  if (next.text === history.present.text) {
    // Selection-only change (e.g. tapping around) — don't grow the undo stack.
    return { ...history, present: next };
  }
  const past = [...history.past, history.present].slice(-MAX_HISTORY);
  return { past, present: next, future: [] };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: EditorHistory): boolean {
  return history.future.length > 0;
}

export function undo(history: EditorHistory): EditorHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1]!;
  const past = history.past.slice(0, -1);
  return { past, present: previous, future: [history.present, ...history.future] };
}

export function redo(history: EditorHistory): EditorHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0]!;
  const future = history.future.slice(1);
  return { past: [...history.past, history.present], present: next, future };
}
