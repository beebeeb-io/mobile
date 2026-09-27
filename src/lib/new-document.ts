/**
 * Task 1587 — iOS "+" → New file: the type picker, the name step's rules,
 * and the "+" menu table.
 *
 * Guus's pick (2026-09-27): one "New file" item in the + menu opens the
 * shared BottomSheet with a D3 "icon wells" grid — Markdown and Text are
 * live, Word / Excel / PowerPoint are shown as "Soon" and are inert. A Text
 * file takes any extension the user types (like renaming on macOS/Windows),
 * EXCEPT Office / ODF / binary ones: the file is plain text, and naming it
 * `.docx` would only produce a file nothing can open. Markdown stays `.md`.
 *
 * The name/uniqueness rules are ported from web's `src/lib/new-document.ts`
 * (task 1582), not imported — the web repo is not a dependency of this one.
 *
 * Pure: no React Native, no network, no crypto, so it is unit-tested in
 * isolation (new-document.test.ts). The impure half — writing the starter
 * file, the encrypted upload, opening the editor — lives in FilesScreen.
 */

import { TEXT_EXTENSION_MIME, isTextPreview } from './code-text-preview'

// ─── The picker's type table ─────────────────────────────────────────────────

export type NewFileTypeId = 'md' | 'txt' | 'docx' | 'xlsx' | 'pptx'

export interface NewFileTypeTile {
  id: NewFileTypeId
  /** The name under the well, as users know it ("Word", not "Writer"). */
  name: string
  /** Extension, lowercase, no dot. */
  ext: string
  /** `live` opens the name step; `soon` is shown but inert. */
  status: 'live' | 'soon'
  /** The one amber tile (Markdown) — the design's primary choice. */
  accent: boolean
}

/** In display order: 4 across, so Markdown/Text/Word/Excel on row one and
 *  PowerPoint alone on row two. Publisher / Access are deliberately absent:
 *  LibreOffice can neither save .pub nor open .accdb, so "coming soon" would
 *  be a promise we cannot keep. */
export const NEW_FILE_TYPES: readonly NewFileTypeTile[] = [
  { id: 'md', name: 'Markdown', ext: 'md', status: 'live', accent: true },
  { id: 'txt', name: 'Text', ext: 'txt', status: 'live', accent: false },
  { id: 'docx', name: 'Word', ext: 'docx', status: 'soon', accent: false },
  { id: 'xlsx', name: 'Excel', ext: 'xlsx', status: 'soon', accent: false },
  { id: 'pptx', name: 'PowerPoint', ext: 'pptx', status: 'soon', accent: false },
]

/** What sits inside the outline document icon: the extension, uppercase. */
export function tileIconLabel(t: NewFileTypeTile): string {
  return t.ext.toUpperCase()
}

/** VoiceOver label for a tile. "Soon" tiles say it in words, because the
 *  visual cue (the faded well) is not available to a VoiceOver user. */
export function tileAccessibilityLabel(t: NewFileTypeTile): string {
  return t.status === 'soon'
    ? `${t.name}, .${t.ext}, coming soon, not available yet`
    : `${t.name}, .${t.ext}`
}

// ─── The two types that can be created today ─────────────────────────────────

export interface NewDocumentType {
  id: 'md' | 'txt'
  /** Default extension, lowercase, no dot. */
  ext: string
  /** Default name before the extension. */
  defaultBase: string
  /** Text: the extension is its own editable segment. Markdown: fixed. */
  extensionEditable: boolean
  /** The name step's title. */
  stepTitle: string
  /** The primary button. */
  createLabel: string
}

export const NEW_DOCUMENT_TYPES: Readonly<Record<'md' | 'txt', NewDocumentType>> = {
  md: {
    id: 'md',
    ext: 'md',
    defaultBase: 'Untitled note',
    extensionEditable: false,
    stepTitle: 'Name your note',
    createLabel: 'Create note',
  },
  txt: {
    id: 'txt',
    ext: 'txt',
    defaultBase: 'Untitled',
    extensionEditable: true,
    stepTitle: 'Name your text file',
    createLabel: 'Create file',
  },
}

/** The creatable type behind a tile; null for a "soon" tile (inert). */
export function documentTypeForTile(t: NewFileTypeTile): NewDocumentType | null {
  if (t.status !== 'live') return null
  return t.id === 'md' || t.id === 'txt' ? NEW_DOCUMENT_TYPES[t.id] : null
}

// ─── Text: your own extension ────────────────────────────────────────────────

/** The suggestion chips under the extension segment, in order. */
export const TEXT_EXTENSION_SUGGESTIONS: readonly string[] = ['txt', 'py', 'js', 'json', 'sh', 'log', 'csv']

type RefusedKind = 'office' | 'odf' | 'pdf' | 'binary'

/**
 * Extensions a plain-text file may not take: the name would claim a format
 * the bytes are not, and every viewer (ours included) would then fail to
 * open it. Office and ODF get their own reason (they are "coming soon" as
 * real types); the rest are binary containers.
 */
export const REFUSED_TEXT_EXTENSIONS: Readonly<Record<string, RefusedKind>> = {
  // Microsoft Office (modern + legacy + templates/macro variants)
  docx: 'office', doc: 'office', docm: 'office', dotx: 'office', dot: 'office',
  xlsx: 'office', xls: 'office', xlsm: 'office', xltx: 'office', xlsb: 'office',
  pptx: 'office', ppt: 'office', pptm: 'office', potx: 'office', ppsx: 'office',
  pub: 'office', accdb: 'office', mdb: 'office', one: 'office', vsdx: 'office',
  pages: 'office', numbers: 'office', key: 'office',
  // OpenDocument / LibreOffice
  odt: 'odf', ods: 'odf', odp: 'odf', odg: 'odf', odf: 'odf', odb: 'odf', ott: 'odf',
  // PDF
  pdf: 'pdf',
  // Images
  png: 'binary', jpg: 'binary', jpeg: 'binary', heic: 'binary', heif: 'binary', gif: 'binary',
  webp: 'binary', bmp: 'binary', tif: 'binary', tiff: 'binary', ico: 'binary', dng: 'binary',
  raw: 'binary', cr2: 'binary', cr3: 'binary', nef: 'binary', arw: 'binary', psd: 'binary',
  // Video / audio
  mp4: 'binary', mov: 'binary', m4v: 'binary', avi: 'binary', mkv: 'binary', webm: 'binary',
  mp3: 'binary', m4a: 'binary', aac: 'binary', wav: 'binary', flac: 'binary', ogg: 'binary',
  // Archives / disk images / executables
  zip: 'binary', gz: 'binary', tgz: 'binary', tar: 'binary', rar: 'binary', '7z': 'binary',
  bz2: 'binary', xz: 'binary', dmg: 'binary', iso: 'binary', exe: 'binary', dll: 'binary',
  app: 'binary', apk: 'binary', ipa: 'binary', bin: 'binary', so: 'binary', dylib: 'binary',
  // Other binary document formats
  epub: 'binary', sqlite: 'binary', db: 'binary',
}

/**
 * Plain-text extensions that the preview routes to ANOTHER viewer (a table,
 * a web view, an image) instead of the text editor — see PreviewScreen's
 * `fileCategory`. Allowed (the file is honest plain text), but the name step
 * says it will not open in the editor, and the flow opens the viewer.
 */
export const TEXT_EXTENSIONS_OPEN_ELSEWHERE: Readonly<Record<string, string>> = {
  csv: 'the table view',
  tsv: 'the table view',
  html: 'the web view',
  htm: 'the web view',
  svg: 'the image view',
}

/** Letters, digits, `-`, `_`; 1–16 characters (after dropping one leading dot). */
const EXTENSION_SHAPE = /^[a-z0-9_-]{1,16}$/

export type ExtensionCheck =
  | { ok: true; ext: string; opensInEditor: boolean; note: string | null }
  | { ok: false; reason: string }

/** Lowercases, trims and drops leading dots (".PY" → "py"). */
export function normalizeExtension(input: string): string {
  return input.trim().replace(/^\.+/, '').toLowerCase()
}

/**
 * The Text type's extension rule. Anything plain-text-shaped is allowed;
 * Office / ODF / PDF / binary extensions are refused with a one-line reason.
 */
export function checkTextExtension(input: string): ExtensionCheck {
  const ext = normalizeExtension(input)
  if (!ext) return { ok: false, reason: 'Add an extension, like .txt.' }
  if (!EXTENSION_SHAPE.test(ext)) {
    return { ok: false, reason: 'An extension is letters and numbers only, like .py.' }
  }
  const refused = REFUSED_TEXT_EXTENSIONS[ext]
  if (refused === 'office') {
    return { ok: false, reason: `.${ext} is an Office format, not plain text. Office files are coming soon.` }
  }
  if (refused === 'odf') {
    return { ok: false, reason: `.${ext} is a LibreOffice format, not plain text.` }
  }
  if (refused === 'pdf') {
    return { ok: false, reason: '.pdf is not plain text, so a text file cannot be one.' }
  }
  if (refused === 'binary') {
    return { ok: false, reason: `.${ext} is a binary format, not plain text.` }
  }
  const elsewhere = TEXT_EXTENSIONS_OPEN_ELSEWHERE[ext]
  if (elsewhere) {
    return { ok: true, ext, opensInEditor: false, note: `.${ext} opens in ${elsewhere}, not the editor, on iPhone.` }
  }
  return { ok: true, ext, opensInEditor: true, note: null }
}

/**
 * The mime type stored (encrypted) with the new file. A known text/code
 * extension keeps its own mime (so .py highlights as Python) as long as the
 * preview still classes it as text; anything else is `text/plain`, which the
 * preview always opens as editable text.
 */
export function mimeTypeForTextExtension(ext: string): string {
  const e = normalizeExtension(ext)
  if (e === 'md') return 'text/markdown'
  const known = TEXT_EXTENSION_MIME[e]
  if (known && isTextPreview(known, `x.${e}`)) return known
  return 'text/plain'
}

// ─── "+" menu table ──────────────────────────────────────────────────────────

/** Structural subset of @react-native-menu/menu's MenuAction (kept local so
 *  this module stays importable without the native package). */
export interface AddMenuAction {
  id: string
  title: string
  image?: string
  imageColor?: string
  displayInline?: boolean
  subactions?: AddMenuAction[]
}

export const NEW_FILE_ACTION_ID = 'new-file'

/**
 * The FilesScreen "+" menu, in order. Uploads first; then one inline section
 * (a native divider, not a submenu) for the things you CREATE here: a file,
 * a folder.
 *
 * `imageColor` is always set (0791: Fabric forwards an omitted imageColor as
 * 0 = fully transparent, so the glyph would render blank).
 */
export function buildAddMenuActions(imageColor: string): AddMenuAction[] {
  return [
    { id: 'photo', title: 'Upload photo or video', image: 'photo.on.rectangle', imageColor },
    { id: 'file', title: 'Upload file', image: 'doc', imageColor },
    { id: 'scan', title: 'Scan document', image: 'doc.viewfinder', imageColor },
    {
      id: 'create',
      title: '',
      displayInline: true,
      subactions: [
        { id: NEW_FILE_ACTION_ID, title: 'New file', image: 'doc.badge.plus', imageColor },
        { id: 'folder', title: 'New folder', image: 'folder.badge.plus', imageColor },
      ],
    },
  ]
}

// ─── Initial content ─────────────────────────────────────────────────────────

/**
 * The bytes a new file starts with. Never empty: the preview decrypt path
 * (native `downloadAndDecryptFileNative` and the JS fallback alike) refuses a
 * 0-byte plaintext ("Invalid download size metadata"), so an empty file could
 * be created but not opened — found on bb-qa-2 while verifying 1587; the
 * empty-file decrypt gap is tracked separately rather than patched in the
 * native module here.
 *
 *   - Markdown: a level-1 heading from the name ("Groceries.md" → "# Groceries"),
 *     then a blank line — the note is titled and ready to type under.
 *   - Text (any extension): one newline, i.e. a single empty line.
 */
export function initialDocumentContent(type: NewDocumentType, fileName: string): string {
  if (type.id === 'md') {
    const suffix = '.md'
    const base = foldName(fileName).endsWith(suffix) ? fileName.slice(0, -suffix.length) : fileName
    const title = base.trim()
    return title ? `# ${title}\n\n` : '\n'
  }
  return '\n'
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** Locale-independent case fold for name comparisons (`toLocaleLowerCase`
 *  under a Turkish locale maps "I" to dotless "ı" and would let "TITLE.md"
 *  and "title.md" coexist — web PR #117 review). */
export function foldName(name: string): string {
  return name.toLowerCase()
}

function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

/**
 * `desired` if no sibling has that name, otherwise the first free
 * "<base> 2<.ext>", "<base> 3<.ext>", … Case-insensitive, like the file
 * systems these files sync to (APFS, NTFS), so "Untitled.txt" and
 * "untitled.txt" never end up side by side after a sync.
 */
export function uniqueFileName(desired: string, existingNames: Iterable<string>): string {
  const taken = new Set<string>()
  for (const n of existingNames) taken.add(foldName(n))
  if (!taken.has(foldName(desired))) return desired
  const { base, ext } = splitExt(desired)
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}${ext}`
    if (!taken.has(foldName(candidate))) return candidate
  }
}

/** The pre-filled base name in the name step: `<base>.<ext>` is unique in
 *  the current folder ("Untitled", then "Untitled 2", …). */
export function defaultNewDocumentBase(type: NewDocumentType, existingNames: Iterable<string>): string {
  const full = uniqueFileName(`${type.defaultBase}.${type.ext}`, existingNames)
  return full.slice(0, -(type.ext.length + 1))
}

/** The user-facing clash message (web 1582's wording). */
export function nameClashMessage(name: string): string {
  return `“${name}” already exists in this folder.`
}

/** Thrown by the create handler when the FRESH listing already holds the
 *  name; its message is user-facing and shown as-is in the name step. */
export class NewDocumentNameClashError extends Error {
  constructor(name: string) {
    super(nameClashMessage(name))
    this.name = 'NewDocumentNameClashError'
  }
}

export type NameCheck =
  | { ok: true; name: string; opensInEditor: boolean; mimeType: string }
  | { ok: false; reason: string; field: 'name' | 'extension' }

/**
 * Builds and checks the final file name from the name step's two parts.
 *
 *  - Markdown: the extension is always `.md`; a typed trailing ".md" on the
 *    base is not doubled ("Groceries.md" → "Groceries.md").
 *  - Text: `extInput` is the editable segment, checked by `checkTextExtension`.
 *
 * It does NOT silently rename on a clash: the step shows the reason and lets
 * the user choose. A silent "Groceries 2.md" is a surprise the user would
 * only discover in the file list.
 */
export function checkNewDocumentName(
  baseInput: string,
  extInput: string,
  type: NewDocumentType,
  existingNames: Iterable<string>,
): NameCheck {
  let base = baseInput.trim()
  let ext = type.ext
  let opensInEditor = true
  if (type.extensionEditable) {
    const e = checkTextExtension(extInput)
    if (!e.ok) return { ok: false, reason: e.reason, field: 'extension' }
    ext = e.ext
    opensInEditor = e.opensInEditor
  } else if (foldName(base).endsWith(`.${ext}`)) {
    base = base.slice(0, -(ext.length + 1)).trim()
  }
  if (!base) return { ok: false, reason: 'Give the file a name.', field: 'name' }
  if (/[/\\]/.test(base)) return { ok: false, reason: 'A name cannot contain / or \\.', field: 'name' }
  const name = `${base}.${ext}`
  for (const n of existingNames) {
    if (foldName(n) === foldName(name)) return { ok: false, reason: nameClashMessage(name), field: 'name' }
  }
  return {
    ok: true,
    name,
    opensInEditor,
    mimeType: type.id === 'md' ? 'text/markdown' : mimeTypeForTextExtension(ext),
  }
}
