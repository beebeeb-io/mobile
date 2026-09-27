/**
 * Task 1587 — iOS "+" menu: New text file / New Markdown note.
 *
 * The mobile port of web's `src/lib/new-document.ts` (task 1582): the type
 * table, the default names and the name-uniqueness rules for creating a
 * brand-new file in the current folder, plus the "+" menu's item table.
 * Ported, not imported — the web repo is not a dependency of this one.
 *
 * Only the types the phone can EDIT today are offered: plain text and
 * Markdown, both of which open in the in-preview TextEditorView (task 1563).
 * Office types wait for an iOS Office editor — a user must never be able to
 * create a file the app then cannot open for editing.
 *
 * Pure: no React Native, no network, no crypto, so it is unit-tested in
 * isolation (new-document.test.ts). The impure half — writing the empty file,
 * the encrypted upload, opening the editor — lives in FilesScreen.
 */

export interface NewDocumentType {
  /** Stable id; the "+" menu action id is `new-<id>`. */
  id: 'txt' | 'md'
  /** Menu row + prompt title. */
  title: string
  /** Extension, lowercase, no dot. */
  ext: string
  mimeType: string
  /** Default name before the extension ("Untitled note"). */
  defaultBase: string
  /** SF Symbol for the native UIMenu row. */
  sfSymbol: string
}

export const NEW_DOCUMENT_TYPES: readonly NewDocumentType[] = [
  {
    id: 'txt',
    title: 'New text file',
    ext: 'txt',
    mimeType: 'text/plain',
    defaultBase: 'Untitled',
    sfSymbol: 'doc.text',
  },
  {
    id: 'md',
    title: 'New Markdown note',
    ext: 'md',
    mimeType: 'text/markdown',
    defaultBase: 'Untitled note',
    sfSymbol: 'doc.richtext',
  },
]

export function getNewDocumentType(id: NewDocumentType['id']): NewDocumentType {
  const t = NEW_DOCUMENT_TYPES.find((x) => x.id === id)
  if (!t) throw new Error(`unknown new-document type: ${id}`)
  return t
}

/** The "+" menu action id for a new-document type (`new-txt`, `new-md`). */
export function newDocumentActionId(type: NewDocumentType): string {
  return `new-${type.id}`
}

/** Reverse of `newDocumentActionId`; null for every other menu action. */
export function newDocumentTypeForAction(actionId: string): NewDocumentType | null {
  return NEW_DOCUMENT_TYPES.find((t) => newDocumentActionId(t) === actionId) ?? null
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

/**
 * The FilesScreen "+" menu, in order. Uploads first; then one inline section
 * (a native divider, not a submenu) for the things you CREATE here: a folder,
 * a text file, a Markdown note.
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
        { id: 'folder', title: 'New folder', image: 'folder.badge.plus', imageColor },
        ...NEW_DOCUMENT_TYPES.map((t) => ({
          id: newDocumentActionId(t),
          title: t.title,
          image: t.sfSymbol,
          imageColor,
        })),
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
 *   - Text: one newline, i.e. a single empty line (POSIX text-file shape).
 */
export function initialDocumentContent(type: NewDocumentType, fileName: string): string {
  if (type.id === 'md') {
    const suffix = `.${type.ext}`
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

/** The pre-filled name in the name prompt: unique in the current folder. */
export function defaultNewDocumentName(type: NewDocumentType, existingNames: Iterable<string>): string {
  return uniqueFileName(`${type.defaultBase}.${type.ext}`, existingNames)
}

/** Thrown by the create handler when the FRESH listing already holds the
 *  name; its message is user-facing and shown as-is in the prompt. */
export class NewDocumentNameClashError extends Error {
  constructor(name: string) {
    super(`“${name}” already exists in this folder.`)
    this.name = 'NewDocumentNameClashError'
  }
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string }

/**
 * Normalises what the user typed into the final file name: trims, and
 * appends the type's extension when it is missing (typing "Groceries" for a
 * Markdown note gives "Groceries.md" — the extension decides which editor
 * opens it, so it is never optional). A name already ending in the
 * extension (any case) is kept as typed.
 *
 * It does NOT silently rename on a clash: the prompt shows the reason and
 * lets the user choose. A silent "Groceries 2.md" is a surprise the user
 * would only discover in the file list.
 */
export function checkNewDocumentName(
  input: string,
  type: NewDocumentType,
  existingNames: Iterable<string>,
): NameCheck {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, reason: 'Give the file a name.' }
  if (/[/\\]/.test(trimmed)) return { ok: false, reason: 'A name cannot contain / or \\.' }
  const suffix = `.${type.ext}`
  const name = foldName(trimmed).endsWith(suffix) ? trimmed : `${trimmed}${suffix}`
  if (foldName(name) === suffix) return { ok: false, reason: 'Give the file a name.' }
  for (const n of existingNames) {
    if (foldName(n) === foldName(name)) {
      return { ok: false, reason: `“${name}” already exists in this folder.` }
    }
  }
  return { ok: true, name }
}
