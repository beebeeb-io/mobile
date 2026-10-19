// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1592 item 11 / task 2050 — "Prove it" said "Hex dump as it lives on disk
// in EU region", a hard-coded filler from `trustLocation()`; it now names the
// file's COUNTRY (or "Europe"), never a city. Same source-text convention as
// PreviewScreen.info-sheet.test.ts: no React reconciler here, so the wiring is
// what these guards can check; the shared helpers (`storageLocationLabel`,
// `fileStorageCountry`) are unit-tested where they live (storage-regions.test.ts).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'EncryptionProof.tsx'), 'utf-8');

describe('"Stored in" country (task 1592 item 11, task 2050)', () => {
  test('the pane reads the file\'s own country, not the trustLocation() filler or a default city', () => {
    expect(source).toContain("import { storageLocationLabel, fileStorageCountry } from '../lib/storage-regions';");
    expect(source).toContain('storageLocationLabel(fileStorageCountry(file))');
    // The old paths are gone entirely: filler, shared region city, per-file city.
    expect(source).not.toContain('trustLocation');
    expect(source).not.toContain('useRegionCity');
    expect(source).not.toContain('fileStorageCity');
  });

  test('the hex-dump note reads the resolved place, not a raw pool lookup', () => {
    expect(source).toContain('Hex dump as it lives on disk in {storedInPlace}.');
  });
});
