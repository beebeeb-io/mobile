// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1578 (Issue 3) — pure line / row math for TextEditorView's gutter.
// Expected numbers are LITERAL (never re-derived from the module).
import { describe, expect, test } from 'bun:test'
import {
  computeGutterLayout,
  countLogicalLines,
  normalizeWrapCount,
  splitLogicalLines,
  uniqueLinesToMeasure,
  withWrapCount,
} from './editor-gutter'
import { clampGutterOffset } from './text-editor-inset'

const LH = 19.2
const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

describe('countLogicalLines', () => {
  test('"a\\n" is 2 lines — the empty line after a return is numbered', () => {
    expect(countLogicalLines('a\n')).toBe(2)
  })
  test('20 lines plus a trailing newline (return pressed at end of line 20) is 21', () => {
    expect(countLogicalLines(twenty)).toBe(20)
    expect(countLogicalLines(twenty + '\n')).toBe(21)
  })
  test('an empty string is 1 line', () => {
    expect(countLogicalLines('')).toBe(1)
  })
  test('CRLF counts each \\r\\n as ONE break, not two', () => {
    expect(countLogicalLines('a\r\nb\r\n')).toBe(3)
    expect(splitLogicalLines('a\r\nb')).toEqual(['a', 'b'])
  })
  test('a lone \\r is a break too (native text view treats it as a paragraph end)', () => {
    expect(countLogicalLines('a\rb')).toBe(2)
  })
})

describe('normalizeWrapCount', () => {
  test('unmeasured / zero / NaN / negative → 1 row; real counts pass through', () => {
    expect(normalizeWrapCount(undefined)).toBe(1)
    expect(normalizeWrapCount(0)).toBe(1)
    expect(normalizeWrapCount(NaN)).toBe(1)
    expect(normalizeWrapCount(-2)).toBe(1)
    expect(normalizeWrapCount(3)).toBe(3)
  })
})

describe('computeGutterLayout — the reported bug', () => {
  test('no wraps: after a return on line 20, number 21 sits exactly on line 21 (top 384)', () => {
    const layout = computeGutterLayout(splitLogicalLines(twenty + '\n'), new Map(), LH)
    expect(layout.rows.length).toBe(21)
    expect(layout.rows[20].lineNumber).toBe(21)
    expect(layout.rows[20].top).toBeCloseTo(384, 5)
  })

  test('a wrapped line above pushes number 21 down with its text (the drift Guus saw)', () => {
    // Line 5 wraps onto 3 visual rows in the TextInput. Line 21's text starts
    // at row 22 (20 one-row lines + 2 extra wrap rows = 22 rows above it).
    const lines = splitLogicalLines(twenty + '\n')
    const byText = new Map([['line 5', 3]])
    const layout = computeGutterLayout(lines, byText, LH)
    expect(layout.rows[4].height).toBeCloseTo(57.6, 5)
    expect(layout.rows[20].top).toBeCloseTo(22 * 19.2, 5)
    expect(layout.visualRowCount).toBe(23)
    expect(layout.totalHeight).toBeCloseTo(23 * 19.2, 5)
  })

  test('measurements are by text, so shifting lines down (return mid-file) keeps them', () => {
    const before = splitLogicalLines('short\nlong one')
    const after = splitLogicalLines('short\n\nlong one')
    const byText = new Map([['long one', 2]])
    expect(computeGutterLayout(before, byText, LH).rows[1].rows).toBe(2)
    const shifted = computeGutterLayout(after, byText, LH)
    expect(shifted.rows[1].rows).toBe(1)
    expect(shifted.rows[2].rows).toBe(2)
    expect(shifted.rows[2].top).toBeCloseTo(2 * 19.2, 5)
  })

  test('empty text still lays out line 1', () => {
    const layout = computeGutterLayout(splitLogicalLines(''), new Map(), LH)
    expect(layout.rows.map((r) => r.lineNumber)).toEqual([1])
    expect(layout.totalHeight).toBeCloseTo(19.2, 5)
  })
})

describe('clampGutterOffset with wrap-aware rows', () => {
  test('near the end of a wrapped file the gutter keeps scrolling with the text', () => {
    // 21 logical lines, 23 visual rows; viewport 300, paddings 12/32.
    // TextInput max offset = 23*19.2 + 12 + 32 - 300 = 185.6. Caret-on-last-line
    // offset (no bottom padding in view) = 12 + 23*19.2 - 300 = 153.6.
    const visualRows = 23
    expect(clampGutterOffset(153.6, visualRows, LH, 12, 32, 300)).toBeCloseTo(153.6, 5)
    // With the old logical-line count (21) that offset is clamped to 147.2 —
    // gutter 6.4pt short of the text (and far more for longer wraps).
    expect(clampGutterOffset(185.6, 21, LH, 12, 32, 300)).toBeCloseTo(147.2, 5)
  })
})

describe('withWrapCount / uniqueLinesToMeasure', () => {
  test('returns the same map when a measurement did not change', () => {
    const m = new Map([['x', 2]])
    expect(withWrapCount(m, 'x', 2)).toBe(m)
    const n = withWrapCount(m, 'x', 3)
    expect(n).not.toBe(m)
    expect(n.get('x')).toBe(3)
    expect(m.get('x')).toBe(2)
  })
  test('dedupes line texts in order and respects the cap', () => {
    expect(uniqueLinesToMeasure(['a', '', 'a', 'b', ''], 10)).toEqual(['a', '', 'b'])
    expect(uniqueLinesToMeasure(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
  })
})
