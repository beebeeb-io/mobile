// @ts-nocheck — bun runs this; `bun:test` types + `import.meta.dir` are not
// in the Expo tsconfig (same convention as the other *.guard.test.ts files).
/**
 * SF-0002 part 1 — every file id minted in the iOS sources is lowercase.
 *
 * `UUID().uuidString` is uppercase. A file id is used as the bytes of the
 * master-key derivation (`deriveFileKey(fileId: Data(fileId.utf8))`), so a
 * mint that reaches key derivation in uppercase while the upload body sends
 * `fileId.lowercased()` seals the file under a key no reader derives. The
 * File Provider created Files-app files that way since 0eaf5cf2; the Share
 * extension and the backup engines already minted `.lowercased()`.
 *
 * This guard scans every `UUID().uuidString` in the two source trees that can
 * mint an upload id (`targets/` and `modules/beebeeb-crypto/ios/`). A mint
 * that is a file id — `let fileId = ...`, or any other mint not allow-listed
 * below — must call `.lowercased()`. Temporary path components, the video
 * `UID:` line and the thumbnail self-test probe are allow-listed by their own
 * line content, the way the existing guards keep their exceptions explicit.
 *
 * The last test re-runs the scanner on a mutated copy of the File Provider
 * source, so the guard itself is proven able to go red.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SOURCE_ROOTS = [join(ROOT, 'targets'), join(ROOT, 'modules', 'beebeeb-crypto', 'ios')];

/** A `UUID().uuidString` site that does not mint a file id, matched on its line. */
const NON_FILE_ID_CONTEXTS = [
  /appendingPathComponent/, // a temp path component, never an id
  /NSTemporaryDirectory/, // a temp path, never an id
  /purgePendingMarkerName/, // plaintext-purge marker file names
  /"UID:/, // a calendar iCalendar UID line
  /selftest-/, // the thumbnail service self-test probe
];

export type CaseViolation = { file: string; line: number; text: string; reason: string };

/** Every un-lowercased file-id mint in `source` (one Swift file's text). */
export function fileIdCaseViolations(source: string, file = '<memory>'): CaseViolation[] {
  const violations: CaseViolation[] = [];
  source.split('\n').forEach((text, index) => {
    if (!text.includes('UUID().uuidString')) return;
    const isFileId = /\b(let|var)\s+(fileId|file_id)\b/.test(text);
    if (isFileId) {
      if (!text.includes('.lowercased()')) {
        violations.push({ file, line: index + 1, text: text.trim(), reason: 'file id mint is not lowercased' });
      }
      return;
    }
    if (NON_FILE_ID_CONTEXTS.some((pattern) => pattern.test(text))) return;
    if (!text.includes('.lowercased()')) {
      violations.push({ file, line: index + 1, text: text.trim(), reason: 'uuid mint is neither a lowercased id nor an allow-listed temp/probe use' });
    }
  });
  return violations;
}

function swiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.name.endsWith('.swift') ? [path] : [];
  });
}

const files = SOURCE_ROOTS.flatMap(swiftFiles);
const sources = files.map((file) => ({ file: file.slice(ROOT.length + 1), source: readFileSync(file, 'utf8') }));

describe('SF-0002 part 1: iOS file-id mints are lowercase', () => {
  test('the guard actually scanned the iOS sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    const sites = sources.reduce((count, { source }) => count + source.split('\n').filter((line) => line.includes('UUID().uuidString')).length, 0);
    expect(sites).toBeGreaterThanOrEqual(15);
  });

  test('0 un-lowercased file-id mints', () => {
    const violations = sources.flatMap(({ file, source }) => fileIdCaseViolations(source, file));
    expect(violations).toEqual([]);
  });

  test('the known mint sites are covered: File Provider, Share extension both copies, both backup paths', () => {
    const all = sources.map(({ file, source }) => `${file}\n${source}`).join('\n');
    expect(all).toContain('targets/file-provider/FileProviderExtension.swift');
    expect(all).toContain('targets/share-extension/ShareUploader.swift');
    expect(all).toContain('modules/beebeeb-crypto/ios/NativeBackupEngine.swift');
    expect(all).toContain('modules/beebeeb-crypto/ios/NativeEncryptedBackupUploader.swift');
    const lowercasedMints = sources.reduce(
      (count, { source }) => count + source.split('\n').filter((line) => /\b(let|var)\s+(fileId|file_id)\b/.test(line) && line.includes('.lowercased()')).length,
      0,
    );
    expect(lowercasedMints).toBeGreaterThanOrEqual(5);
  });
});

describe('the scanner goes RED on the pre-fix mint (guard red-proof)', () => {
  test('dropping .lowercased() from the File Provider mint is a violation', () => {
    const real = readFileSync(join(ROOT, 'targets', 'file-provider', 'FileProviderExtension.swift'), 'utf8');
    const mutated = real.replace('let fileId = UUID().uuidString.lowercased()', 'let fileId = UUID().uuidString');
    expect(mutated).not.toBe(real);
    const violations = fileIdCaseViolations(mutated, 'targets/file-provider/FileProviderExtension.swift');
    expect(violations.length).toBe(1);
    expect(violations[0].text).toBe('let fileId = UUID().uuidString');
    expect(violations[0].reason).toBe('file id mint is not lowercased');
  });

  test('an allow-listed temp path stays allowed', () => {
    const lines = [
      '          .appendingPathComponent("\\(cached.id)-\\(UUID().uuidString)")',
      '      let outputPath = NSTemporaryDirectory() + "video-thumb-\\(UUID().uuidString).webp"',
      '      let probeFile = "selftest-\\(UUID().uuidString)"',
    ].join('\n');
    expect(fileIdCaseViolations(lines)).toEqual([]);
  });

  test('a new un-lowercased id variable outside the known context is a violation', () => {
    const violations = fileIdCaseViolations('      let newId = UUID().uuidString');
    expect(violations.length).toBe(1);
  });
});
