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
 *  - an ALLOWLIST by Unicode category (round 2, mobile#254 review P1): letters,
 *    marks, numbers, punctuation, symbols and the plain space are the user's
 *    name and are kept exactly (accents, CJK, emoji); every other character
 *    becomes `_` — controls, bidi overrides, zero-width characters and
 *    line/paragraph separators (they can fake an extension in the share sheet).
 *    Within the allowed categories the Windows/FAT/SMB-reserved and
 *    URI-significant characters `/ \ : * ? " < > | % #` become `_` too: the
 *    name goes into a `file://` URI, and the file-system layer percent-decodes
 *    it, so a kept `%2F` reached a directory outside the export folder;
 *  - a Windows-reserved first component (`CON`, `NUL`, `COM1`, …, also in
 *    `CON.tar.gz`) gets a `_` prefix, so the copy saves to an SD card or an
 *    SMB share;
 *  - round 3 (mobile#265 review): ZWNJ, ZWJ and the emoji tag characters stay
 *    (Persian names, emoji sequences, subdivision flags);
 *  - trim spaces and dots at both ends (a name that ends in `.` or ` ` is
 *    awkward on every filesystem), and never yield `..`;
 *  - normalize to NFC so the same name always maps to the same path;
 *  - cap at 200 UTF-8 bytes without splitting a character and without
 *    dropping the extension;
 *  - an empty result becomes `file` + the original extension.
 *
 * Row 4 of the contract: a name that is not available yet (still encrypted /
 * still decrypting) is NEVER guessed — the caller passes `null` and gets the
 * id-based name it had before. Round 3: a list placeholder (`Shared file`,
 * `Photo`, a truncated `xxx...` label) or a name of only dots and spaces is
 * treated the same way.
 */

/** 200 UTF-8 bytes — well inside the 255-byte limit of APFS / ext4, with the
 *  per-export folder name (`<base36 time>-<8 hex>`) and the parent path still
 *  accounted for. */
export const EXPORT_NAME_MAX_BYTES = 200;

const FALLBACK_STEM = 'file';

// Round 2 (mobile#254 review): the categories a name may use. Anything else
// (Cc controls, Cf bidi/zero-width, Zl/Zp separators, Co/Cn/Cs) becomes `_`.
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
// Round 3 (mobile#265 review): the format characters a name NEEDS to render —
// ZWNJ / ZWJ (Persian and Indic words, emoji ZWJ sequences such as a family)
// and the emoji tag characters (subdivision flags). They cannot reorder or
// hide text, unlike the bidi controls and zero-width spaces that stay out.
const NEEDED_FORMAT = /^[\u200C\u200D\u{E0020}-\u{E007F}]$/u;
// Path separators, Windows/FAT/SMB-reserved and URI-significant characters —
// all inside the allowed categories, all replaced.
const RESERVED = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '%', '#']);
// Device names Windows (and SMB / FAT) refuse as a file stem, with or without
// an extension.
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function allowlisted(name: string): string {
  let out = '';
  // Every space character (no-break, narrow, ideographic) is a plain space.
  for (const ch of name.replace(/\p{Zs}/gu, ' ')) {
    out += (ALLOWED.test(ch) && !RESERVED.has(ch)) || NEEDED_FORMAT.test(ch) ? ch : '_';
  }
  return out;
}

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
  const replaced = allowlisted(normalized);

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
    return notADevice(capped || FALLBACK_STEM);
  }

  const budget = EXPORT_NAME_MAX_BYTES - extensionBytes;
  stem = trimEdges(truncateToBytes(stem, budget)) || FALLBACK_STEM;
  if (byteLength(stem) > budget) {
    // Only reachable when the fallback stem itself exceeds a tiny budget.
    stem = truncateToBytes(stem, budget) || FALLBACK_STEM;
  }

  const result = `${stem}${extension}`;
  return notADevice(result === '..' || result === '.' ? FALLBACK_STEM + extension : result);
}

/**
 * Round 3 (mobile#265 review): Windows / SMB / FAT read a name as the device
 * when its FIRST component is one (`CON.tar.gz`, `nul.txt.exe`), not only the
 * part before the last dot. A `_` prefix keeps it a file. (A `_` added to a
 * name already at the byte cap is one byte over the 200-byte budget, still
 * far inside the 255-byte filesystem limit.)
 */
function notADevice(name: string): string {
  return WINDOWS_RESERVED_STEM.test(name.split('.')[0] ?? '') ? `_${name}` : name;
}

/**
 * True when `name` is a decrypted display name we can use. A blank string is
 * "not available yet"; an encrypted metadata envelope (`{"cipher_suite"…}`) is
 * ciphertext that leaked into a name slot, never a name. Round 2 (mobile#254
 * review): only an actual envelope (a JSON object with the envelope's fields)
 * counts; a real name that merely starts with `{` (`{draft}.txt`) is a name.
 */
export function isExportableDisplayName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    !isEncryptedEnvelope(trimmed) &&
    // Round 3 (mobile#265 review): a name with nothing in it but dots and
    // spaces (`....`) would be saved as a bare `file`; the id name keeps its
    // extension.
    trimmed.replace(/[\s.]/g, '').length > 0 &&
    !isPlaceholderDisplayName(trimmed)
  );
}

// Round 3 (mobile#265 review, contract row 4 "never guessed"): the labels the
// lists show while a name is missing or still encrypted. They reach Preview
// as its `fileName` param (FilesScreen, SharedScreen, PhotosScreen), and are
// never the file's name.
const PLACEHOLDER_NAMES = new Set([
  'Untitled file',
  'Untitled folder',
  'Encrypted file',
  'Encrypted folder',
  'Shared file',
  'Shared folder',
  'Photo',
]);
// FilesScreen's list label for a long legacy name: its first 24 UTF-16 units
// and `...` (`displayName`). Never the whole name.
const TRUNCATED_LIST_LABEL_LENGTH = 24 + '...'.length;

/** True for a list placeholder or a truncated list label (never a real name). */
export function isPlaceholderDisplayName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name) || (name.length === TRUNCATED_LIST_LABEL_LENGTH && name.endsWith('...'));
}

const ENVELOPE_FIELDS = ['cipher_suite', 'nonce', 'ciphertext', 'n', 'c'];

function isEncryptedEnvelope(text: string): boolean {
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return ENVELOPE_FIELDS.some((field) => field in (parsed as Record<string, unknown>));
  } catch {
    return false;
  }
}

/**
 * Round 3 (mobile#265 review): an extension that may go into a cache file URI
 * (`<preview dir>/<id>.<ext>`). It comes from a name, or a mime type, that
 * whoever shared the file chose, so only 1–10 plain ASCII letters and digits
 * pass; anything else (`jpg#a`, `my file`, `%2f..%2fy`) is `null` and the
 * caller falls back.
 */
export function plainExtension(candidate: string | null | undefined): string | null {
  const ext = (candidate ?? '').toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : null;
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
