// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1592 item 12 — the file row/grid subtitle read "AES-256-GCM · Europe ·
// EU region", the `trustLocation()` filler, while the Info sheet, Encryption
// details sheet and this same screen's own Details alert had already moved
// to the shared GET /api/v1/region source (item 4 / the earlier 1592 lane).
// Same source-text convention as PreviewScreen.info-sheet.test.ts: no React
// reconciler here, so the wiring — and that it is ONE fetch, not one per row
// — is what these guards check. `storageLocationLabel` itself is unit-tested
// in preview-info.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'FilesScreen.tsx'), 'utf-8');

describe('row/grid "Stored in" city (task 1592 item 12)', () => {
  test('the crypto-meta line no longer reads the trustLocation() filler', () => {
    expect(source).not.toMatch(/AES-256-GCM · \$\{trustLocation/);
    // trustLocation is still imported/used by the (unrelated) upload-toast
    // flow elsewhere in this screen — this only pins that the ROW text does
    // not call it any more.
  });

  test('both the list row and the grid card read the shared, cached region label', () => {
    const occurrences = source.match(/`AES-256-GCM · \$\{storageLocationLabel\(\{ city: regionCity \}\)\}`/g) ?? [];
    expect(occurrences.length).toBe(2); // list row + grid card
  });

  test('the region is fetched exactly ONCE for the whole screen — not per row', () => {
    // One state slot, populated by one effect with an empty dependency array
    // (runs once per screen mount), reusing lib/storage-region.ts's own
    // module-level cache/in-flight de-dupe for any other caller.
    expect(source).toContain('const [regionCity, setRegionCity] = useState<string | null>(null);');
    const effectStart = source.indexOf('const [regionCity, setRegionCity] = useState<string | null>(null);');
    const effectBody = source.slice(effectStart, effectStart + 400);
    expect(effectBody).toContain('loadRegionCity()');
    expect(effectBody).toMatch(/\}, \[\]\);/);
    // Exactly two call sites in the whole file: this effect, and the
    // pre-existing per-file "Details" alert (an on-demand user action, not a
    // per-row render) — never one inside FileRowItem/FileGridItem itself.
    const calls = source.match(/loadRegionCity\(\)/g) ?? [];
    expect(calls.length).toBe(2);
  });

  test('regionCity is threaded down as a prop, not read again inside the row/grid components', () => {
    expect(source).toMatch(/regionCity: string \| null;\s*\n\}\n\nconst FileRowItem/);
    expect(source).toMatch(/regionCity: string \| null;\s*\n\}\n\nconst FileGridItem/);
    // Passed at both render call sites…
    const propPasses = source.match(/\n\s*regionCity=\{regionCity\}\s*\n\s*\/>/g) ?? [];
    expect(propPasses.length).toBe(2);
    // …and closed over in both memoized callbacks' dependency arrays, so a
    // resolved fetch actually re-renders the visible rows.
    const rowCbStart = source.indexOf('const renderFileRow = useCallback');
    const rowCbEnd = source.indexOf(']);', rowCbStart);
    expect(source.slice(rowCbStart, rowCbEnd + 3)).toContain('regionCity]);');
    const gridCbStart = source.indexOf('const renderFileGrid = useCallback');
    const gridCbEnd = source.indexOf(']);', gridCbStart);
    expect(source.slice(gridCbStart, gridCbEnd + 3)).toContain('regionCity]);');
  });
});
