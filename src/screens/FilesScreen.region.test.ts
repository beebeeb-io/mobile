// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1592 item 12 / task 2050 — the file row/grid subtitle shows the file's
// COUNTRY ("AES-256-GCM · Germany"), or "Europe" when the row has none. It never
// reads the `trustLocation()` filler, never a default-pool city, and never
// fetches per row. Same source-text convention as
// PreviewScreen.info-sheet.test.ts: no React reconciler here, so the wiring is
// what these guards check. `storageLocationLabel` / `fileStorageCountry` are
// unit-tested in storage-regions.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'FilesScreen.tsx'), 'utf-8');

describe('row/grid "Stored in" country (task 1592 item 12, task 2050)', () => {
  test('the crypto-meta line no longer reads the trustLocation() filler', () => {
    expect(source).not.toMatch(/AES-256-GCM · \$\{trustLocation/);
  });

  test('both the list row and the grid card read the file\'s own country', () => {
    const occurrences = source.match(/`AES-256-GCM · \$\{storageLocationLabel\(fileStorageCountry\(item\)\)\}`/g) ?? [];
    expect(occurrences.length).toBe(2); // list row + grid card
  });

  test('no region/city state or fetch is left on the screen', () => {
    expect(source).not.toContain('loadRegionCity');
    expect(source).not.toContain('regionCity');
    expect(source).not.toContain('fileStorageCity');
    expect(source).not.toMatch(/\.city\b/);
  });

  test('the country is read at most ONCE per user action: the Details alert, never per row', () => {
    // GET /files/:id for the file's country happens only in the on-demand
    // "Details" alert (a user action), never inside FileRowItem/FileGridItem.
    const calls = source.match(/loadFileStorageLocation\(/g) ?? [];
    expect(calls.length).toBe(1);
    const detailsAt = source.indexOf('const showDetails = async () => {');
    expect(detailsAt).toBeGreaterThan(-1);
    const detailsBody = source.slice(detailsAt, detailsAt + 900);
    expect(detailsBody).toContain('loadFileStorageLocation(item)');
  });

  test('upload activity and toasts carry a place, not a city', () => {
    expect(source).toContain('trustLocation(uploaded.storage_pool_id, uploaded)');
    expect(source).not.toMatch(/stored in \$\{[a-zA-Z.]*\.city\}/);
  });
});
