// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1563 — the pure save/conflict decision logic. Zero react-native /
// api.ts dependency (by design — see the module doc comment), so no mocking
// is needed to test it.
import { describe, expect, test } from 'bun:test'
import {
  buildKeepBothName,
  decideAfterConflictChoice,
  decideAfterSaveAttempt,
} from './text-save-decision'

describe('buildKeepBothName', () => {
  test('inserts "(edited on <device>)" before the extension', () => {
    expect(buildKeepBothName('notes.md', 'iPhone')).toBe('notes (edited on iPhone).md')
  })

  test('handles a multi-dot filename by splitting on the LAST dot only', () => {
    expect(buildKeepBothName('archive.tar.gz', 'iPhone')).toBe('archive.tar (edited on iPhone).gz')
  })

  test('a file with no extension gets the suffix appended with no dangling dot', () => {
    expect(buildKeepBothName('README', 'iPhone')).toBe('README (edited on iPhone)')
  })

  test('a dotfile with no real extension (leading dot only) is treated as having no extension', () => {
    expect(buildKeepBothName('.gitignore', 'iPhone')).toBe('.gitignore (edited on iPhone)')
  })

  test('a trailing dot with nothing after it is treated as no extension (never produces a bare trailing dot)', () => {
    expect(buildKeepBothName('weird.', 'iPhone')).toBe('weird. (edited on iPhone)')
  })
})

describe('decideAfterSaveAttempt', () => {
  test('success -> done (no dialog)', () => {
    expect(decideAfterSaveAttempt({ kind: 'success' })).toEqual({ action: 'done' })
  })

  test('conflict -> show the conflict dialog, never a silent overwrite', () => {
    expect(decideAfterSaveAttempt({ kind: 'conflict' })).toEqual({ action: 'show-conflict-dialog' })
  })

  test('a non-conflict error -> show-error, not silently swallowed', () => {
    expect(decideAfterSaveAttempt({ kind: 'error' })).toEqual({ action: 'show-error' })
  })
})

describe('decideAfterConflictChoice', () => {
  test('keep-both -> retry as a new (suffixed) file', () => {
    expect(decideAfterConflictChoice('keep-both')).toEqual({ action: 'retry-as-keep-both' })
  })

  test('new-version -> retry the version-replace against the fresh base', () => {
    expect(decideAfterConflictChoice('new-version')).toEqual({ action: 'retry-as-new-version' })
  })

  test('discard -> close the editor, drop local changes', () => {
    expect(decideAfterConflictChoice('discard')).toEqual({ action: 'discard-and-close' })
  })

  test('cancel -> stay in the editor, nothing happens (dirty state untouched)', () => {
    expect(decideAfterConflictChoice('cancel')).toEqual({ action: 'stay-in-editor' })
  })
})
