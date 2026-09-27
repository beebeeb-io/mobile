// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1587 — "+" → New file: the D3 picker's type table, the Text type's
// own-extension rules, the "+" menu table, default names and name checks.
// Pure module, no mocks needed.
import { describe, expect, test } from 'bun:test'
import {
  NEW_DOCUMENT_TYPES,
  NEW_FILE_ACTION_ID,
  NEW_FILE_TYPES,
  NewDocumentNameClashError,
  REFUSED_TEXT_EXTENSIONS,
  TEXT_EXTENSION_SUGGESTIONS,
  buildAddMenuActions,
  checkNewDocumentName,
  checkTextExtension,
  defaultNewDocumentBase,
  documentTypeForTile,
  foldName,
  initialDocumentContent,
  mimeTypeForTextExtension,
  normalizeExtension,
  tileAccessibilityLabel,
  tileIconLabel,
  uniqueFileName,
} from './new-document'

const txt = NEW_DOCUMENT_TYPES.txt
const md = NEW_DOCUMENT_TYPES.md
const tile = (id) => NEW_FILE_TYPES.find((t) => t.id === id)

describe('NEW_FILE_TYPES (the D3 picker)', () => {
  test('Markdown, Text, Word, Excel, PowerPoint — in that order', () => {
    expect(NEW_FILE_TYPES.map((t) => [t.id, t.name, t.ext])).toEqual([
      ['md', 'Markdown', 'md'],
      ['txt', 'Text', 'txt'],
      ['docx', 'Word', 'docx'],
      ['xlsx', 'Excel', 'xlsx'],
      ['pptx', 'PowerPoint', 'pptx'],
    ])
  })

  test('only Markdown and Text are live; the Office types are "soon"', () => {
    expect(NEW_FILE_TYPES.filter((t) => t.status === 'live').map((t) => t.id)).toEqual(['md', 'txt'])
    expect(NEW_FILE_TYPES.filter((t) => t.status === 'soon').map((t) => t.id)).toEqual(['docx', 'xlsx', 'pptx'])
  })

  test('Markdown is the one amber tile', () => {
    expect(NEW_FILE_TYPES.filter((t) => t.accent).map((t) => t.id)).toEqual(['md'])
  })

  test('no Publisher / Access tile (a "soon" we could not keep)', () => {
    const exts = NEW_FILE_TYPES.map((t) => t.ext)
    expect(exts).not.toContain('pub')
    expect(exts).not.toContain('accdb')
  })

  test('the icon carries the extension in capitals', () => {
    expect(NEW_FILE_TYPES.map(tileIconLabel)).toEqual(['MD', 'TXT', 'DOCX', 'XLSX', 'PPTX'])
  })

  test('VoiceOver labels: live = name + extension; soon says so in words', () => {
    expect(tileAccessibilityLabel(tile('md'))).toBe('Markdown, .md')
    expect(tileAccessibilityLabel(tile('txt'))).toBe('Text, .txt')
    expect(tileAccessibilityLabel(tile('docx'))).toBe('Word, .docx, coming soon, not available yet')
    expect(tileAccessibilityLabel(tile('xlsx'))).toBe('Excel, .xlsx, coming soon, not available yet')
    expect(tileAccessibilityLabel(tile('pptx'))).toBe('PowerPoint, .pptx, coming soon, not available yet')
  })

  test('a live tile maps to its creatable type; a soon tile to nothing (inert)', () => {
    expect(documentTypeForTile(tile('md'))).toBe(md)
    expect(documentTypeForTile(tile('txt'))).toBe(txt)
    for (const id of ['docx', 'xlsx', 'pptx']) expect(documentTypeForTile(tile(id))).toBeNull()
  })
})

describe('NEW_DOCUMENT_TYPES', () => {
  test('Markdown: fixed .md, "Untitled note", "Create note"', () => {
    expect(md).toMatchObject({ ext: 'md', defaultBase: 'Untitled note', extensionEditable: false, createLabel: 'Create note', stepTitle: 'Name your note' })
  })
  test('Text: editable extension defaulting to .txt, "Untitled", "Create file"', () => {
    expect(txt).toMatchObject({ ext: 'txt', defaultBase: 'Untitled', extensionEditable: true, createLabel: 'Create file', stepTitle: 'Name your text file' })
  })
})

describe('Text: your own extension', () => {
  test('the suggestion chips, in order', () => {
    expect(TEXT_EXTENSION_SUGGESTIONS).toEqual(['txt', 'py', 'js', 'json', 'sh', 'log', 'csv'])
  })

  test('every chip is an allowed extension', () => {
    for (const e of TEXT_EXTENSION_SUGGESTIONS) expect(checkTextExtension(e).ok).toBe(true)
  })

  test('normalises case, whitespace and leading dots', () => {
    expect(normalizeExtension('  .PY ')).toBe('py')
    expect(normalizeExtension('..json')).toBe('json')
    expect(checkTextExtension('.Py')).toEqual({ ok: true, ext: 'py', opensInEditor: true, note: null })
  })

  test('plain-text extensions are allowed and open in the editor', () => {
    for (const e of ['txt', 'py', 'js', 'json', 'sh', 'log', 'go', 'rs', 'yaml', 'toml', 'env', 'conf', 'md', 'xyz', 'my-ext', 'v2_notes']) {
      const r = checkTextExtension(e)
      expect(r.ok).toBe(true)
      expect(r.opensInEditor).toBe(true)
    }
  })

  test('Office extensions are refused with the Office reason', () => {
    for (const e of ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pub', 'accdb']) {
      expect(checkTextExtension(e)).toEqual({ ok: false, reason: `.${e} is an Office format, not plain text. Office files are coming soon.` })
    }
  })

  test('ODF extensions are refused with the LibreOffice reason', () => {
    for (const e of ['odt', 'ods', 'odp', 'odg']) {
      expect(checkTextExtension(e)).toEqual({ ok: false, reason: `.${e} is a LibreOffice format, not plain text.` })
    }
  })

  test('.pdf is refused', () => {
    expect(checkTextExtension('.PDF')).toEqual({ ok: false, reason: '.pdf is not plain text, so a text file cannot be one.' })
  })

  test('binary extensions are refused with the binary reason', () => {
    for (const e of ['zip', 'png', 'jpg', 'jpeg', 'heic', 'mp4', 'mov', 'mp3', 'gz', 'exe', 'dmg']) {
      expect(checkTextExtension(e)).toEqual({ ok: false, reason: `.${e} is a binary format, not plain text.` })
    }
  })

  test('the refused table covers the brief\'s list', () => {
    for (const e of ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'odg', 'pdf', 'zip', 'png', 'jpg', 'jpeg', 'heic', 'mp4', 'mov']) {
      expect(REFUSED_TEXT_EXTENSIONS[e]).toBeDefined()
    }
  })

  test('empty and malformed extensions are refused', () => {
    expect(checkTextExtension('')).toEqual({ ok: false, reason: 'Add an extension, like .txt.' })
    expect(checkTextExtension(' . ')).toEqual({ ok: false, reason: 'Add an extension, like .txt.' })
    for (const e of ['p y', 'a/b', 'tar.gz', 'é', 'x'.repeat(17)]) {
      expect(checkTextExtension(e)).toEqual({ ok: false, reason: 'An extension is letters and numbers only, like .py.' })
    }
  })

  test('.csv / .html / .svg are allowed but open in their own viewer, and say so', () => {
    expect(checkTextExtension('csv')).toEqual({ ok: true, ext: 'csv', opensInEditor: false, note: '.csv opens in the table view, not the editor, on iPhone.' })
    expect(checkTextExtension('html')).toMatchObject({ ok: true, opensInEditor: false })
    expect(checkTextExtension('svg')).toMatchObject({ ok: true, opensInEditor: false })
  })

  test('mime: a known code extension keeps its mime; anything else is text/plain', () => {
    expect(mimeTypeForTextExtension('py')).toBe('text/x-python')
    expect(mimeTypeForTextExtension('json')).toBe('application/json')
    expect(mimeTypeForTextExtension('txt')).toBe('text/plain')
    expect(mimeTypeForTextExtension('md')).toBe('text/markdown')
    expect(mimeTypeForTextExtension('xyz')).toBe('text/plain')
  })
})

describe('buildAddMenuActions (the "+" menu table)', () => {
  const actions = buildAddMenuActions('#123456')

  test('uploads first, then one inline "create" section', () => {
    expect(actions.map((a) => a.id)).toEqual(['photo', 'file', 'scan', 'create'])
    expect(actions[3].displayInline).toBe(true)
    expect(actions[3].title).toBe('')
  })

  test('the create section is ONE "New file" item, then New folder', () => {
    expect(actions[3].subactions.map((a) => [a.id, a.title, a.image])).toEqual([
      [NEW_FILE_ACTION_ID, 'New file', 'doc.badge.plus'],
      ['folder', 'New folder', 'folder.badge.plus'],
    ])
    expect(NEW_FILE_ACTION_ID).toBe('new-file')
  })

  test('the upload rows keep their titles (Maestro flows target rows by title)', () => {
    expect(actions.slice(0, 3).map((a) => a.title)).toEqual(['Upload photo or video', 'Upload file', 'Scan document'])
  })

  test('every row with a glyph sets imageColor (0791: omitted = transparent glyph)', () => {
    const rows = [...actions.slice(0, 3), ...actions[3].subactions]
    expect(rows).toHaveLength(5)
    for (const r of rows) {
      expect(r.image).toBeTruthy()
      expect(r.imageColor).toBe('#123456')
    }
  })
})

describe('foldName', () => {
  test('is a locale-independent lower-case fold', () => {
    expect(foldName('TITLE.MD')).toBe('title.md')
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
  })
  test('a name without an extension gets the suffix at the end; a dot-file has no extension', () => {
    expect(uniqueFileName('README', ['readme'])).toBe('README 2')
    expect(uniqueFileName('.env', ['.env'])).toBe('.env 2')
  })
})

describe('defaultNewDocumentBase', () => {
  test('empty folder: "Untitled" (.txt) and "Untitled note" (.md)', () => {
    expect(defaultNewDocumentBase(txt, [])).toBe('Untitled')
    expect(defaultNewDocumentBase(md, [])).toBe('Untitled note')
  })
  test('takes the first free number when the defaults exist', () => {
    expect(defaultNewDocumentBase(txt, ['untitled.txt'])).toBe('Untitled 2')
    expect(defaultNewDocumentBase(md, ['Untitled note.md', 'Untitled note 2.md'])).toBe('Untitled note 3')
  })
})

describe('checkNewDocumentName', () => {
  test('Markdown: always .md, trims, does not double a typed .md', () => {
    expect(checkNewDocumentName('  Groceries  ', 'ignored', md, [])).toEqual({ ok: true, name: 'Groceries.md', opensInEditor: true, mimeType: 'text/markdown' })
    expect(checkNewDocumentName('Notes.MD', '', md, [])).toMatchObject({ ok: true, name: 'Notes.md' })
    expect(checkNewDocumentName('notes.txt', '', md, [])).toMatchObject({ ok: true, name: 'notes.txt.md' })
  })

  test('Text: the extension segment decides the name and the mime', () => {
    expect(checkNewDocumentName('deploy-notes', '.py', txt, [])).toEqual({ ok: true, name: 'deploy-notes.py', opensInEditor: true, mimeType: 'text/x-python' })
    expect(checkNewDocumentName('todo', 'txt', txt, [])).toMatchObject({ ok: true, name: 'todo.txt', mimeType: 'text/plain' })
    expect(checkNewDocumentName('data', 'csv', txt, [])).toMatchObject({ ok: true, name: 'data.csv', opensInEditor: false })
  })

  test('Text: a refused extension fails on the extension field', () => {
    expect(checkNewDocumentName('report', '.docx', txt, [])).toEqual({
      ok: false,
      field: 'extension',
      reason: '.docx is an Office format, not plain text. Office files are coming soon.',
    })
  })

  test('refuses an empty name, or the bare extension', () => {
    expect(checkNewDocumentName('   ', 'txt', txt, [])).toEqual({ ok: false, reason: 'Give the file a name.', field: 'name' })
    expect(checkNewDocumentName('.md', '', md, [])).toEqual({ ok: false, reason: 'Give the file a name.', field: 'name' })
  })

  test('refuses a slash or backslash', () => {
    expect(checkNewDocumentName('a/b', 'txt', txt, [])).toEqual({ ok: false, reason: 'A name cannot contain / or \\.', field: 'name' })
    expect(checkNewDocumentName('a\\b', 'txt', txt, [])).toEqual({ ok: false, reason: 'A name cannot contain / or \\.', field: 'name' })
  })

  test('refuses a case-insensitive clash, never silently renames', () => {
    expect(checkNewDocumentName('groceries', '', md, ['Groceries.md'])).toEqual({
      ok: false,
      reason: '“groceries.md” already exists in this folder.',
      field: 'name',
    })
    expect(checkNewDocumentName('Deploy', 'PY', txt, ['deploy.py'])).toMatchObject({ ok: false, field: 'name' })
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
  })
  test('text (any extension) starts as one empty line; never 0 bytes', () => {
    expect(initialDocumentContent(txt, 'todo.txt')).toBe('\n')
    expect(initialDocumentContent(txt, 'deploy-notes.py')).toBe('\n')
    for (const t of [md, txt]) expect(initialDocumentContent(t, `x.${t.ext}`).length).toBeGreaterThan(0)
  })
})
