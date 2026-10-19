// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1919 review (mobile#178, P1) — the Encryption details sheet must name
// the COUNTRY of THIS file's pool (task 2050). Same source-text convention as
// EncryptionProof.test.ts (no React reconciler here); the fetch logic itself
// is unit-tested in src/lib/file-storage-location.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'TrustDetailsSheet.tsx'), 'utf-8');

describe('"Stored in" is the file\'s own country (task 1919 review, task 2050)', () => {
  test('the sheet completes the row with the file\'s storage location', () => {
    expect(source).toContain("import { useFileStorageLocation } from '../lib/file-storage-location';");
    expect(source).toContain('useFileStorageLocation(shown?.file)');
  });

  test('both the "Stored in" row and the nested Prove it pane read the completed file', () => {
    expect(source).toContain('storageLocationLabel(fileStorageCountry(detailFile))');
    expect(source).not.toContain('fileStorageCity');
    expect(source).not.toContain('useRegionCity');
    expect(source).toMatch(/<EncryptionProof\s+file=\{detailFile\}/);
  });

  test('the hooks run at the component top level, before the early return', () => {
    const hook = source.indexOf('useFileStorageLocation(');
    const early = source.indexOf('if (!shown) return null;');
    expect(hook).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(hook);
  });
});
