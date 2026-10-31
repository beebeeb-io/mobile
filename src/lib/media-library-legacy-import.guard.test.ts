// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
//
// expo-media-library 57 keeps the old API only under
// `expo-media-library/legacy`; the same names on the main entry point THROW
// at runtime (build/legacyWarnings.js). A screen that still imported the
// main entry and called `getAssetsAsync` swallowed that throw and showed 0
// photos on this iPhone, whatever access the user had granted.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');
const LEGACY_ONLY = [
  'getAssetsAsync', 'getAssetInfoAsync', 'getAlbumsAsync', 'getAlbumAsync', 'createAlbumAsync',
  'createAssetAsync', 'saveToLibraryAsync', 'deleteAssetsAsync', 'addAssetsToAlbumAsync',
  'removeAssetsFromAlbumAsync', 'isAvailableAsync', 'presentPermissionsPickerAsync', 'getMomentsAsync',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('expo-media-library legacy API is imported from /legacy', () => {
  test('no file calls a legacy-only function through the main entry point', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf-8');
      const importsMain = /(?:from\s+|require\()\s*'expo-media-library'/.test(text);
      if (!importsMain) continue;
      for (const fn of LEGACY_ONLY) {
        if (new RegExp(`MediaLibrary\\.${fn}\\b`).test(text)) offenders.push(`${relative(SRC, file)}: ${fn}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
