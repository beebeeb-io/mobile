// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Build 217 bug fix — pure content-padding helper for TextEditorView. No
// react-native dependency, no module mocking needed (same pattern as
// `preview-content-inset.test.ts`).
//
// Expected numbers below are LITERAL, not re-imports of the module's own
// constants — a re-import would compare the mutated constant against
// itself and never fail (see `preview-content-inset.test.ts`'s own doc
// comment for the precedent this follows).
import { describe, expect, test } from 'bun:test'
import { clampGutterOffset, computeEditorContentPadding } from './text-editor-inset'

describe('computeEditorContentPadding', () => {
  test('with a real measured topInset, adds it on top of the 12pt base padding', () => {
    const result = computeEditorContentPadding(125, 50)
    // 12 (base) + 125 (header height + gap) = 137
    expect(result.paddingTop).toBe(137)
    // 32 (base) + 50 = 82
    expect(result.paddingBottom).toBe(82)
  })

  test('regression guard: a non-zero topInset must produce MORE than the bare 12pt base — build 217\'s bug was content starting at the bare base with no allowance for the floating header', () => {
    const result = computeEditorContentPadding(125, 0)
    expect(result.paddingTop).toBeGreaterThan(12)
    expect(result.paddingTop).toBe(137)
  })

  test('undefined/null insets (not measured yet) fall back to the bare base padding, never NaN', () => {
    const result = computeEditorContentPadding(undefined, null)
    expect(result.paddingTop).toBe(12)
    expect(result.paddingBottom).toBe(32)
  })

  test('a zero or negative inset (e.g. a stale 0 before the header has laid out) is treated as "no inset" and falls back to the base', () => {
    const result = computeEditorContentPadding(0, -5)
    expect(result.paddingTop).toBe(12)
    expect(result.paddingBottom).toBe(32)
  })
})

describe('clampGutterOffset', () => {
  // Real on-device repro (task 1575): a 177-line .md, several lines
  // soft-wrapped, topInset 151. Gutter's own un-wrapped content height =
  // 177 * 19.2 + 151 = 3549.4. The TextInput's REAL contentOffset.y reached
  // 4218 (because wrapped lines make the real content taller) — before this
  // clamp, that pushed every gutter number above the clipped viewport at
  // once (translateY(-4218) on content topping out at 3549.4 → all negative
  // y → a fully blank gutter, not just "drift").
  test('regression guard: a raw offset past the gutter\'s own (un-wrapped) content height clamps instead of blanking the whole gutter', () => {
    const result = clampGutterOffset(4218, 177, 19.2, 151, 32, 800)
    // maxOffset = (177*19.2 + 151 + 32) - 800 = 3581.4 - 800 = 2781.4
    expect(result).toBeCloseTo(2781.4, 5)
    expect(result).toBeLessThan(4218)
  })

  test('an offset within the gutter\'s real scroll range passes through unchanged', () => {
    const result = clampGutterOffset(500, 177, 19.2, 151, 32, 800)
    expect(result).toBe(500)
  })

  test('a short file whose content never fills the viewport clamps to 0 (nothing to scroll)', () => {
    const result = clampGutterOffset(50, 14, 19.2, 151, 32, 800)
    // gutterContentHeight = 14*19.2+151+32 = 451.8, less than the 800pt viewport
    expect(result).toBe(0)
  })

  test('a negative raw offset (top overscroll bounce) clamps to 0, never negative', () => {
    const result = clampGutterOffset(-40, 177, 19.2, 151, 32, 800)
    expect(result).toBe(0)
  })

  // PR #131 review (Codex P2): the TextInput's scrollable content includes
  // its bottom padding too, so its real max contentOffset.y is
  // topPadding + lines + bottomPadding - viewport. With NO soft wrapping the
  // gutter must track that exactly to the very end, or the last line number
  // sits `bottomPadding` below its line.
  test('end of scroll, no wrapping: the gutter reaches the TextInput\'s full max offset, bottom padding included', () => {
    const lines = 200
    const lh = 19.2
    const top = 151
    const bottom = 32 + 34 // base + safe-area inset
    const viewport = 800
    const textInputMax = top + lines * lh + bottom - viewport // 3257
    const result = clampGutterOffset(textInputMax, lines, lh, top, bottom, viewport)
    expect(result).toBeCloseTo(textInputMax, 5)
    // last gutter number's bottom edge == last text line's bottom edge
    const lastNumberBottom = top + lines * lh - result
    const lastLineBottom = top + lines * lh - textInputMax
    expect(lastNumberBottom).toBeCloseTo(lastLineBottom, 5)
  })

  test('end of scroll: an overscroll bounce past the full max still clamps to the full max (bottom padding included)', () => {
    const result = clampGutterOffset(5000, 200, 19.2, 151, 66, 800)
    // 151 + 3840 + 66 - 800 = 3257
    expect(result).toBeCloseTo(3257, 5)
  })

  test('a negative bottom padding is treated as 0, never shrinks the range', () => {
    expect(clampGutterOffset(5000, 200, 19.2, 151, -10, 800)).toBeCloseTo(3191, 5)
  })
})
