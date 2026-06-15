// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches the convention in the other src/lib/*.test.ts files).
import { describe, expect, test } from 'bun:test';
import { levelRows, isMacOsNoise, type ZipEntry } from './zip-tree';

// Helper: a ZipEntry as parseZip would produce (dir paths have NO trailing slash).
const e = (path: string, isFolder = false): ZipEntry => ({
  path,
  name: path.split('/').pop() ?? path,
  isFolder,
  uncompressedSize: isFolder ? 0 : 10,
  modifiedAt: null,
  ext: '',
});

const label = (rows: ReturnType<typeof levelRows>) =>
  rows.map((r) => (r.kind === 'folder' ? `d:${r.name}` : `f:${r.entry.name}`));

describe('zip-tree levelRows (task 0779)', () => {
  // No explicit dir entries — folders must be IMPLIED from the file paths.
  const implied = [
    e('Ai-iris/logo.png'),
    e('Ai-iris/brand/colors.pdf'),
    e('Ai-iris/brand/type/font.ttf'),
    e('README.txt'),
  ];

  test('root: implied top folder (descendant-file count) + top-level file, folders first', () => {
    const rows = levelRows(implied, '');
    expect(label(rows)).toEqual(['d:Ai-iris', 'f:README.txt']);
    const folder = rows[0];
    expect(folder.kind === 'folder' && folder.fileCount).toBe(3);
  });

  test('drilling into a nested folder shows only its immediate children', () => {
    expect(label(levelRows(implied, 'Ai-iris/'))).toEqual(['d:brand', 'f:logo.png']);
  });

  test('deeper levels resolve correctly', () => {
    expect(label(levelRows(implied, 'Ai-iris/brand/'))).toEqual(['d:type', 'f:colors.pdf']);
    expect(label(levelRows(implied, 'Ai-iris/brand/type/'))).toEqual(['f:font.ttf']);
  });

  test('explicit dir entries are not duplicated by the implied derivation', () => {
    const withDirs = [e('docs', true), e('docs/a.txt'), e('docs/sub', true), e('docs/sub/b.txt')];
    expect(levelRows(withDirs, '').filter((r) => r.kind === 'folder').length).toBe(1); // single 'docs'
    expect(label(levelRows(withDirs, 'docs/'))).toEqual(['d:sub', 'f:a.txt']);
  });
});

describe('isMacOsNoise (task 0779)', () => {
  test('flags __MACOSX + ._ AppleDouble, keeps real content', () => {
    expect(isMacOsNoise('__MACOSX/Ai-iris/._logo.png')).toBe(true);
    expect(isMacOsNoise('__MACOSX')).toBe(true);
    expect(isMacOsNoise('Ai-iris/._cover.jpg')).toBe(true);
    expect(isMacOsNoise('._top')).toBe(true);
    expect(isMacOsNoise('Ai-iris/logo.png')).toBe(false);
    expect(isMacOsNoise('notes._draft.txt')).toBe(false); // ._ mid-name is real content
  });
});
