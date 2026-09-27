// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 item 2 — "Prove it" must reuse the preview's cache key so it
 * never writes a second plaintext copy. Mutation evidence: task 1593 Notes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { extensionForMime, previewCacheName, previewDecryptExtension } from './preview-cache-key';
import { fileCategory } from './file-category';

const root = join(import.meta.dir, '..');
const previewSource = readFileSync(join(root, 'screens/PreviewScreen.tsx'), 'utf8');
const proofSource = readFileSync(join(root, 'components/EncryptionProof.tsx'), 'utf8');

describe('previewDecryptExtension — the preview cache key', () => {
  test('a Markdown file is cached as .txt (the preview key), not .md (the old Prove-it key)', () => {
    expect(previewDecryptExtension('text/markdown', 'notes.md')).toBe('txt');
    expect(previewDecryptExtension(null, 'notes.md')).toBe('txt');
  });

  test('photo / pdf keys match what the preview writes', () => {
    expect(previewDecryptExtension('image/jpeg', 'IMG_0001.JPG')).toBe('jpg');
    expect(previewDecryptExtension('image/png', 'shot.png')).toBe('png');
    expect(previewDecryptExtension('application/pdf', 'contract.pdf')).toBe('pdf');
  });

  test('equals the preview formula `extensionForMime(...) || cacheFileName`, dot stripped', () => {
    const cases: Array<[string | undefined, string]> = [
      ['text/markdown', 'notes.md'],
      ['image/heic', 'IMG.HEIC'],
      ['audio/mpeg', 'song.mp3'],
      [undefined, 'photo.CR2'],
      ['application/octet-stream', 'blob.xyz'],
      [undefined, 'README'],
    ];
    for (const [mime, name] of cases) {
      const category = fileCategory(mime, name);
      const expected = (extensionForMime(mime, category, name) || previewCacheName(name, mime, category)).replace(/^\./, '');
      expect(previewDecryptExtension(mime, name)).toBe(expected);
    }
  });
});

describe('both callers use the one key', () => {
  test('PreviewScreen decrypts the original under previewDecryptExtension and has no private copy of the helpers', () => {
    expect(previewSource).toMatch(/const decryptExt = previewDecryptExtension\(currentMimeType, currentFileName\);/);
    expect(previewSource).not.toMatch(/function extensionForMime\(/);
    expect(previewSource).not.toMatch(/function previewCacheName\(/);
    expect(previewSource).not.toMatch(/ext \|\| cacheFileName/);
  });

  test('EncryptionProof decrypts under previewDecryptExtension, never a name-derived extension', () => {
    expect(proofSource).toMatch(/previewDecryptExtension\(mimeType \?\? file\.mime_type \?\? guessMimeType\(fileName\), fileName\)/);
    expect(proofSource).not.toMatch(/fileName\.split\('\.'\)\.pop\(\)/);
  });
});
