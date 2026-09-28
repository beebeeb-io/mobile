// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1592 item 11 — "Prove it" said "Hex dump as it lives on disk in EU
// region", a hard-coded filler from `trustLocation()`. Same source-text
// convention as PreviewScreen.info-sheet.test.ts: no React reconciler here,
// so the wiring is what these guards can check; the shared helpers
// (`useRegionCity`, `storageLocationLabel`) are unit-tested where they live
// (storage-region.test.ts, preview-info.test.ts).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'EncryptionProof.tsx'), 'utf-8');

describe('"Stored in" city (task 1592 item 11)', () => {
  test('the pane is wired to the shared region source, not the trustLocation() filler', () => {
    expect(source).toContain("import { useRegionCity } from '../lib/storage-region';");
    expect(source).toContain("import { storageLocationLabel } from '../lib/preview-info';");
    expect(source).toContain('useRegionCity(visible)');
    expect(source).toContain('storageLocationLabel({ city: regionCity ?? null })');
    // The old filler path is gone entirely — no `trustLocation` import or call.
    expect(source).not.toContain('trustLocation');
  });

  test('the hex-dump note reads the resolved city, not a raw pool lookup', () => {
    expect(source).toContain('Hex dump as it lives on disk in {storedInCity}.');
  });

  test('the region hook is called unconditionally (component top level, no guard above it)', () => {
    const at = source.indexOf('const regionCity = useRegionCity(visible);');
    expect(at).toBeGreaterThan(-1);
    const before = source.slice(source.indexOf('export default function EncryptionProof'), at);
    // No early return between the component's start and the hook call.
    expect(before).not.toMatch(/\n\s*if \([^)]*\)\s*return/);
  });
});
