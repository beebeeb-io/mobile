/**
 * raw-format — pure helpers for camera RAW preview handling (task 1569):
 * recognizing RAW file extensions, and mapping a filename/mime to a
 * manufacturer-specific display label ("Canon RAW", "Sony RAW", …) for the
 * preview header's "Encrypted · Type · size" subtitle and the Info sheet's
 * "Kind" row.
 *
 * Unlike every other `Category` in `PreviewScreen.tsx`, RAW's correct
 * display name depends on the FILE, not the category alone — a CR2 and an
 * ARW are both `category: 'raw'` but read "Canon RAW" / "Sony RAW"
 * respectively. This is the same override pattern the screen already uses
 * for text files (`isText ? codeLanguageLabel : CATEGORY_LABELS[category]`).
 *
 * Kept dependency-free (no React Native, no exifr) so it's unit-testable
 * directly — same convention as `audio-format.ts` / `preview-content-inset.ts`.
 */

export type RawFormatLabel =
  | 'Canon RAW'
  | 'Sony RAW'
  | 'Nikon RAW'
  | 'Fujifilm RAF'
  | 'Adobe DNG'
  | 'RAW Image';

/**
 * The RAW extensions this app explicitly recognizes — task 1569's own
 * fixture set (Canon CR2/CR3, Sony ARW, Nikon NEF, Fujifilm RAF, Adobe
 * DNG), the same list web's `PREVIEWABLE_EXTENSIONS` RAW block names minus
 * orf/rw2, which are out of this task's declared scope. Apple ProRAW is
 * itself a DNG container (no separate extension), so it's already covered
 * by 'dng' — see task 1565's Notes on why no separate ProRAW fixture exists
 * (raw.pixls.us has none; a real one needs an actual iPhone 12 Pro+ photo).
 */
const RAW_EXTENSIONS = new Set(['cr2', 'cr3', 'arw', 'nef', 'raf', 'dng']);

const RAW_LABEL_BY_EXTENSION: Record<string, RawFormatLabel> = {
  cr2: 'Canon RAW',
  cr3: 'Canon RAW',
  arw: 'Sony RAW',
  nef: 'Nikon RAW',
  raf: 'Fujifilm RAF',
  dng: 'Adobe DNG',
};

/** Lowercased extension (no dot) from a filename, or '' if there is none —
 * matches `fileCategory()`'s own inline `.split('.').pop()` convention. */
export function extensionOfFileName(fileName: string | null | undefined): string {
  const name = (fileName ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1);
}

/**
 * True for any of this task's six RAW extensions (case-insensitive).
 * Checked ahead of the generic `image/*` mime routing in `fileCategory()` —
 * unlike jpg/png/heic, whether the OS reports a RAW extension's mime as
 * `image/*` at all is unreliable (task 1565 finding 4: mobile has zero
 * extension-based fallback for uploads, unlike `guessMimeType`), so routing
 * here is extension-first, not mime-first — the same reason web's own
 * `PREVIEWABLE_EXTENSIONS` treats RAW as its own extension-driven block
 * rather than relying on `mimeType.startsWith('image/')`.
 */
export function isRawExtension(ext: string): boolean {
  return RAW_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Resolves the manufacturer-specific label for a RAW file's title pill /
 * Info sheet "Kind" row. Extension is checked first (reliable — it's the
 * bytes actually on disk); a vendor-hinting mime (`image/x-canon-cr2`,
 * `image/x-adobe-dng`, …) is used only as a fallback for the rare case a
 * filename has no matching extension (e.g. a re-imported/renamed file) but
 * the OS still reported a vendor-specific RAW mime. Falls back to the
 * generic 'RAW Image' rather than guessing wrong.
 */
export function rawFormatLabel(fileName: string | null | undefined, mimeType?: string | null): RawFormatLabel {
  const ext = extensionOfFileName(fileName);
  const byExt = RAW_LABEL_BY_EXTENSION[ext];
  if (byExt) return byExt;

  const mime = (mimeType ?? '').toLowerCase();
  if (mime.includes('canon')) return 'Canon RAW';
  if (mime.includes('sony')) return 'Sony RAW';
  if (mime.includes('nikon')) return 'Nikon RAW';
  if (mime.includes('fuji')) return 'Fujifilm RAF';
  if (mime.includes('dng') || mime.includes('adobe')) return 'Adobe DNG';
  return 'RAW Image';
}

/**
 * Extension (with leading dot) to decrypt the temp file under —
 * `PreviewScreen.tsx`'s `extensionForMime` calls this for `category ===
 * 'raw'` so the on-disk decrypted temp file keeps the REAL RAW extension
 * (needed so "Share"/"Save" hand off a correctly-named file, and so the
 * embedded-preview scanner's own logging is meaningful), not a generic
 * '.jpg' or '.raw'. Falls back to '.dng' — the one RAW extension that is
 * itself a standard, self-describing container — only for the unreachable
 * case of a caller that already confirmed `isRawExtension` but somehow has
 * no filename extension.
 */
export function extensionForRaw(fileName: string | null | undefined): string {
  const ext = extensionOfFileName(fileName);
  return ext && isRawExtension(ext) ? `.${ext}` : '.dng';
}
