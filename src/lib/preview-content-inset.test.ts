// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 (preview redesign, round 5) — pure content-inset helper. No
// react-native dependency, no module mocking needed.
//
// Expected numbers below are LITERAL, not re-imports of the module's own
// constants — a re-import would compare the mutated constant against
// itself and never fail. (Confirmed: an earlier draft of this file that DID
// import-and-compare let a mutated `PREVIEW_BOTTOM_BAR_HEIGHT_FALLBACK`
// (62 -> 40) sail through green. Rewritten to literals below, then
// re-mutated — see the task file's Notes for the full red/green transcript.)
import { describe, expect, test } from 'bun:test'
import { computePreviewContentInset } from './preview-content-inset'

describe('computePreviewContentInset', () => {
  test('uses the MEASURED header/bottom-bar heights when both are known', () => {
    const result = computePreviewContentInset({
      safeAreaTop: 59,
      safeAreaBottom: 34,
      headerHeight: 117, // a real on-device measurement (59 + 8 + ~38 content + 12)
      bottomBarHeight: 70,
    })
    // top = measured header height (117) + the 8pt breathing gap
    expect(result.top).toBe(125)
    // bottom = measured bar height (70) + max(safeAreaBottom, 16) (34) + 8
    expect(result.bottom).toBe(112)
  })

  test('falls back to the derived defaults before onLayout has measured anything', () => {
    const result = computePreviewContentInset({
      safeAreaTop: 59,
      safeAreaBottom: 34,
      headerHeight: null,
      bottomBarHeight: undefined,
    })
    // 59 (safe area) + 58 (header fallback) + 8 (gap) = 125
    expect(result.top).toBe(125)
    // 62 (bar fallback) + 34 (safe area) + 8 (gap) = 104
    expect(result.bottom).toBe(104)
  })

  test('a device with NO home indicator (safeAreaBottom 0) still gets the 16pt floor', () => {
    const result = computePreviewContentInset({
      safeAreaTop: 20,
      safeAreaBottom: 0,
      headerHeight: null,
      bottomBarHeight: null,
    })
    // 62 (bar fallback) + 16 (floor, not 0) + 8 (gap) = 86
    expect(result.bottom).toBe(86)
  })

  test('a zero/negative measured height (e.g. a stale 0 from a not-yet-laid-out view) is treated as "not measured" and falls back', () => {
    const result = computePreviewContentInset({
      safeAreaTop: 47,
      safeAreaBottom: 34,
      headerHeight: 0,
      bottomBarHeight: -5,
    })
    expect(result.top).toBe(47 + 58 + 8)
    expect(result.bottom).toBe(62 + 34 + 8)
  })

  test('negative safe-area inputs (should never happen, but never produce a negative inset) clamp to 0', () => {
    const result = computePreviewContentInset({
      safeAreaTop: -10,
      safeAreaBottom: -10,
      headerHeight: null,
      bottomBarHeight: null,
    })
    expect(result.top).toBe(0 + 58 + 8)
    expect(result.bottom).toBe(62 + 16 + 8)
  })

  test('regression guard: top inset is never just safeAreaTop alone — round 4\'s bug was ZERO inset beyond the raw safe area', () => {
    const result = computePreviewContentInset({ safeAreaTop: 59, safeAreaBottom: 34 })
    expect(result.top).toBeGreaterThan(59)
    expect(result.top).toBe(125)
  })
})
