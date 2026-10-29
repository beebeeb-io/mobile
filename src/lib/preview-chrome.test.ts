// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 (preview redesign) — pure chrome helpers. No react-native
// dependency, no module mocking needed.
import { describe, expect, test } from 'bun:test'
import {
  buildInfoSubline,
  formatPdfPageCounter,
  formatShareStatus,
  nextBarsVisible,
  pagerTapAction,
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

// ---------------------------------------------------------------------------
// Task 1687a — which action a tap on a locked pager page takes. The vault
// lock (useCrypto().isUnlocked === false) and the per-file Face ID gate are
// DIFFERENT locks and must never collapse into one affordance: the file
// lock owns the "tap to authenticate" prompt, the vault lock only gets a
// reliable chrome-toggle surface (no auth step — task 1684 owns the unlock
// flow). Mutation evidence in task 1687 Notes: with the vaultLocked branch
// removed (pre-fix shape, where vault-locked pages had NO tap affordance
// beyond the pager's 10 pt / 500 ms raw detector) the vault cases fail.
// ---------------------------------------------------------------------------
describe('pagerTapAction (task 1687a)', () => {
  const base = { fileLocked: false, vaultLocked: false, contentOwned: false }

  test('a file-locked page taps to authenticate — the lock affordance is hittable', () => {
    expect(pagerTapAction({ ...base, fileLocked: true })).toBe('unlock-file')
    // File lock wins even when the vault is also locked: one prompt, the
    // file-level one the user can act on here.
    expect(pagerTapAction({ ...base, fileLocked: true, vaultLocked: true })).toBe('unlock-file')
  })

  test('a VAULT-locked (not file-locked) page taps to toggle chrome', () => {
    expect(pagerTapAction({ ...base, vaultLocked: true })).toBe('toggle-chrome')
  })

  test('a page with interactive content yields the tap to it', () => {
    expect(pagerTapAction({ ...base, contentOwned: true })).toBeNull()
  })

  test('a plain unlocked page (loading/thumbnail) toggles chrome', () => {
    expect(pagerTapAction(base)).toBe('toggle-chrome')
  })
})
