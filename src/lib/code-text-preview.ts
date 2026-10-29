/**
 * code-text-preview — pure helpers deciding whether a file should render as
 * highlighted text (`CodeRenderer`, native `<Text>` spans, task 1563) in
 * Preview, independent of what `mime_type` the file happens to carry
 * (task 1570).
 *
 * The bug this fixes: `PreviewScreen.tsx`'s `isText` used to be gated
 * ENTIRELY on `mime_type` (`mime.startsWith('text/') || mime ===
 * 'application/json' || mime === 'application/xml'`). That is correct only
 * when the uploader reported an accurate mime_type. Two real uploaders
 * don't, for exactly the source-code extensions this task's fixture set
 * covers (py/go/rs/ts/tsx/js/jsx/java/kt/swift/c/cpp/h/cs/rb/php/sh/sql/
 * css/toml/ini/Dockerfile):
 *
 *  1. **Phone**: iOS's `expo-document-picker` UTType lookup reports `nil`/
 *     `undefined` for a lot of less-common source-code extensions (task
 *     1565 Phase A finding 3 — there was no extension-based fallback
 *     anywhere in the upload path).
 *  2. **CLI / web with a generic MIME type**: a browser's own `File.type`
 *     is empty for most non-media extensions (.py/.go/.rs/.rb/.sh/.sql/…
 *     have no browser-registered MIME type), and a script/CLI uploader that
 *     doesn't special-case an extension typically falls back to
 *     `application/octet-stream`.
 *
 * Both land the SAME way today: `mime_type` is null, '', or
 * 'application/octet-stream' by the time PreviewScreen reads it — whether
 * that happened at the moment of upload, or because the file has sat in
 * someone's vault since before this fix existed. So the fix lives at
 * PREVIEW TIME, not (only) in the upload path: `isTextPreview` below is
 * re-evaluated every time a file is opened, using the CURRENT filename, so
 * an already-uploaded file with a stale/missing mime_type opens correctly
 * too, not just newly-uploaded ones.
 *
 * A confident, NON-generic mime_type is never second-guessed by the
 * extension — this only fires when the mime_type tells us nothing.
 *
 * ---
 *
 * ## Single source of truth — what was checked, what was chosen, and why
 *
 * `repos/core/beebeeb-core/src/media.rs` has TWO relevant functions, and the
 * right one to prefer is `is_previewable_by_extension`, not `guess_mime_type`
 * (task 1570's own brief names the latter — this file's research corrects
 * that to the actually-comprehensive one):
 *
 *  - `guess_mime_type` (media.rs:67-137) has NO entries at all for most of
 *    this task's extensions (py/go/rs/ts/tsx/jsx/java/c/cpp/h/hpp/rb/php/
 *    sh/bash/zsh/toml/ini/conf/dockerfile/makefile/scss/less/graphql —
 *    checked 2026-09-27).
 *  - `is_previewable_by_extension` (media.rs:33-63) is a `bool`-returning
 *    "is this extension previewable" check whose "Code" section (media.rs:
 *    55-61) already lists EXACTLY this task's extensions plus more
 *    (py/js/jsx/ts/tsx/rs/go/rb/java/kt/swift/c/cpp/h/hpp/cs/php/sh/bash/
 *    zsh/html/htm/css/scss/less/vue/svelte/astro/dart/r/ex/exs/zig/nim/v/
 *    json/xml/yaml/yml/toml/ini/conf/sql/graphql/proto/cmake/dockerfile/
 *    makefile) — this is the real canonical list, and `TEXT_EXTENSIONS`
 *    below mirrors its text/code portion (excluding the image/video/audio/
 *    PDF/office/archive extensions it also lists, which `fileCategory()`
 *    already routes to their own categories before ever reaching the
 *    text fallback this file guards).
 *
 * **Is it feasible for mobile to CALL `is_previewable_by_extension`
 * directly, instead of keeping a second copy here?** Closer than it first
 * looks, but not tonight:
 *
 *  - It IS already exposed over UniFFI (`beebeeb-uniffi/src/lib.rs:438`,
 *    `fn is_previewable_by_extension`), and the generated Swift wrapper is
 *    already checked into this repo and already linked into the CURRENT
 *    `ios/BeebeebCore.xcframework` build — `modules/beebeeb-crypto/ios/
 *    beebeeb_uniffi.swift:6242`, `public func isPreviewableByExtension
 *    (filename: String) -> Bool`, checksum-verified against the linked
 *    binary at `beebeeb_uniffi.swift:6709`. So, unlike `guessMimeType`,
 *    consuming this does NOT need a core Rust change or an xcframework
 *    rebuild — only core's `guess_mime_type` would need that, and this
 *    file deliberately does not depend on it.
 *  - What's actually missing is one line in `BeebeebCryptoModule.swift` —
 *    a `Function("isPreviewableByExtension") { (filename: String) -> Bool
 *    in isPreviewableByExtension(filename: filename) }` — the Expo bridge
 *    never wraps it, so there is currently no way to call it from
 *    TypeScript. That file is this app's single largest, most sensitive
 *    native bridge (110 existing `Function`/`AsyncFunction` entries
 *    backing every crypto/auth/upload/keychain/FileProvider path) with no
 *    existing Swift-level test harness of its own. Adding to it, even one
 *    line, means a full native Xcode rebuild and — to be honest about the
 *    blast radius, not just the diff size — re-verifying every OTHER
 *    native surface that file backs, not just Preview. That is a
 *    dedicated follow-up task ("expose `isPreviewableByExtension` through
 *    the Expo bridge; have `isTextPreview` call it"), not a same-night
 *    addition bundled into this P0 Preview-only fix.
 *
 * Until that follow-up lands, this file — following the exact precedent
 * `src/lib/media.ts` already set for `guessMimeType` ("Once the native
 * module exposes `guessMimeType` … we can swap to native calls; until then
 * this is the single source of truth for the mobile app") — is the
 * mobile-side single source of truth for "does this extension mean
 * text/code". `code-text-preview.test.ts`'s "stays in sync with core"
 * block transcribes core's actual `is_previewable_by_extension` text/code
 * list (cited by source line) as literal fixture data and asserts every
 * one of those extensions is also recognized here — so if core's list
 * changes and this file isn't updated to match, the test goes red instead
 * of silently drifting. `media.ts`'s own `MIME_MAP` spreads
 * `TEXT_EXTENSION_MIME` in rather than keeping a third independent copy.
 */

/**
 * Extensions beebeeb-core's `is_previewable_by_extension` (media.rs:55-61)
 * recognizes as "code", plus the "Text / Markdown" section (media.rs:49)
 * it also covers. This is the SET the sync test checks against core.
 */
export const CORE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // Text / Markdown (media.rs:49)
  'txt', 'md', 'markdown', 'csv', 'log', 'rtf',
  // Code (media.rs:55-61)
  'py', 'js', 'jsx', 'ts', 'tsx', 'rs', 'go', 'rb', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'html', 'htm', 'css', 'scss', 'less',
  'vue', 'svelte', 'astro',
  'dart', 'r', 'ex', 'exs', 'zig', 'nim', 'v',
  'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'sql', 'graphql', 'proto', 'cmake', 'dockerfile', 'makefile',
]);

/**
 * Extensions that should render as highlighted text/code, mapped to a
 * representative mime type. Every extension in `CORE_TEXT_EXTENSIONS` is
 * present here (enforced by `code-text-preview.test.ts`); a few extra
 * mobile-only ones are layered on top for cases core doesn't special-case
 * at all (dotless dotfiles like ".gitignore" — `extensionOf` returns
 * "gitignore" for that name, which isn't one of core's match arms; `tsv`,
 * which core's list doesn't include either — task 1570's own fixture set
 * needs it and it's already routed to `XlsxRenderer` via `fileCategory()`
 * before it would ever reach this table, so its presence here is purely
 * for completeness, not load-bearing).
 *
 * Where core's OWN `guess_mime_type` (media.rs:67-137) already defines a
 * value for an extension, the value here is copied verbatim (cited below)
 * rather than invented independently.
 */
export const TEXT_EXTENSION_MIME: Readonly<Record<string, string>> = {
  // Text / Markdown — core guess_mime_type values, media.rs:109-114
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  // Text / Markdown — core recognizes these (is_previewable_by_extension,
  // media.rs:49) but guess_mime_type has no value for them; 'text/plain' is
  // the honest default.
  log: 'text/plain',
  rtf: 'application/rtf',

  // Code — core guess_mime_type values (media.rs:117-128)
  vue: 'text/plain',
  svelte: 'text/plain',
  astro: 'text/plain',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  cs: 'text/x-csharp',
  dart: 'text/x-dart',
  r: 'text/x-r',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  zig: 'text/x-zig',
  nim: 'text/x-nim',
  v: 'text/x-v',
  proto: 'text/x-protobuf',
  cmake: 'text/x-cmake',

  // Code — core's `is_previewable_by_extension` recognizes these
  // (media.rs:55-61) but `guess_mime_type` defines NO value for any of
  // them (checked 2026-09-27) — this app is currently the only place any
  // of them gets a concrete mime type at all.
  py: 'text/x-python',
  jsx: 'text/jsx',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  rs: 'text/x-rust',
  go: 'text/x-go',
  rb: 'text/x-ruby',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  php: 'text/x-php',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  scss: 'text/css',
  less: 'text/css',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/x-toml',
  ini: 'text/x-ini',
  conf: 'text/plain',
  sql: 'application/sql',
  graphql: 'application/graphql',
  dockerfile: 'text/x-dockerfile',
  makefile: 'text/x-makefile',

  // Mobile-only additions beyond CORE_TEXT_EXTENSIONS — see doc comment.
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  pyw: 'text/x-python',
  cc: 'text/x-c++',
  cxx: 'text/x-c++',
  hxx: 'text/x-c++',
  cfg: 'text/x-ini',
  tsv: 'text/tab-separated-values',
  gitignore: 'text/plain',
  gitattributes: 'text/plain',
  env: 'text/plain',
};

/**
 * Extension (no dot) for a filename, matching `PreviewScreen.tsx`'s own
 * `(fileName ?? '').toLowerCase().split('.').pop() ?? ''` convention used
 * by `fileCategory()` / `detectCodeLanguage()`. For a dotless filename
 * (e.g. "Dockerfile"), this returns the WHOLE lowercased filename — that is
 * the existing, established convention in this file (not a new one
 * invented here), and it's what makes "Dockerfile" fixture recognition
 * work via a plain map lookup with no special-casing. This deliberately
 * does NOT reuse `raw-format.ts`'s `extensionOfFileName`, which returns ''
 * for a dotless name — a different, RAW-specific convention.
 */
export function extensionOf(fileName: string | null | undefined): string {
  return (fileName ?? '').trim().toLowerCase().split('.').pop() ?? '';
}

const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * True for a mime_type that tells us nothing about the file's real kind —
 * absent, empty, or the generic fallback an uploader sends when it doesn't
 * know better (see this file's own doc comment for the two real uploaders
 * that do this for source-code extensions).
 */
export function isGenericMimeType(mimeType: string | null | undefined): boolean {
  return GENERIC_MIME_TYPES.has((mimeType ?? '').trim().toLowerCase());
}

/**
 * Mime types/prefixes that confidently mean "this is a DIFFERENT kind of
 * file" — the same categories `fileCategory()` (PreviewScreen.tsx) already
 * routes to their own renderer BEFORE ever reaching the text fallback this
 * module guards (image/video/audio/pdf/zip/archive/office). Only these
 * block the extension-based fallback below; everything else (including a
 * mime_type this app's OWN `guessMimeType` upstream — see the "real bug"
 * note below) defers to the extension.
 */
export function isConfidentlyNonTextMimeType(mime: string): boolean {
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
    return true;
  }
  if (
    mime === 'application/pdf' ||
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-zip' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/msword' ||
    mime === 'application/csv'
  ) {
    return true;
  }
  return mime.includes('spreadsheet') || mime.includes('presentationml') || mime.includes('wordprocessingml');
}

/** True when `ext` (as returned by `extensionOf`) is a known text/code type. */
export function isTextLikeExtension(ext: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEXT_EXTENSION_MIME, ext);
}

/**
 * The single decision PreviewScreen's `isText` needs: should this file
 * render via CodeRenderer as highlighted text?
 *
 *  - A confident text/json/xml mime_type → yes (unchanged prior behaviour).
 *  - Anything NOT confidently a different kind of file (image/video/audio/
 *    pdf/zip/archive/office) AND a known text/code extension → yes.
 *  - A confidently non-text mime_type, or an unrecognized extension → no —
 *    falls through to the honest "can't preview this" card, same as before.
 *
 * **Real bug found and fixed while verifying this on-device (task 1570):**
 * this used to gate the extension fallback on `isGenericMimeType` (mime is
 * '' / 'application/octet-stream') rather than "not confidently something
 * else". That broke `sample.sql` specifically: the browser reports `""` for
 * `File.type` on a `.sql` file (confirmed directly via a throwaway
 * `<input type=file>` test page), so `media.ts`'s `mimeTypeFor` fallback
 * (`file.mime_type ?? guessMimeType(name)`, called BEFORE PreviewScreen
 * ever sees the value) had already substituted `TEXT_EXTENSION_MIME.sql`
 * itself — `'application/sql'` — for the null mime_type. That value is
 * neither generic NOR `text/`-prefixed, so the old `isGenericMimeType`
 * guard refused to defer to the extension and the file fell to the fallback
 * card — reproduced live (bb-ios27 Release build, sample.sql uploaded via
 * the local web app: "Type: File" / "Preview not available", the exact
 * fallback-card symptom). The same latent bug applied to any extension
 * whose `TEXT_EXTENSION_MIME` value isn't `text/`-prefixed AND whose
 * `File.type` the browser leaves empty (`mjs`/`cjs`/`bash`/`zsh`/`graphql`
 * — js/sh themselves dodged it only because Chrome's own UTI lookup
 * already reports `text/javascript` / `text/x-sh` directly, never
 * consulting `guessMimeType` at all). Fixed by checking against a
 * confidently-non-text mime ALLOWLIST-of-exclusions instead of a
 * generic-mime ALLOWLIST-of-inclusions — any mime this app doesn't already
 * recognize as image/video/audio/pdf/zip/archive/office now defers to the
 * extension, matching the actual intent ("code files always open as text
 * … whether uploaded from the phone or CLI/web with application/octet-
 * stream") instead of the narrower literal reading of it.
 */
export function isTextPreview(
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): boolean {
  const mime = (mimeType ?? '').trim().toLowerCase();
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return true;
  }
  if (isConfidentlyNonTextMimeType(mime)) return false;
  return isTextLikeExtension(extensionOf(fileName));
}
