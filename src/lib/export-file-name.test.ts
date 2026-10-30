// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 2253 — the share sheet must be handed the file's decrypted display
 * name, not the internal file id. These are the naming rules (contract rows
 * 1–2): sanitize for the filesystem ONLY, keep the name exact otherwise.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXPORT_NAME_MAX_BYTES,
  exportFileName,
  exportSubdirectoryName,
  isExportableDisplayName,
  parseExportDisplayName,
  sanitizeExportFileName,
} from './export-file-name';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('sanitizeExportFileName', () => {
  test('a plain name with an extension is kept exactly', () => {
    expect(sanitizeExportFileName('IMG_0042.DNG')).toBe('IMG_0042.DNG');
    expect(sanitizeExportFileName('Quarterly report 2026.pdf')).toBe('Quarterly report 2026.pdf');
  });

  test('a name with no extension stays without one', () => {
    expect(sanitizeExportFileName('README')).toBe('README');
    expect(sanitizeExportFileName('notes.v2')).toBe('notes.v2');
  });

  test('multibyte names survive byte-for-byte (NFC)', () => {
    expect(sanitizeExportFileName('Überweisung März.pdf')).toBe('Überweisung März.pdf');
    expect(sanitizeExportFileName('家族写真.jpg')).toBe('家族写真.jpg');
    // NFD input is normalized to NFC, so the same name always lands on one path.
    const nfd = 'U\u0308berweisung Ma\u0308rz.pdf';
    expect(sanitizeExportFileName(nfd)).toBe('Überweisung März.pdf');
  });

  test('only path-hostile characters become underscores', () => {
    expect(sanitizeExportFileName('a/b:c.txt')).toBe('a_b_c.txt');
    expect(sanitizeExportFileName('back\\slash.md')).toBe('back_slash.md');
    expect(sanitizeExportFileName('tab\there.txt')).toBe('tab_here.txt');
    expect(sanitizeExportFileName('null\u0000byte.txt')).toBe('null_byte.txt');
    // Everything else (spaces, quotes, brackets, emoji) is legal and stays.
    expect(sanitizeExportFileName("it's (1) 🎉.png")).toBe("it's (1) 🎉.png");
  });

  test('trims spaces and dots at both ends, and never yields a dot name', () => {
    expect(sanitizeExportFileName('  padded name.pdf  ')).toBe('padded name.pdf');
    expect(sanitizeExportFileName('...trailing.txt...')).toBe('trailing.txt');
    expect(sanitizeExportFileName('..')).toBe('file');
    expect(sanitizeExportFileName('   ')).toBe('file');
    expect(sanitizeExportFileName('')).toBe('file');
    expect(sanitizeExportFileName('.')).toBe('file');
  });

  test('an empty result keeps the original extension', () => {
    expect(sanitizeExportFileName('  .zip')).toBe('file.zip');
    expect(sanitizeExportFileName('..pdf')).toBe('file.pdf');
    expect(sanitizeExportFileName('/')).toBe('_');
  });

  test('a 300-byte name is capped at 200 UTF-8 bytes with its extension intact', () => {
    const stem = 'a'.repeat(296);
    const out = sanitizeExportFileName(`${stem}.txt`);
    expect(bytes(out)).toBeLessThanOrEqual(EXPORT_NAME_MAX_BYTES);
    expect(out.endsWith('.txt')).toBe(true);
    expect(out).toBe(`${'a'.repeat(EXPORT_NAME_MAX_BYTES - 4)}.txt`);
  });

  test('capping never splits a multibyte character', () => {
    const out = sanitizeExportFileName(`${'家'.repeat(100)}.jpg`);
    expect(bytes(out)).toBeLessThanOrEqual(EXPORT_NAME_MAX_BYTES);
    expect(out.endsWith('.jpg')).toBe(true);
    // 200 - 4 = 196 bytes = 65 chars of 3 bytes, plus the extension.
    expect(out).toBe(`${'家'.repeat(65)}.jpg`);
    expect(out.includes('\ufffd')).toBe(false);
  });
});

describe('exportFileName — display name, or the id name when there is none', () => {
  test('uses the decrypted display name, not the file id', () => {
    expect(exportFileName('IMG_0042.DNG', '640d4f1e-c0cd-4b1e-9e54-1a2b3c4d5e6f.dng')).toBe('IMG_0042.DNG');
  });

  test('falls back to the id-based name when no usable name exists', () => {
    const idName = '640d4f1e-c0cd-4b1e-9e54-1a2b3c4d5e6f.dng';
    expect(exportFileName(null, idName)).toBe(idName);
    expect(exportFileName(undefined, idName)).toBe(idName);
    expect(exportFileName('   ', idName)).toBe(idName);
    // An encrypted envelope is not a name.
    expect(exportFileName('{"nonce":"x","ciphertext":"y"}', idName)).toBe(idName);
  });
});

describe('isExportableDisplayName', () => {
  test('accepts a plain name and rejects blanks and ciphertext envelopes', () => {
    expect(isExportableDisplayName('IMG_0042.DNG')).toBe(true);
    expect(isExportableDisplayName('')).toBe(false);
    expect(isExportableDisplayName('  ')).toBe(false);
    expect(isExportableDisplayName('{"cipher_suite":"x"}')).toBe(false);
    expect(isExportableDisplayName(null)).toBe(false);
  });
});

describe('parseExportDisplayName', () => {
  test('reads the name out of the metadata envelope and legacy bare names', () => {
    expect(parseExportDisplayName('{"name":"IMG_0042.DNG","mime_type":"image/x-adobe-dng"}')).toBe('IMG_0042.DNG');
    expect(parseExportDisplayName('  Report.pdf ')).toBe('Report.pdf');
    expect(parseExportDisplayName('{"mime_type":"application/pdf"}')).toBe(null);
    expect(parseExportDisplayName('')).toBe(null);
  });
});

describe('exportSubdirectoryName', () => {
  test('is random, so two exports of the same name never share a folder', () => {
    const values = [0.11, 0.72];
    let n = 0;
    const a = exportSubdirectoryName(() => values[n++]);
    const b = exportSubdirectoryName(() => values[n++]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
  });
});
