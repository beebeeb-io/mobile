// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1569 — RAW camera preview. See raw-format.ts's own doc comment for
// why this stays a pure, dependency-free module: PreviewScreen.tsx cannot
// be imported in this project's test runner (no React reconciler).
// RED/GREEN mutation proof for this file is pasted in
// .claude/tasks/in-development/1569-mobile-raw-camera-preview.md's Notes.
import { describe, expect, test } from 'bun:test';
import { extensionForRaw, extensionOfFileName, isRawExtension, rawFormatLabel } from './raw-format';

describe('extensionOfFileName', () => {
  test('returns the lowercased extension without the dot', () => {
    expect(extensionOfFileName('sample.CR2')).toBe('cr2');
  });

  test('returns "" for a name with no extension', () => {
    expect(extensionOfFileName('Dockerfile')).toBe('');
  });

  test('returns "" for a name ending in a bare dot', () => {
    expect(extensionOfFileName('sample.')).toBe('');
  });

  test('returns "" for null/undefined', () => {
    expect(extensionOfFileName(null)).toBe('');
    expect(extensionOfFileName(undefined)).toBe('');
  });

  test('uses the LAST dot for a multi-dot name', () => {
    expect(extensionOfFileName('holiday.photo.dng')).toBe('dng');
  });
});

describe('isRawExtension', () => {
  test('recognizes all six task-1569 RAW extensions', () => {
    for (const ext of ['cr2', 'cr3', 'arw', 'nef', 'raf', 'dng']) {
      expect(isRawExtension(ext)).toBe(true);
    }
  });

  test('is case-insensitive', () => {
    expect(isRawExtension('CR2')).toBe(true);
    expect(isRawExtension('Dng')).toBe(true);
  });

  test('rejects a common non-RAW image extension', () => {
    expect(isRawExtension('jpg')).toBe(false);
    expect(isRawExtension('heic')).toBe(false);
  });

  test('rejects an unrelated RAW-adjacent extension not in this task\'s scope', () => {
    expect(isRawExtension('orf')).toBe(false);
    expect(isRawExtension('rw2')).toBe(false);
  });
});

describe('rawFormatLabel', () => {
  test('sample.cr2 -> Canon RAW', () => {
    expect(rawFormatLabel('sample.cr2')).toBe('Canon RAW');
  });

  test('sample.cr3 -> Canon RAW', () => {
    expect(rawFormatLabel('sample.cr3')).toBe('Canon RAW');
  });

  test('sample.arw -> Sony RAW', () => {
    expect(rawFormatLabel('sample.arw')).toBe('Sony RAW');
  });

  test('sample.nef -> Nikon RAW', () => {
    expect(rawFormatLabel('sample.nef')).toBe('Nikon RAW');
  });

  test('sample.raf -> Fujifilm RAF', () => {
    expect(rawFormatLabel('sample.raf')).toBe('Fujifilm RAF');
  });

  test('sample.dng -> Adobe DNG', () => {
    expect(rawFormatLabel('sample.dng')).toBe('Adobe DNG');
  });

  test('extension wins over a mismatched mime hint', () => {
    expect(rawFormatLabel('sample.cr2', 'image/x-adobe-dng')).toBe('Canon RAW');
  });

  test('falls back to a mime vendor hint when the filename has no known extension', () => {
    expect(rawFormatLabel('IMG_0001', 'image/x-sony-arw')).toBe('Sony RAW');
  });

  test('falls back to the generic label when neither extension nor mime hints at a vendor', () => {
    expect(rawFormatLabel('IMG_0001', 'application/octet-stream')).toBe('RAW Image');
    expect(rawFormatLabel(null, null)).toBe('RAW Image');
  });

  test('extension match is case-insensitive', () => {
    expect(rawFormatLabel('SAMPLE.DNG')).toBe('Adobe DNG');
  });
});

describe('extensionForRaw', () => {
  test('returns the real extension with a leading dot, for each RAW type', () => {
    expect(extensionForRaw('sample.cr2')).toBe('.cr2');
    expect(extensionForRaw('sample.cr3')).toBe('.cr3');
    expect(extensionForRaw('sample.arw')).toBe('.arw');
    expect(extensionForRaw('sample.nef')).toBe('.nef');
    expect(extensionForRaw('sample.raf')).toBe('.raf');
    expect(extensionForRaw('sample.dng')).toBe('.dng');
  });

  test('is case-insensitive and normalizes to lowercase', () => {
    expect(extensionForRaw('SAMPLE.CR2')).toBe('.cr2');
  });

  test('falls back to .dng when the filename has no RAW extension', () => {
    expect(extensionForRaw('IMG_0001')).toBe('.dng');
    expect(extensionForRaw(null)).toBe('.dng');
  });
});
