// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 — the editor's InputAccessoryView key-row transforms + JS-side
// undo/redo history. Pure, no react-native dependency.
import { describe, expect, test } from 'bun:test'
import {
  applyAccessoryKey,
  canRedo,
  canUndo,
  initHistory,
  pushHistory,
  redo,
  undo,
} from './editor-key-actions'

describe('applyAccessoryKey — no selection (cursor only)', () => {
  test('tab inserts a literal tab at the cursor', () => {
    const edit = applyAccessoryKey('ab', { start: 1, end: 1 }, 'tab')
    expect(edit).toEqual({ text: 'a\tb', selection: { start: 2, end: 2 } })
  })

  test('brace/bracket/paren insert an empty pair with the cursor placed BETWEEN them', () => {
    expect(applyAccessoryKey('', { start: 0, end: 0 }, 'brace')).toEqual({
      text: '{}',
      selection: { start: 1, end: 1 },
    })
    expect(applyAccessoryKey('', { start: 0, end: 0 }, 'bracket')).toEqual({
      text: '[]',
      selection: { start: 1, end: 1 },
    })
    expect(applyAccessoryKey('', { start: 0, end: 0 }, 'paren')).toEqual({
      text: '()',
      selection: { start: 1, end: 1 },
    })
  })

  test('heading/bullet prefix the START of the current line, not the cursor position', () => {
    const text = 'first line\nsecond line'
    const cursorInSecondLine = { start: 15, end: 15 } // inside "second"
    const edit = applyAccessoryKey(text, cursorInSecondLine, 'heading')
    expect(edit.text).toBe('first line\n# second line')
    // Cursor shifts by the prefix length (2), staying at the same logical spot in the line.
    expect(edit.selection).toEqual({ start: 17, end: 17 })
  })

  test('bullet prefixes with "- "', () => {
    const edit = applyAccessoryKey('todo', { start: 0, end: 0 }, 'bullet')
    expect(edit.text).toBe('- todo')
  })

  test('link with no selection inserts a template and does not crash on empty text', () => {
    const edit = applyAccessoryKey('', { start: 0, end: 0 }, 'link')
    expect(edit.text).toBe('[](url)')
  })

  test('backtick with no selection wraps an empty pair, cursor between the ticks', () => {
    const edit = applyAccessoryKey('', { start: 0, end: 0 }, 'backtick')
    expect(edit).toEqual({ text: '``', selection: { start: 1, end: 1 } })
  })
})

describe('applyAccessoryKey — with a selection', () => {
  test('brace wraps the selected text and keeps it selected', () => {
    const edit = applyAccessoryKey('hello world', { start: 0, end: 5 }, 'brace')
    expect(edit.text).toBe('{hello} world')
    expect(edit.selection).toEqual({ start: 1, end: 6 })
  })

  test('link wraps the selection as "[selected](url)"', () => {
    const edit = applyAccessoryKey('click here', { start: 0, end: 10 }, 'link')
    expect(edit.text).toBe('[click here](url)')
  })

  test('backtick wraps the selection in backticks', () => {
    const edit = applyAccessoryKey('const x = 1', { start: 0, end: 11 }, 'backtick')
    expect(edit.text).toBe('`const x = 1`')
  })
})

describe('undo/redo history', () => {
  const empty = { text: '', selection: { start: 0, end: 0 } }

  test('a fresh history cannot undo or redo', () => {
    const h = initHistory(empty)
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  test('a text-changing edit becomes undoable; undo restores the prior text', () => {
    let h = initHistory(empty)
    h = pushHistory(h, { text: 'a', selection: { start: 1, end: 1 } })
    h = pushHistory(h, { text: 'ab', selection: { start: 2, end: 2 } })
    expect(canUndo(h)).toBe(true)

    h = undo(h)
    expect(h.present.text).toBe('a')
    expect(canRedo(h)).toBe(true)

    h = undo(h)
    expect(h.present.text).toBe('')
    expect(canUndo(h)).toBe(false)
  })

  test('redo replays what undo took back', () => {
    let h = initHistory(empty)
    h = pushHistory(h, { text: 'a', selection: { start: 1, end: 1 } })
    h = undo(h)
    h = redo(h)
    expect(h.present.text).toBe('a')
    expect(canRedo(h)).toBe(false)
  })

  test('a NEW edit after undo clears the redo stack (the standard editor rule)', () => {
    let h = initHistory(empty)
    h = pushHistory(h, { text: 'a', selection: { start: 1, end: 1 } })
    h = undo(h) // back to ''
    h = pushHistory(h, { text: 'x', selection: { start: 1, end: 1 } }) // a genuinely new branch
    expect(canRedo(h)).toBe(false)
    expect(h.present.text).toBe('x')
  })

  test('a selection-only change (same text) does not grow the undo stack', () => {
    let h = initHistory({ text: 'hello', selection: { start: 0, end: 0 } })
    h = pushHistory(h, { text: 'hello', selection: { start: 3, end: 3 } })
    expect(canUndo(h)).toBe(false)
    expect(h.present.selection).toEqual({ start: 3, end: 3 })
  })
})
