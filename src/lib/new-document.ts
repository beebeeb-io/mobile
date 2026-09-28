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
import { fileCategory, type Category } from './file-category'

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

/** The label's advance per character, as a fraction of the font size —
 *  MEASURED, not the font's nominal 0.6: on the first build's simulator
 *  screenshot "DOCX" at 6.35pt spanned ~20pt, i.e. ~0.79 em per character.
 *  0.8 is the conservative value the fit test uses. */
export const ICON_LABEL_ADVANCE_EM = 0.8

/** Clear space kept between the label and the outline's stroke, in
 *  viewBox units (×iconWidth/30). */
export const ICON_LABEL_MARGIN_UNITS = 1.5

/**
 * Size + inset of the extension printed inside the outline document icon,
 * for an icon `iconWidth` wide (the mock's 30-unit viewBox; the document
 * body is 22 units wide with a 1.5-unit stroke). Four letters ("DOCX") get a
 * smaller size and no tracking, and the text box is inset
 * ICON_LABEL_MARGIN_UNITS from each stroke, so the label never touches the outline (Guus's screenshot of
 * the first build: "DOCX" ran edge to edge).
 */
export function docIconLabelMetrics(iconWidth: number, label: string): {
  fontSize: number
  letterSpacing: number
  /** Distance from the document's outer left/right edge to the text box. */
  inset: number
  /** Width the text box has between the insets. */
  boxWidth: number
} {
  const s = iconWidth / 30
  const stroke = Math.max(1, 1.5 * s)
  const inset = stroke + ICON_LABEL_MARGIN_UNITS * s
  const fontSize = (label.length >= 4 ? 4.3 : label.length === 3 ? 5.4 : 7.2) * s
  const letterSpacing = label.length >= 4 ? 0 : 0.2
  return { fontSize, letterSpacing, inset, boxWidth: 22 * s - 2 * inset }
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

type RefusedKind = 'office' | 'iwork' | 'odf' | 'pdf' | 'binary'

/**
 * Extensions a plain-text file may not take, on top of what the preview's
 * routing already rules out (see `checkTextExtension`): the name would claim
 * a format the bytes are not, and other apps would then mis-handle the file.
 * Office and ODF get their own reason (Office is "coming soon" as real
 * types); Apple iWork its own ("not supported yet"); the rest are binary
 * containers. `.key` is deliberately NOT here: it is also the usual
 * extension of a plain-text PEM private key (task 1587 review).
 */
export const REFUSED_TEXT_EXTENSIONS: Readonly<Record<string, RefusedKind>> = {
  // Microsoft Office — modern, legacy, templates, macro-enabled, add-ins, shows
  docx: 'office', doc: 'office', docm: 'office', dotx: 'office', dotm: 'office', dot: 'office',
  xlsx: 'office', xls: 'office', xlsm: 'office', xlsb: 'office', xltx: 'office', xltm: 'office',
  xlt: 'office', xlam: 'office', xla: 'office',
  pptx: 'office', ppt: 'office', pptm: 'office', potx: 'office', potm: 'office', pot: 'office',
  ppsx: 'office', ppsm: 'office', pps: 'office', ppam: 'office', ppa: 'office',
  pub: 'office', accdb: 'office', mdb: 'office', one: 'office', vsdx: 'office', vsd: 'office',
  vsdm: 'office', vstx: 'office', vstm: 'office', vss: 'office', vst: 'office', mpp: 'office',
  // Apple iWork (Keynote's `.key` is allowed — see above)
  pages: 'iwork', numbers: 'iwork',
  // OpenDocument / LibreOffice (documents + templates)
  odt: 'odf', ods: 'odf', odp: 'odf', odg: 'odf', odf: 'odf', odb: 'odf', odc: 'odf', odm: 'odf',
  ott: 'odf', ots: 'odf', otp: 'odf', otg: 'odf',
  // PDF
  pdf: 'pdf',
  // Images (the preview's own image/RAW lists are refused by routing too)
  png: 'binary', jpg: 'binary', jpeg: 'binary', heic: 'binary', heif: 'binary', gif: 'binary',
  webp: 'binary', avif: 'binary', jxl: 'binary', jp2: 'binary', bmp: 'binary', tif: 'binary',
  tiff: 'binary', ico: 'binary', icns: 'binary', dng: 'binary', raw: 'binary', cr2: 'binary',
  cr3: 'binary', nef: 'binary', arw: 'binary', raf: 'binary', orf: 'binary', rw2: 'binary',
  psd: 'binary', ai: 'binary', sketch: 'binary', xcf: 'binary',
  // Video / audio
  mp4: 'binary', mov: 'binary', m4v: 'binary', avi: 'binary', mkv: 'binary', webm: 'binary',
  mpg: 'binary', mpeg: 'binary', wmv: 'binary', flv: 'binary', '3gp': 'binary',
  mp3: 'binary', m4a: 'binary', aac: 'binary', wav: 'binary', flac: 'binary', ogg: 'binary',
  opus: 'binary', wma: 'binary', aif: 'binary', aiff: 'binary', caf: 'binary', mid: 'binary', midi: 'binary',
  // Fonts
  ttf: 'binary', otf: 'binary', ttc: 'binary', woff: 'binary', woff2: 'binary', eot: 'binary',
  // Archives / disk images / packages
  zip: 'binary', gz: 'binary', tgz: 'binary', tar: 'binary', rar: 'binary', '7z': 'binary',
  bz2: 'binary', xz: 'binary', zst: 'binary', lz4: 'binary', cab: 'binary', dmg: 'binary',
  iso: 'binary', img: 'binary', deb: 'binary', rpm: 'binary', msi: 'binary', pkg: 'binary',
  // Executables / compiled code / bytecode
  exe: 'binary', dll: 'binary', app: 'binary', apk: 'binary', aab: 'binary', ipa: 'binary',
  bin: 'binary', so: 'binary', dylib: 'binary', o: 'binary', a: 'binary', lib: 'binary',
  jar: 'binary', war: 'binary', class: 'binary', wasm: 'binary', pyc: 'binary',
  // Other binary document / data formats
  epub: 'binary', mobi: 'binary', sqlite: 'binary', sqlite3: 'binary', db: 'binary',
}

/**
 * The preview categories a text file may land in without being refused,
 * and what the name step says for the ones that are not the editor. Every
 * OTHER category (image, raw, pdf, audio, video, zip, archive, docx, pptx,
 * a non-csv spreadsheet, a plain "file" card) is refused: `fileCategory` is
 * the preview's own routing, so a new list entry there is refused here with
 * no second list to keep in step.
 */
const TEXT_CATEGORIES_OPEN_ELSEWHERE: Readonly<Partial<Record<Category, string>>> = {
  spreadsheet: 'the table view',
  html: 'the web view',
  svg: 'the image view',
}

/** Plain-text extensions whose preview routing is NOT the editor, but which
 *  are honest plain text (csv/tsv → table, html → web view, svg → image).
 *  Kept as a named set so the table view's xlsx/xls (binary) never qualify. */
const TEXT_EXTENSIONS_OPEN_ELSEWHERE = new Set(['csv', 'tsv', 'html', 'htm', 'svg'])

/** Letters, digits, `-`, `_`; 1–16 characters (after dropping one leading dot). */
const EXTENSION_SHAPE = /^[a-z0-9_-]{1,16}$/

export type ExtensionCheck =
  | { ok: true; ext: string; opensInEditor: boolean; note: string | null }
  | { ok: false; reason: string }

/** Lowercases, trims and drops leading dots (".PY" → "py"). */
export function normalizeExtension(input: string): string {
  return input.trim().replace(/^\.+/, '').toLowerCase()
}

function refusedReason(kind: RefusedKind, ext: string): string {
  switch (kind) {
    case 'office':
      return `.${ext} is an Office format, not plain text. Office files are coming soon.`
    case 'iwork':
      return `.${ext} is an Apple iWork format, not plain text. It is not supported yet.`
    case 'odf':
      return `.${ext} is a LibreOffice format, not plain text.`
    case 'pdf':
      return '.pdf is not plain text, so a text file cannot be one.'
    case 'binary':
      return `.${ext} is a binary format, not plain text.`
  }
}

/**
 * The Text type's extension rule. Anything plain-text-shaped is allowed;
 * Office / iWork / ODF / PDF / binary extensions are refused with a one-line
 * reason — both the explicit list above and anything the preview would
 * route to a non-text viewer (derived from `fileCategory`, so they cannot
 * drift).
 */
export function checkTextExtension(input: string): ExtensionCheck {
  const ext = normalizeExtension(input)
  if (!ext) return { ok: false, reason: 'Add an extension, like .txt.' }
  if (!EXTENSION_SHAPE.test(ext)) {
    return { ok: false, reason: 'An extension is letters and numbers only, like .py.' }
  }
  const refused = REFUSED_TEXT_EXTENSIONS[ext]
  if (refused) return { ok: false, reason: refusedReason(refused, ext) }

  // Derived from the preview's routing: what would this exact file open in?
  const mime = mimeTypeForTextExtension(ext)
  const category = fileCategory(mime, `x.${ext}`)
  if (category === 'doc' && isTextPreview(mime, `x.${ext}`)) {
    return { ok: true, ext, opensInEditor: true, note: null }
  }
  const elsewhere = TEXT_CATEGORIES_OPEN_ELSEWHERE[category]
  if (elsewhere && TEXT_EXTENSIONS_OPEN_ELSEWHERE.has(ext)) {
    return { ok: true, ext, opensInEditor: false, note: `.${ext} opens in ${elsewhere}, not the editor, on iPhone.` }
  }
  if (category === 'docx' || category === 'pptx' || category === 'spreadsheet') {
    return { ok: false, reason: refusedReason('office', ext) }
  }
  if (category === 'pdf') return { ok: false, reason: refusedReason('pdf', ext) }
  return { ok: false, reason: refusedReason('binary', ext) }
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
 * The FilesScreen "+" menu, in order. Uploads first; then the things you
 * CREATE here: a file, a folder.
 *
 * iOS: the create pair is one inline section (`displayInline` — a native
 * divider, not a submenu). Android: @react-native-menu/menu's MenuView.kt has
 * no `displayInline`, so the same untitled group would show as a BLANK row
 * that opens a submenu, hiding New folder behind it (task 1587 review) — so
 * Android gets the flat list.
 *
 * `imageColor` is always set (0791: Fabric forwards an omitted imageColor as
 * 0 = fully transparent, so the glyph would render blank).
 */
export function buildAddMenuActions(imageColor: string, platform: 'ios' | 'android' | string = 'ios'): AddMenuAction[] {
  const uploads: AddMenuAction[] = [
    { id: 'photo', title: 'Upload photo or video', image: 'photo.on.rectangle', imageColor },
    { id: 'file', title: 'Upload file', image: 'doc', imageColor },
    { id: 'scan', title: 'Scan document', image: 'doc.viewfinder', imageColor },
  ]
  const create: AddMenuAction[] = [
    { id: NEW_FILE_ACTION_ID, title: 'New file', image: 'doc.badge.plus', imageColor },
    { id: 'folder', title: 'New folder', image: 'folder.badge.plus', imageColor },
  ]
  if (platform === 'android') return [...uploads, ...create]
  return [...uploads, { id: 'create', title: '', displayInline: true, subactions: create }]
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

/** The fold every name comparison uses. Two parts:
 *   - Unicode NFC first: "Café" typed as one "é" (NFC) and as "e" + a
 *     combining accent (NFD, common in names from macOS) are the same name on
 *     APFS, so they must clash here too (task 1587 review).
 *   - A locale-independent lower-case (`toLowerCase`, NEVER `toLocale…`:
 *     under a Turkish locale "I" maps to dotless "ı" and would let "TITLE.md"
 *     and "title.md" coexist — web PR #117 review). */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** A file name's size limit on the file systems these files sync to
 *  (APFS, ext4, NTFS all cap one path component at 255 bytes/units). */
export const MAX_NAME_BYTES = 255

/** C0 (U+0000–U+001F), DEL and C1 (U+0080–U+009F) control characters — a
 *  pasted line break or tab included. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/** UTF-8 byte length (Hermes has TextEncoder; this avoids depending on it). */
export function utf8ByteLength(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
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

/**
 * Task 1592 item 9 — the name field's initial text selection.
 *
 * The field opens pre-filled with the default base ("Untitled note"), and
 * `autoFocus` + a non-empty controlled `value` does not reliably select-all
 * via `selectTextOnFocus` alone on iOS: the reported bug was that typing
 * APPENDED to the default ("Untitled notev140…") instead of replacing it.
 * An explicit `selection` prop on the field's first render is the fix —
 * select the whole default so the first keystroke replaces it, the way a
 * native "rename" field behaves.
 *
 * `touched` is false only until the user has edited the base themselves;
 * once true this returns `undefined` (RN's "I'm not dictating the cursor"),
 * so a later re-render never claws back a selection over their own edit.
 * This only ever governs the BASE name field — the extension segment (its
 * own `TextInput`, D3's user-editable extension) is untouched by this.
 */
export function initialNameSelection(
  base: string,
  touched: boolean,
): { start: number; end: number } | undefined {
  return touched ? undefined : { start: 0, end: base.length }
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
  if (CONTROL_CHARS.test(base)) {
    return { ok: false, reason: 'A name cannot contain line breaks or other control characters.', field: 'name' }
  }
  const name = `${base}.${ext}`
  const bytes = utf8ByteLength(name)
  if (bytes > MAX_NAME_BYTES) {
    return {
      ok: false,
      reason: `That name is too long: ${bytes} bytes, and the limit is ${MAX_NAME_BYTES} (letters with accents and emoji count as more than one).`,
      field: 'name',
    }
  }
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
