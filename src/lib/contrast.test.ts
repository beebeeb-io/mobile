// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 round 4 — pure WCAG contrast math, no react-native dependency.
import { describe, expect, test } from 'bun:test'
import {
  BLACK,
  MID_GREY,
  WCAG_AA_NORMAL_TEXT,
  WHITE,
  blendOver,
  contrastRatio,
  parseColor,
  relativeLuminance,
  worstCaseBarContrast,
} from './contrast'

describe('parseColor', () => {
  test('parses a 6-digit hex color as fully opaque', () => {
    expect(parseColor('#F2F1EE')).toEqual({ rgb: { r: 242, g: 241, b: 238 }, alpha: 1 })
  })

  test('parses rgba() with its own alpha', () => {
    expect(parseColor('rgba(44,44,50,0.46)')).toEqual({
      rgb: { r: 44, g: 44, b: 50 },
      alpha: 0.46,
    })
  })

  test('parses rgb() (no alpha) as fully opaque', () => {
    expect(parseColor('rgb(10, 10, 10)')).toEqual({ rgb: { r: 10, g: 10, b: 10 }, alpha: 1 })
  })
})

describe('relativeLuminance', () => {
  test('white is 1, black is 0', () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5)
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 5)
  })
})

describe('contrastRatio', () => {
  test('black on white is the WCAG-maximum 21:1', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 1)
  })

  test('a color against itself is 1:1', () => {
    expect(contrastRatio(MID_GREY, MID_GREY)).toBeCloseTo(1, 5)
  })

  test('is symmetric (argument order does not matter)', () => {
    expect(contrastRatio(BLACK, MID_GREY)).toBeCloseTo(contrastRatio(MID_GREY, BLACK), 10)
  })
})

describe('blendOver', () => {
  test('a fully-opaque foreground ignores the background entirely', () => {
    expect(blendOver({ rgb: { r: 10, g: 20, b: 30 }, alpha: 1 }, WHITE)).toEqual({
      r: 10,
      g: 20,
      b: 30,
    })
  })

  test('a fully-transparent foreground is invisible (background wins)', () => {
    expect(blendOver({ rgb: { r: 10, g: 20, b: 30 }, alpha: 0 }, WHITE)).toEqual({
      r: 255,
      g: 255,
      b: 255,
    })
  })

  test('reproduces the round-3 bug: the app dark glass fill over a white page washes out', () => {
    // rgba(44,44,50,0.46) is `glassMaterial('dark').fill` — the material the
    // doc-branch header/bottom bar used before this fix (docMaterial =
    // glassMaterial(resolved), resolved='dark' on the reported device).
    const overWhite = blendOver({ rgb: { r: 44, g: 44, b: 50 }, alpha: 0.46 }, WHITE)
    // A light/mid grey, not a dark bar — this IS the washed-out look from
    // evidence-1563-redesign-r3/23-pdf-counter-1of4-FIXED.png.
    expect(overWhite.r).toBeGreaterThan(150)
    expect(overWhite.g).toBeGreaterThan(150)
  })
})

describe('worstCaseBarContrast', () => {
  test('the OLD doc-branch material fails WCAG AA over a white ground', () => {
    // glassMaterial('dark'): fill rgba(44,44,50,0.46), label #F2F1EE.
    const ratio = worstCaseBarContrast('rgba(44,44,50,0.46)', '#F2F1EE', [WHITE])
    expect(ratio).toBeLessThan(WCAG_AA_NORMAL_TEXT)
  })

  test('a near-opaque near-black fill with a near-white label clears AA over white, black, and mid-grey', () => {
    const ratio = worstCaseBarContrast('rgba(12,12,14,0.90)', '#F7F6F2', [WHITE, BLACK, MID_GREY])
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT)
  })

  test('the worst ground is the lightest one (white), not black or mid-grey', () => {
    const white = worstCaseBarContrast('rgba(12,12,14,0.90)', '#F7F6F2', [WHITE])
    const black = worstCaseBarContrast('rgba(12,12,14,0.90)', '#F7F6F2', [BLACK])
    const grey = worstCaseBarContrast('rgba(12,12,14,0.90)', '#F7F6F2', [MID_GREY])
    expect(white).toBeLessThanOrEqual(black)
    expect(white).toBeLessThanOrEqual(grey)
  })
})
