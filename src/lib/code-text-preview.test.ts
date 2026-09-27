// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1570 — code files always open as text, regardless of mime_type.
// See code-text-preview.ts's own doc comment for why this stays a pure,
// dependency-free module: PreviewScreen.tsx cannot be imported in this
// project's test runner (no React reconciler).
// RED/GREEN mutation proof for this file is pasted in
// .claude/tasks/in-development/1570-mobile-code-file-mime-fallback.md's Notes.
import { describe, expect, test } from 'bun:test';
import {
  CORE_TEXT_EXTENSIONS,
  TEXT_EXTENSION_MIME,
  extensionOf,
  isConfidentlyNonTextMimeType,
  isGenericMimeType,
  isTextLikeExtension,
  isTextPreview,
} from './code-text-preview';

// The 21 real fixtures under e2e/fixtures/preview-matrix/code/ (task 1565's
// fixture set) — filename -> extension `extensionOf` should return for it.
const CODE_FIXTURES: Array<{ file: string; ext: string }> = [
  { file: 'Dockerfile', ext: 'dockerfile' },
  { file: 'sample.c', ext: 'c' },
  { file: 'sample.cpp', ext: 'cpp' },
  { file: 'sample.cs', ext: 'cs' },
  { file: 'sample.css', ext: 'css' },
  { file: 'sample.go', ext: 'go' },
  { file: 'sample.h', ext: 'h' },
  { file: 'sample.ini', ext: 'ini' },
  { file: 'sample.java', ext: 'java' },
  { file: 'sample.js', ext: 'js' },
  { file: 'sample.kt', ext: 'kt' },
  { file: 'sample.php', ext: 'php' },
  { file: 'sample.py', ext: 'py' },
  { file: 'sample.rb', ext: 'rb' },
  { file: 'sample.rs', ext: 'rs' },
  { file: 'sample.sh', ext: 'sh' },
  { file: 'sample.sql', ext: 'sql' },
  { file: 'sample.swift', ext: 'swift' },
  { file: 'sample.toml', ext: 'toml' },
  { file: 'sample.ts', ext: 'ts' },
  { file: 'sample.tsx', ext: 'tsx' },
];

describe('extensionOf', () => {
  test('returns the lowercased extension without the dot', () => {
    expect(extensionOf('sample.PY')).toBe('py');
    expect(extensionOf('sample.Rs')).toBe('rs');
  });

  test('returns the WHOLE lowercased filename for a dotless name (Dockerfile)', () => {
    expect(extensionOf('Dockerfile')).toBe('dockerfile');
    expect(extensionOf('MAKEFILE')).toBe('makefile');
  });

  test('uses the LAST dot for a multi-dot name', () => {
    expect(extensionOf('component.test.tsx')).toBe('tsx');
  });

  test('returns "" for null/undefined/empty', () => {
    expect(extensionOf(null)).toBe('');
    expect(extensionOf(undefined)).toBe('');
    expect(extensionOf('')).toBe('');
  });

  test('a leading-dot dotfile resolves to the part after the dot', () => {
    expect(extensionOf('.gitignore')).toBe('gitignore');
  });
});

describe('isGenericMimeType', () => {
  test('true for null, undefined, and empty string', () => {
    expect(isGenericMimeType(null)).toBe(true);
    expect(isGenericMimeType(undefined)).toBe(true);
    expect(isGenericMimeType('')).toBe(true);
  });

  test('true for application/octet-stream (case-insensitive) — the CLI/web generic mime, task 1570 Case 2', () => {
    expect(isGenericMimeType('application/octet-stream')).toBe(true);
    expect(isGenericMimeType('APPLICATION/OCTET-STREAM')).toBe(true);
  });

  test('true for binary/octet-stream', () => {
    expect(isGenericMimeType('binary/octet-stream')).toBe(true);
  });

  test('false for a confident, specific mime_type', () => {
    expect(isGenericMimeType('text/x-python')).toBe(false);
    expect(isGenericMimeType('image/png')).toBe(false);
  });
});

describe('CORE_TEXT_EXTENSIONS <-> TEXT_EXTENSION_MIME stay in sync', () => {
  // Transcribed VERBATIM from repos/core/beebeeb-core/src/media.rs's
  // `is_previewable_by_extension` (checked 2026-09-27, media.rs:33-63) —
  // the "Text / Markdown" (media.rs:49) and "Code" (media.rs:55-61)
  // sections only (image/video/audio/pdf/office/archive extensions are
  // handled by PreviewScreen's OTHER fileCategory() branches before ever
  // reaching this module, so they're deliberately excluded here). If core
  // adds or removes an extension from that list and this constant isn't
  // updated to match, THIS test is the one that should catch it.
  const CORE_MEDIA_RS_TEXT_AND_CODE_EXTENSIONS = [
    'txt', 'md', 'markdown', 'csv', 'log', 'rtf',
    'py', 'js', 'jsx', 'ts', 'tsx', 'rs', 'go', 'rb', 'java', 'kt', 'swift',
    'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
    'html', 'htm', 'css', 'scss', 'less',
    'vue', 'svelte', 'astro',
    'dart', 'r', 'ex', 'exs', 'zig', 'nim', 'v',
    'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
    'sql', 'graphql', 'proto', 'cmake', 'dockerfile', 'makefile',
  ];

  test('CORE_TEXT_EXTENSIONS matches the transcribed core list exactly (no drift)', () => {
    const here = [...CORE_TEXT_EXTENSIONS].sort();
    const core = [...CORE_MEDIA_RS_TEXT_AND_CODE_EXTENSIONS].sort();
    expect(here).toEqual(core);
  });

  test('every extension core recognizes is ALSO recognized here as text-like', () => {
    for (const ext of CORE_MEDIA_RS_TEXT_AND_CODE_EXTENSIONS) {
      expect(isTextLikeExtension(ext)).toBe(true);
    }
  });

  // Values core's OWN `guess_mime_type` (media.rs:67-137) already defines —
  // transcribed verbatim. Where core defines a value, ours must match it
  // exactly; core's OWN two functions can disagree on a set (is_previewable
  // lists more extensions than guess_mime_type assigns values to) but must
  // never disagree on a VALUE.
  const CORE_GUESS_MIME_TYPE_VALUES: Record<string, string> = {
    txt: 'text/plain',
    csv: 'text/csv',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
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
  };

  test('mime values agree with core.guess_mime_type for every extension core assigns one', () => {
    for (const [ext, coreMime] of Object.entries(CORE_GUESS_MIME_TYPE_VALUES)) {
      expect(TEXT_EXTENSION_MIME[ext]).toBe(coreMime);
    }
  });
});

describe('isConfidentlyNonTextMimeType', () => {
  test('true for image/video/audio prefixes', () => {
    expect(isConfidentlyNonTextMimeType('image/png')).toBe(true);
    expect(isConfidentlyNonTextMimeType('video/mp4')).toBe(true);
    expect(isConfidentlyNonTextMimeType('audio/mpeg')).toBe(true);
  });

  test('true for pdf/zip/archive/legacy-office exact values', () => {
    expect(isConfidentlyNonTextMimeType('application/pdf')).toBe(true);
    expect(isConfidentlyNonTextMimeType('application/zip')).toBe(true);
    expect(isConfidentlyNonTextMimeType('application/x-tar')).toBe(true);
    expect(isConfidentlyNonTextMimeType('application/vnd.ms-excel')).toBe(true);
    expect(isConfidentlyNonTextMimeType('application/msword')).toBe(true);
  });

  test('true for modern office (OOXML) substrings', () => {
    expect(isConfidentlyNonTextMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(isConfidentlyNonTextMimeType('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true);
    expect(isConfidentlyNonTextMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  test('false for empty/generic/unknown-but-not-excluded mime types — the actual task 1570 fix', () => {
    expect(isConfidentlyNonTextMimeType('')).toBe(false);
    expect(isConfidentlyNonTextMimeType('application/octet-stream')).toBe(false);
    expect(isConfidentlyNonTextMimeType('application/sql')).toBe(false);
    expect(isConfidentlyNonTextMimeType('application/javascript')).toBe(false);
  });
});

describe('isTextLikeExtension', () => {
  test('recognizes all 21 code fixture extensions', () => {
    for (const { ext } of CODE_FIXTURES) {
      expect(isTextLikeExtension(ext)).toBe(true);
    }
  });

  test('rejects a real binary extension', () => {
    expect(isTextLikeExtension('bin')).toBe(false);
    expect(isTextLikeExtension('png')).toBe(false);
    expect(isTextLikeExtension('zip')).toBe(false);
  });

  test('rejects the empty extension', () => {
    expect(isTextLikeExtension('')).toBe(false);
  });
});

describe('isTextPreview — the actual PreviewScreen.isText decision', () => {
  describe('Case 1 — phone upload: OS reports no mime_type (undefined/null)', () => {
    for (const { file, ext } of CODE_FIXTURES) {
      test(`${file} (undefined mime_type) -> true`, () => {
        expect(isTextPreview(undefined, file)).toBe(true);
      });
      test(`${file} (null mime_type) -> true`, () => {
        expect(isTextPreview(null, file)).toBe(true);
      });
    }
  });

  describe('Case 2 — CLI/web upload: generic application/octet-stream mime_type', () => {
    for (const { file } of CODE_FIXTURES) {
      test(`${file} (application/octet-stream) -> true`, () => {
        expect(isTextPreview('application/octet-stream', file)).toBe(true);
      });
    }
  });

  test('a confident text/* mime_type still works (unchanged prior behaviour)', () => {
    expect(isTextPreview('text/x-python', 'sample.py')).toBe(true);
    expect(isTextPreview('text/plain', 'notes.txt')).toBe(true);
  });

  test('application/json and application/xml still work without depending on extension', () => {
    expect(isTextPreview('application/json', 'data.whatever')).toBe(true);
    expect(isTextPreview('application/xml', 'data.whatever')).toBe(true);
  });

  test('a confidently NON-text mime_type (image/video/audio/pdf/zip/office) is NEVER overridden by the extension', () => {
    // Guards against ever "fixing" a real image/video by extension collision.
    expect(isTextPreview('image/png', 'sample.py')).toBe(false);
    expect(isTextPreview('video/mp4', 'sample.go')).toBe(false);
    expect(isTextPreview('audio/mpeg', 'sample.rs')).toBe(false);
    expect(isTextPreview('application/pdf', 'sample.java')).toBe(false);
    expect(isTextPreview('application/zip', 'sample.ts')).toBe(false);
    expect(isTextPreview('application/vnd.ms-excel', 'sample.c')).toBe(false);
  });

  describe('regression (task 1570 verification) — a SPECIFIC-but-not-text/-prefixed mime this app itself guessed must not block the extension', () => {
    // The real bug: `media.ts`'s upload-time `guessMimeType` fallback can
    // ITSELF substitute a non-`text/`-prefixed value (e.g. `application/sql`)
    // for a null mime_type before PreviewScreen ever runs. A gate that only
    // deferred to the extension for a GENERIC mime (not this "confident but
    // not text/json/xml" case) reproduced live on-device for `sample.sql`
    // specifically (see this test's Notes entry + code-text-preview.ts's
    // `isTextPreview` doc comment for the full account).
    test('sample.sql with the exact upstream-guessed mime -> true', () => {
      expect(isTextPreview('application/sql', 'sample.sql')).toBe(true);
    });
    test('every non-text/-prefixed value TEXT_EXTENSION_MIME itself assigns still resolves true for its own extension', () => {
      for (const [ext, mime] of Object.entries(TEXT_EXTENSION_MIME)) {
        if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') continue;
        expect(isTextPreview(mime, `sample.${ext}`)).toBe(true);
      }
    });
  });

  test('a generic mime_type on an UNRECOGNIZED extension still falls through (honest "can\'t preview" card)', () => {
    expect(isTextPreview('application/octet-stream', 'archive.bin')).toBe(false);
    expect(isTextPreview(undefined, 'photo.unknownext')).toBe(false);
  });

  test('a generic mime_type with no filename at all is false, not a crash', () => {
    expect(isTextPreview('application/octet-stream', undefined)).toBe(false);
    expect(isTextPreview(undefined, undefined)).toBe(false);
  });

  test('extension matching is case-insensitive', () => {
    expect(isTextPreview(undefined, 'SAMPLE.PY')).toBe(true);
    expect(isTextPreview('APPLICATION/OCTET-STREAM', 'sample.RS')).toBe(true);
  });

  test('Dockerfile (dotless) opens as text under both cases', () => {
    expect(isTextPreview(undefined, 'Dockerfile')).toBe(true);
    expect(isTextPreview('application/octet-stream', 'Dockerfile')).toBe(true);
    expect(isTextPreview(null, 'dockerfile')).toBe(true);
  });
});
