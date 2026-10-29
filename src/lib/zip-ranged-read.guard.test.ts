// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 2233 item 6 — the zip preview must never load the archive into JS.
 *
 * This is the guard that keeps the regression from coming back: it pins the
 * data path (a ranged source + a central-directory listing) and the absence of
 * the whole-archive APIs the old implementation used.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('zip preview data path', () => {
  const renderer = read('src/components/preview/ZipRenderer.tsx');
  const screen = read('src/screens/PreviewScreen.tsx');

  test('ZipRenderer takes a ranged source + listing, not an ArrayBuffer', () => {
    expect(renderer).toContain('source: ByteSource');
    expect(renderer).toContain('listing: ZipListing');
    expect(renderer).not.toContain('data: ArrayBuffer');
  });

  test('ZipRenderer no longer loads JSZip', () => {
    expect(renderer).not.toContain("from 'jszip'");
    expect(renderer).not.toContain('JSZip');
  });

  test('PreviewScreen lists through readZipListing and keeps the file on disk', () => {
    expect(screen).toContain('readZipListing(');
    expect(screen).toContain('openZipFileSource(');
    // The zip effect must not hand the archive to an ArrayBuffer read.
    const zipEffect = screen.slice(screen.indexOf('// Auto-load ZIP archives'), screen.indexOf('const zipSourceRef'));
    expect(zipEffect).not.toContain('readFileAsArrayBuffer');
  });

  test('PreviewScreen has the too-large state with its own copy', () => {
    expect(screen).toContain('This archive is too large to preview here. Save it to open it in another app.');
    expect(screen).toContain('zip-too-large-save');
  });
});
