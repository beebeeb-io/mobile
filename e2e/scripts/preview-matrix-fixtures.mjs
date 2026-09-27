// Task 1565 — shared fixture → expected-outcome table for mobile.
//
// Read directly against `src/screens/PreviewScreen.tsx` (category dispatch +
// render tree) and the `src/components/preview/*Renderer.tsx` files, AFTER
// task 1564 (react-native-webview blank-paint fix) merged to main — this
// flips SVG/HTML/DOCX from the Phase A "predicted FAIL" note to "predicted
// render", now that the WebView bug they all shared is fixed. See this
// task's own Notes in the workspace task file for the dated update.
//
// `expectedIdRegex` is a Maestro `id:` regex (Maestro's own `id:` matcher
// already supports POSIX regex — see e2e/maestro/file-preview-test.yaml's
// `"file-row-[0-9a-f]{8}-.*"`) against the testIDs added in this same task:
//   preview-render-image, preview-render-video, preview-render-pdf,
//   preview-render-svg-webview, preview-render-html-webview,
//   preview-render-docx-webview, preview-render-code,
//   preview-render-markdown, preview-render-spreadsheet,
//   preview-render-pptx, preview-render-zip, preview-render-archive,
//   preview-render-fallback (the honest "can't preview" card)
//
// Several rows are a REGEX ALTERNATION of two ids rather than one. That is
// not a weaker assertion — it is the honest encoding of Phase A's own
// "uncertain, depends on the OS-reported mime_type at upload" finding
// (finding 3: ~20 code extensions; finding 4: RAW has no explicit handling
// at all). Maestro can't resolve what iOS's UTType lookup will report
// ahead of time, so the flow accepts EITHER of the two outcomes the code
// can legitimately produce — but NOT a third thing (blank/spinner), which
// is exactly the FAIL this whole matrix exists to catch. A fixture whose
// actual outcome is neither id in its regex is a real FAIL to investigate,
// same as any other row.

const CODE_OR_FALLBACK = 'preview-render-code|preview-render-fallback'
const IMAGE_OR_FALLBACK = 'preview-render-image|preview-render-fallback'

/** @typedef {{ rel: string, category: string, ext: string, expectedIdRegex: string, notes: string }} FixtureCase */

/** @type {FixtureCase[]} */
export const FIXTURES = [
  // ── Office ──────────────────────────────────────────────────────────────
  { rel: 'office/sample.docx', category: 'office', ext: 'docx', expectedIdRegex: 'preview-render-docx-webview', notes: 'DocxRenderer — WebView, now fixed by 1564' },
  { rel: 'office/sample.doc', category: 'office', ext: 'doc', expectedIdRegex: 'preview-render-fallback', notes: 'legacy .doc — no handling, generic fallback (Phase A row 16)' },
  { rel: 'office/sample.xlsx', category: 'office', ext: 'xlsx', expectedIdRegex: 'preview-render-spreadsheet', notes: 'XlsxRenderer (row 17)' },
  { rel: 'office/sample.xls', category: 'office', ext: 'xls', expectedIdRegex: 'preview-render-spreadsheet', notes: 'legacy .xls explicitly mime-matched (row 17)' },
  { rel: 'office/sample.pptx', category: 'office', ext: 'pptx', expectedIdRegex: 'preview-render-pptx', notes: 'PptxRenderer, text-only slides (row 18)' },
  { rel: 'office/sample.ppt', category: 'office', ext: 'ppt', expectedIdRegex: 'preview-render-fallback', notes: 'legacy .ppt — no handling, generic fallback (row 19)' },

  // ── Text ────────────────────────────────────────────────────────────────
  { rel: 'text/sample.txt', category: 'text', ext: 'txt', expectedIdRegex: 'preview-render-code', notes: 'isText override → CodeRenderer plain (row 10)' },
  { rel: 'text/sample.md', category: 'text', ext: 'md', expectedIdRegex: 'preview-render-markdown', notes: 'MarkdownRenderer' },
  { rel: 'text/sample.csv', category: 'text', ext: 'csv', expectedIdRegex: 'preview-render-spreadsheet', notes: 'XlsxRenderer, CSV auto-detect (row 12)' },
  { rel: 'text/sample.tsv', category: 'text', ext: 'tsv', expectedIdRegex: 'preview-render-spreadsheet', notes: 'XlsxRenderer — TSV delimiter auto-detect not independently confirmed (row 12)' },
  { rel: 'text/sample.json', category: 'text', ext: 'json', expectedIdRegex: 'preview-render-code', notes: 'isText explicit override for application/json (row 11)' },
  { rel: 'text/sample.xml', category: 'text', ext: 'xml', expectedIdRegex: 'preview-render-code', notes: 'isText explicit override for application/xml (row 11)' },
  { rel: 'text/sample.yaml', category: 'text', ext: 'yaml', expectedIdRegex: CODE_OR_FALLBACK, notes: 'not covered by Phase A\'s explicit isText overrides — same OS-mime uncertainty as the code bucket' },
  { rel: 'text/sample.html', category: 'text', ext: 'html', expectedIdRegex: 'preview-render-html-webview', notes: 'WebView source-toggle, now fixed by 1564 (row 13)' },
  { rel: 'text/sample.log', category: 'text', ext: 'log', expectedIdRegex: 'preview-render-code', notes: 'isText override → CodeRenderer plain (row 10)' },

  // ── Code (Phase A row 14: uncertain, depends on OS-reported mime_type) ──
  { rel: 'code/sample.py', category: 'code', ext: 'py', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.go', category: 'code', ext: 'go', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.rs', category: 'code', ext: 'rs', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.ts', category: 'code', ext: 'ts', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.tsx', category: 'code', ext: 'tsx', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.js', category: 'code', ext: 'js', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.java', category: 'code', ext: 'java', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.kt', category: 'code', ext: 'kt', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.swift', category: 'code', ext: 'swift', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.c', category: 'code', ext: 'c', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.cpp', category: 'code', ext: 'cpp', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.h', category: 'code', ext: 'h', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.cs', category: 'code', ext: 'cs', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14 (C# — unlike web, mobile\'s isText has no extension map to have missed)' },
  { rel: 'code/sample.rb', category: 'code', ext: 'rb', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.php', category: 'code', ext: 'php', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.sh', category: 'code', ext: 'sh', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.sql', category: 'code', ext: 'sql', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.css', category: 'code', ext: 'css', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.toml', category: 'code', ext: 'toml', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/sample.ini', category: 'code', ext: 'ini', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14' },
  { rel: 'code/Dockerfile', category: 'code', ext: '(none)', expectedIdRegex: CODE_OR_FALLBACK, notes: 'row 14 — mobile routes on mime_type only, no filename/extension parsing, so this has none of web\'s bare-filename bug' },

  // ── Images ──────────────────────────────────────────────────────────────
  { rel: 'images/sample.png', category: 'image', ext: 'png', expectedIdRegex: 'preview-render-image', notes: 'row 1' },
  { rel: 'images/sample.jpg', category: 'image', ext: 'jpg', expectedIdRegex: 'preview-render-image', notes: 'row 1' },
  { rel: 'images/sample.gif', category: 'image', ext: 'gif', expectedIdRegex: 'preview-render-image', notes: 'row 3 — animation not independently confirmed' },
  { rel: 'images/sample.webp', category: 'image', ext: 'webp', expectedIdRegex: 'preview-render-image', notes: 'row 4' },
  { rel: 'images/sample.heic', category: 'image', ext: 'heic', expectedIdRegex: 'preview-render-image', notes: 'row 2 — ext explicitly listed' },
  { rel: 'images/sample.heif', category: 'image', ext: 'heif', expectedIdRegex: 'preview-render-image', notes: 'row 2 — ext explicitly listed' },
  { rel: 'images/sample.tiff', category: 'image', ext: 'tiff', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 5 — not in the ext allow-list, depends on OS mime' },
  { rel: 'images/sample.bmp', category: 'image', ext: 'bmp', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 5 — not in the ext allow-list, depends on OS mime' },
  { rel: 'images/sample.svg', category: 'image', ext: 'svg', expectedIdRegex: 'preview-render-svg-webview', notes: 'row 6 — WebView, now fixed by 1564 (was the confirmed-blank case Phase A cited)' },

  // ── Media ───────────────────────────────────────────────────────────────
  { rel: 'media/sample.mp4', category: 'media', ext: 'mp4', expectedIdRegex: 'preview-render-video', notes: 'row 8' },
  { rel: 'media/sample.mov', category: 'media', ext: 'mov', expectedIdRegex: 'preview-render-video', notes: 'row 8' },
  { rel: 'media/sample.mp3', category: 'media', ext: 'mp3', expectedIdRegex: 'preview-render-fallback', notes: 'row 9 — no audio player exists on main until 1568 merges' },
  { rel: 'media/sample.m4a', category: 'media', ext: 'm4a', expectedIdRegex: 'preview-render-fallback', notes: 'row 9 — same as mp3' },
  { rel: 'media/sample.wav', category: 'media', ext: 'wav', expectedIdRegex: 'preview-render-fallback', notes: 'row 9 — same as mp3' },

  // ── RAW (Phase A rows 22/23: zero explicit handling, OS-mime dependent) ──
  { rel: 'raw/sample.dng', category: 'raw', ext: 'dng', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 23' },
  { rel: 'raw/sample.nef', category: 'raw', ext: 'nef', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 22' },
  { rel: 'raw/sample.cr2', category: 'raw', ext: 'cr2', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 22 — fetched by raw/fetch-raw.sh' },
  { rel: 'raw/sample.cr3', category: 'raw', ext: 'cr3', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 22 — fetched by raw/fetch-raw.sh' },
  { rel: 'raw/sample.arw', category: 'raw', ext: 'arw', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 22 — fetched by raw/fetch-raw.sh' },
  { rel: 'raw/sample.raf', category: 'raw', ext: 'raf', expectedIdRegex: IMAGE_OR_FALLBACK, notes: 'row 22 — fetched by raw/fetch-raw.sh' },

  // ── PDF ─────────────────────────────────────────────────────────────────
  { rel: 'pdf/sample.pdf', category: 'pdf', ext: 'pdf', expectedIdRegex: 'preview-render-pdf', notes: 'row 7 — react-native-pdf, unaffected by the WebView bug' },

  // ── Archive / binary ────────────────────────────────────────────────────
  { rel: 'archive/sample.zip', category: 'archive', ext: 'zip', expectedIdRegex: 'preview-render-zip', notes: 'row 20 — ZipRenderer (listing)' },
  { rel: 'binary/sample.bin', category: 'binary', ext: 'bin', expectedIdRegex: 'preview-render-fallback', notes: 'row 21 — honest fallback by design' },
]

export const FIXTURES_ROOT_REL = 'e2e/fixtures/preview-matrix'
