// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 (preview redesign) — pure chrome helpers. No react-native
// dependency, no module mocking needed.
import { describe, expect, test } from 'bun:test'
import {
  buildInfoSubline,
  formatPdfPageCounter,
  formatShareStatus,
  nextBarsVisible,
  resolveFolderLabel,
  shouldToggleBarsOnTap,
} from './preview-chrome'

describe('shouldToggleBarsOnTap / nextBarsVisible', () => {
  const idle = { editMode: false, infoVisible: false, optionsVisible: false }

  test('a plain content tap toggles the bars', () => {
    expect(shouldToggleBarsOnTap(idle)).toBe(true)
    expect(nextBarsVisible(true, idle)).toBe(false)
    expect(nextBarsVisible(false, idle)).toBe(true)
  })

  test('editing suppresses the toggle — there is no bottom bar to hide', () => {
    const ctx = { ...idle, editMode: true }
    expect(shouldToggleBarsOnTap(ctx)).toBe(false)
    expect(nextBarsVisible(true, ctx)).toBe(true)
    expect(nextBarsVisible(false, ctx)).toBe(false)
  })

  test('the Info sheet being open suppresses the toggle', () => {
    const ctx = { ...idle, infoVisible: true }
    expect(shouldToggleBarsOnTap(ctx)).toBe(false)
    expect(nextBarsVisible(true, ctx)).toBe(true)
  })

  test('the ⋯ options popover being open suppresses the toggle', () => {
    const ctx = { ...idle, optionsVisible: true }
    expect(shouldToggleBarsOnTap(ctx)).toBe(false)
    expect(nextBarsVisible(false, ctx)).toBe(false)
  })
})

describe('buildInfoSubline', () => {
  test('kind + size, no page count', () => {
    expect(buildInfoSubline({ kindLabel: 'Markdown', sizeLabel: '440 B' })).toBe('Markdown · 440 B')
  })

  test('kind + size + multi-page count', () => {
    expect(buildInfoSubline({ kindLabel: 'PDF', sizeLabel: '88 KB', pageCount: 2 })).toBe('PDF · 88 KB · 2 pages')
  })

  test('a single-page document omits the page-count segment', () => {
    expect(buildInfoSubline({ kindLabel: 'PDF', sizeLabel: '12 KB', pageCount: 1 })).toBe('PDF · 12 KB')
  })

  test('an unknown (not yet loaded) page count omits the segment', () => {
    expect(buildInfoSubline({ kindLabel: 'PDF', sizeLabel: '12 KB', pageCount: null })).toBe('PDF · 12 KB')
  })

  test('a missing size label is omitted, not rendered as "· "', () => {
    expect(buildInfoSubline({ kindLabel: 'Folder', sizeLabel: null })).toBe('Folder')
  })
})

describe('formatShareStatus', () => {
  test('zero is "Not shared"', () => {
    expect(formatShareStatus(0)).toBe('Not shared')
  })

  test('null/undefined (not loaded yet) reads the same as zero', () => {
    expect(formatShareStatus(null)).toBe('Not shared')
    expect(formatShareStatus(undefined)).toBe('Not shared')
  })

  test('exactly one link is singular', () => {
    expect(formatShareStatus(1)).toBe('Shared · 1 link')
  })

  test('more than one link is plural', () => {
    expect(formatShareStatus(3)).toBe('Shared · 3 links')
  })
})

describe('resolveFolderLabel', () => {
  test('no parent id is always Home, regardless of a resolved name', () => {
    expect(resolveFolderLabel(null, 'Contracts')).toBe('Home')
    expect(resolveFolderLabel(undefined, null)).toBe('Home')
  })

  test('a parent id with a resolved name shows that name', () => {
    expect(resolveFolderLabel('folder-1', 'Contracts')).toBe('Contracts')
  })

  test('a parent id with no resolved name yet shows a loading placeholder', () => {
    expect(resolveFolderLabel('folder-1', null)).toBe('Loading…')
  })
})

describe('formatPdfPageCounter', () => {
  test('multiple pages formats "current / total"', () => {
    expect(formatPdfPageCounter(1, 2)).toBe('1 / 2')
    expect(formatPdfPageCounter(2, 2)).toBe('2 / 2')
  })

  test('a single-page document returns null (no pill)', () => {
    expect(formatPdfPageCounter(1, 1)).toBeNull()
  })

  test('an unknown total (0, not loaded yet) returns null', () => {
    expect(formatPdfPageCounter(1, 0)).toBeNull()
  })
})
