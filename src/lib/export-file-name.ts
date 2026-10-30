/**
 * Task 2253 — the name the share sheet (and therefore "Save to Files" /
 * "Save to Photos" on Android) shows for an exported file.
 *
 * The decrypted preview lives at `Library/Caches/preview/<fileId>.<ext>`, so
 * handing that URI straight to `Sharing.shareAsync` named the user's saved
 * copy after the file id ("640d4f1e-c0cd-…"). The export path now copies the
 * plaintext to the file's own decrypted display name instead. This module is
 * the ONE place that decides what that name may look like:
 *
 *  - sanitize for the FILESYSTEM ONLY (`/`, `\`, `:` and control characters
 *    become `_`); every other character — spaces, accents, CJK, emoji — is
 *    the user's name and is kept exactly;
 *  - trim spaces and dots at both ends (a name that ends in `.` or ` ` is
 *    awkward on every filesystem), and never yield `..`;
 *  - normalize to NFC so the same name always maps to the same path;
 *  - cap at 200 UTF-8 bytes without splitting a character and without
 *    dropping the extension;
 *  - an empty result becomes `file` + the original extension.
 *
 * Row 4 of the contract: a name that is not available yet (still encrypted /
 * still decrypting) is NEVER guessed — the caller passes `null` and gets the
 * id-based name it had before.
 */

/** 200 UTF-8 bytes — well inside the 255-byte limit of APFS / ext4, with the
 *  per-export folder name (`<base36 time>-<8 hex>`) and the parent path still
 *  accounted for. */
export const EXPORT_NAME_MAX_BYTES = 200;

const FALLBACK_STEM = 'file';

// `/`, `\` and `:` are path/hostile separators on the three platforms we
// write to; C0 and C1 control characters would corrupt the name and the
// share-sheet UI.
const HOSTILE = /[/\\:]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function byteLength(s: string): number {
  let total = 0;
  for (const ch of s) total += utf8Length(ch);
  return total;
}

/** Truncate to at most `maxBytes` UTF-8 bytes, never splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of s) {
    const len = utf8Length(ch);
    if (used + len > maxBytes) break;
    out += ch;
    used += len;
  }
  return out;
}

function trimEdges(s: string): string {
  return s.replace(/^[ .]+/, '').replace(/[ .]+$/, '');
}

/**
 * Sanitize a decrypted display name for the filesystem, keeping its
 * extension exactly as it appears in the name.
 */
export function sanitizeExportFileName(name: string): string {
  const normalized = (name ?? '').normalize('NFC');
  const replaced = normalized.replace(HOSTILE, '_').replace(CONTROL, '_');

  // Trim the tail BEFORE locating the extension, so `  padded name.pdf  `
  // does not keep the spaces in its "extension"; the leading edge is trimmed
  // afterwards on the stem alone, so `  .zip` still keeps `.zip`. A leading
  // dot (`.hidden`) is not an extension — it is a (trimmed) dot at the edge.
  const endTrimmed = replaced.replace(/[ .]+$/, '');
  const dot = endTrimmed.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < endTrimmed.length - 1;
  const extension = hasExtension ? endTrimmed.slice(dot) : '';
  const rawStem = hasExtension ? replaced.slice(0, dot) : replaced;

  let stem = trimEdges(rawStem) || FALLBACK_STEM;

  const extensionBytes = byteLength(extension);
  if (extensionBytes >= EXPORT_NAME_MAX_BYTES) {
    // Pathological: the "extension" alone does not fit. Cap the whole name
    // rather than inventing one.
    const capped = trimEdges(truncateToBytes(stem + extension, EXPORT_NAME_MAX_BYTES));
    return capped || FALLBACK_STEM;
  }

  const budget = EXPORT_NAME_MAX_BYTES - extensionBytes;
  stem = trimEdges(truncateToBytes(stem, budget)) || FALLBACK_STEM;
  if (byteLength(stem) > budget) {
    // Only reachable when the fallback stem itself exceeds a tiny budget.
    stem = truncateToBytes(stem, budget) || FALLBACK_STEM;
  }

  const result = `${stem}${extension}`;
  return result === '..' || result === '.' ? FALLBACK_STEM + extension : result;
}

/**
 * True when `name` is a decrypted display name we can use. A blank string is
 * "not available yet"; an encrypted metadata envelope (`{cipher_suite…`) is
 * ciphertext that leaked into a name slot, never a name.
 */
export function isExportableDisplayName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && !trimmed.startsWith('{');
}

/**
 * The export name for a file: its decrypted display name when we have one,
 * otherwise today's id-based name (`<fileId>.<ext>`). Never a guessed name.
 */
export function exportFileName(displayName: string | null | undefined, idBasedName: string): string {
  return sanitizeExportFileName(
    isExportableDisplayName(displayName) ? (displayName as string) : idBasedName,
  );
}

/**
 * Read the name out of a decrypted metadata plaintext — either the JSON
 * envelope (`{"name":"IMG_0042.DNG","mime_type":…}`) or a legacy bare
 * filename. Returns `null` when there is no name in it.
 */
export function parseExportDisplayName(plaintext: string): string | null {
  const text = plaintext ?? '';
  try {
    const meta = JSON.parse(text) as unknown;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const name = (meta as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) return name.trim();
      return null;
    }
  } catch {
    // Legacy metadata: the plaintext is the bare filename.
  }
  const bare = text.trim();
  return bare || null;
}

/**
 * A fresh folder name per export, so two files with the same display name
 * never clash and the name itself can stay exact.
 */
export function exportSubdirectoryName(random: () => number = Math.random): string {
  const jitter = Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${Date.now().toString(36)}-${jitter}`;
}
