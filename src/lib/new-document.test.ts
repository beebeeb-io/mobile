// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1587 — the "+" menu's New text file / New Markdown note: type table,
// menu table, default names and name checks. Pure module, no mocks needed.
import { describe, expect, test } from 'bun:test'
import {
  NEW_DOCUMENT_TYPES,
  NewDocumentNameClashError,
  buildAddMenuActions,
  checkNewDocumentName,
  defaultNewDocumentName,
  foldName,
  getNewDocumentType,
  initialDocumentContent,
  newDocumentActionId,
  newDocumentTypeForAction,
  uniqueFileName,
} from './new-document'

const txt = getNewDocumentType('txt')
const md = getNewDocumentType('md')

describe('NEW_DOCUMENT_TYPES', () => {
  test('offers exactly the two types the phone can edit today, text then Markdown', () => {
    expect(NEW_DOCUMENT_TYPES.map((t) => t.id)).toEqual(['txt', 'md'])
  })

  test('each type carries the extension, mime and SF Symbol the flow relies on', () => {
    expect(txt).toMatchObject({ ext: 'txt', mimeType: 'text/plain', sfSymbol: 'doc.text', title: 'New text file' })
    expect(md).toMatchObject({ ext: 'md', mimeType: 'text/markdown', sfSymbol: 'doc.richtext', title: 'New Markdown note' })
  })

  test('getNewDocumentType throws on an unknown id', () => {
    expect(() => getNewDocumentType('docx')).toThrow('unknown new-document type')
  })

  test('action ids round-trip, and other menu ids are not new-document actions', () => {
    expect(newDocumentActionId(txt)).toBe('new-txt')
    expect(newDocumentActionId(md)).toBe('new-md')
    expect(newDocumentTypeForAction('new-txt')).toBe(txt)
    expect(newDocumentTypeForAction('new-md')).toBe(md)
    for (const other of ['photo', 'file', 'scan', 'folder', 'create', 'new-docx', '']) {
      expect(newDocumentTypeForAction(other)).toBeNull()
    }
  })
})

describe('buildAddMenuActions (the "+" menu table)', () => {
  const actions = buildAddMenuActions('#123456')

  test('uploads first, then one inline "create" section', () => {
    expect(actions.map((a) => a.id)).toEqual(['photo', 'file', 'scan', 'create'])
    const create = actions[3]
    expect(create.displayInline).toBe(true)
    expect(create.title).toBe('')
  })

  test('the create section is New folder, New text file, New Markdown note — in that order', () => {
    const rows = actions[3].subactions
    expect(rows.map((a) => [a.id, a.title, a.image])).toEqual([
      ['folder', 'New folder', 'folder.badge.plus'],
      ['new-txt', 'New text file', 'doc.text'],
      ['new-md', 'New Markdown note', 'doc.richtext'],
    ])
  })

  test('the upload rows keep their titles (Maestro flows target rows by title)', () => {
    expect(actions.slice(0, 3).map((a) => a.title)).toEqual([
      'Upload photo or video',
      'Upload file',
      'Scan document',
    ])
  })

  test('every row with a glyph sets imageColor (0791: omitted = transparent glyph)', () => {
    const rows = [...actions.slice(0, 3), ...actions[3].subactions]
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      expect(r.image).toBeTruthy()
      expect(r.imageColor).toBe('#123456')
    }
  })
})

describe('foldName', () => {
  test('is a locale-independent lower-case fold', () => {
    expect(foldName('TITLE.MD')).toBe('title.md')
    expect(foldName('Untitled Note.md')).toBe('untitled note.md')
  })
})

describe('uniqueFileName', () => {
  test('returns the desired name when it is free', () => {
    expect(uniqueFileName('Untitled.txt', ['Other.txt'])).toBe('Untitled.txt')
  })

  test('appends " 2", then " 3", before the extension', () => {
    expect(uniqueFileName('Untitled.txt', ['Untitled.txt'])).toBe('Untitled 2.txt')
    expect(uniqueFileName('Untitled.txt', ['Untitled.txt', 'Untitled 2.txt'])).toBe('Untitled 3.txt')
  })

  test('is case-insensitive against siblings', () => {
    expect(uniqueFileName('Untitled note.md', ['UNTITLED NOTE.MD'])).toBe('Untitled note 2.md')
    expect(uniqueFileName('Untitled note.md', ['untitled note.md', 'Untitled Note 2.md'])).toBe('Untitled note 3.md')
  })

  test('a name without an extension gets the suffix at the end', () => {
    expect(uniqueFileName('README', ['readme'])).toBe('README 2')
  })

  test('a dot-file is treated as having no extension', () => {
    expect(uniqueFileName('.env', ['.env'])).toBe('.env 2')
  })
})

describe('defaultNewDocumentName', () => {
  test('empty folder: "Untitled.txt" and "Untitled note.md"', () => {
    expect(defaultNewDocumentName(txt, [])).toBe('Untitled.txt')
    expect(defaultNewDocumentName(md, [])).toBe('Untitled note.md')
  })

  test('takes the first free number when the defaults exist (folders count too)', () => {
    expect(defaultNewDocumentName(txt, ['untitled.txt'])).toBe('Untitled 2.txt')
    expect(defaultNewDocumentName(md, ['Untitled note.md', 'Untitled note 2.md'])).toBe('Untitled note 3.md')
  })
})

describe('checkNewDocumentName', () => {
  test('appends the extension when missing, trims whitespace', () => {
    expect(checkNewDocumentName('  Groceries  ', md, [])).toEqual({ ok: true, name: 'Groceries.md' })
    expect(checkNewDocumentName('todo', txt, [])).toEqual({ ok: true, name: 'todo.txt' })
  })

  test('keeps a name that already ends in the extension, in any case', () => {
    expect(checkNewDocumentName('Notes.MD', md, [])).toEqual({ ok: true, name: 'Notes.MD' })
    expect(checkNewDocumentName('a.txt', txt, [])).toEqual({ ok: true, name: 'a.txt' })
  })

  test('a different extension is kept and the type extension appended', () => {
    expect(checkNewDocumentName('notes.txt', md, [])).toEqual({ ok: true, name: 'notes.txt.md' })
  })

  test('refuses an empty name, or the bare extension', () => {
    expect(checkNewDocumentName('   ', txt, [])).toEqual({ ok: false, reason: 'Give the file a name.' })
    expect(checkNewDocumentName('.md', md, [])).toEqual({ ok: false, reason: 'Give the file a name.' })
  })

  test('refuses a slash or backslash', () => {
    expect(checkNewDocumentName('a/b', txt, [])).toEqual({ ok: false, reason: 'A name cannot contain / or \\.' })
    expect(checkNewDocumentName('a\\b', txt, [])).toEqual({ ok: false, reason: 'A name cannot contain / or \\.' })
  })

  test('refuses a case-insensitive clash, never silently renames', () => {
    expect(checkNewDocumentName('groceries', md, ['Groceries.md'])).toEqual({
      ok: false,
      reason: '“groceries.md” already exists in this folder.',
    })
  })
})

describe('NewDocumentNameClashError', () => {
  test('carries the user-facing message', () => {
    const e = new NewDocumentNameClashError('a.md')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('NewDocumentNameClashError')
    expect(e.message).toBe('“a.md” already exists in this folder.')
  })
})

describe('initialDocumentContent', () => {
  test('Markdown starts with the name as a level-1 heading and a blank line', () => {
    expect(initialDocumentContent(md, 'Groceries 1587.md')).toBe('# Groceries 1587\n\n')
    expect(initialDocumentContent(md, 'Notes.MD')).toBe('# Notes\n\n')
  })

  test('text starts as one empty line; never 0 bytes for any type', () => {
    expect(initialDocumentContent(txt, 'todo.txt')).toBe('\n')
    for (const t of NEW_DOCUMENT_TYPES) {
      expect(initialDocumentContent(t, `x.${t.ext}`).length).toBeGreaterThan(0)
    }
  })
})
