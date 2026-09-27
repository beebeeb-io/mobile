// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1583 — Info sheet rows + "Stored in" label.
import { describe, expect, test } from 'bun:test';
import { buildInfoSheetRows, countActiveShareLinks, resolveInfoShareCount, storageLocationLabel } from './preview-info';
import { formatShareStatus } from './preview-chrome';

// The detail rows PreviewScreen builds for Guus's screenshot file
// (_MGL8754.jpg, build 219), in the order `mediaDetailsRows` pushes them.
const jpegDetailRows = [
  { label: 'Name', value: '_MGL8754.jpg' },
  { label: 'Kind', value: 'Image' },
  { label: 'Format', value: '.JPG' },
  { label: 'Type', value: 'image/jpeg' },
  { label: 'Size', value: '10 MB' },
  { label: 'Created', value: 'Sep 27, 2026 at 12:52' },
  { label: 'Version', value: 'v1' },
  { label: 'Chunks', value: '1' },
  { label: 'Encryption', value: 'Decrypted on this device' },
  { label: 'Storage', value: 'Europe · EU region' },
];

describe('buildInfoSheetRows', () => {
  test('keeps only the rows a person reads, in order', () => {
    expect(buildInfoSheetRows(jpegDetailRows).map((r) => r.label)).toEqual(['Format', 'Type', 'Created']);
  });

  test('drops Chunks, the contradicting Encryption row and the duplicate Version row', () => {
    const labels = buildInfoSheetRows(jpegDetailRows).map((r) => r.label);
    expect(labels).not.toContain('Chunks');
    expect(labels).not.toContain('Encryption');
    expect(labels).not.toContain('Version');
    expect(labels).not.toContain('Storage');
  });

  test('marks the MIME type mono and leaves readable values proportional', () => {
    const rows = buildInfoSheetRows(jpegDetailRows);
    expect(rows.find((r) => r.label === 'Type')?.mono).toBe(true);
    expect(rows.find((r) => r.label === 'Created')?.mono).toBe(false);
  });

  test('keeps RAW camera rows (design: "Info shows camera, lens and exposure")', () => {
    const rows = buildInfoSheetRows([
      { label: 'Camera', value: 'NIKON D850' },
      { label: 'Lens', value: '24-70mm' },
      { label: 'ISO', value: '100' },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['Camera', 'Lens', 'ISO']);
  });

  test('drops empty values and keeps the first row per label', () => {
    const rows = buildInfoSheetRows([
      { label: 'Created', value: 'Sep 1' },
      { label: 'Created', value: 'Sep 2' },
      { label: 'Lens', value: '  ' },
    ]);
    expect(rows).toEqual([{ label: 'Created', value: 'Sep 1', mono: false }]);
  });

  test('an explicit mono flag wins', () => {
    expect(buildInfoSheetRows([{ label: 'Created', value: 'x', mono: true }])[0].mono).toBe(true);
  });
});

describe('storageLocationLabel', () => {
  test('names the city and country from GET /api/v1/region', () => {
    expect(storageLocationLabel({ city: 'Falkenstein' })).toBe('Falkenstein, Germany');
  });

  test('is case-insensitive on the city lookup but keeps the server spelling', () => {
    expect(storageLocationLabel({ city: 'FALKENSTEIN' })).toBe('FALKENSTEIN, Germany');
  });

  test('an unknown real city is shown as the city alone', () => {
    expect(storageLocationLabel({ city: 'Springfield' })).toBe('Springfield');
  });

  test('never shows a filler like "EU region" — no city reads "Europe"', () => {
    expect(storageLocationLabel(null)).toBe('Europe');
    expect(storageLocationLabel(undefined)).toBe('Europe');
    expect(storageLocationLabel({})).toBe('Europe');
    expect(storageLocationLabel({ city: 'EU region' })).toBe('Europe');
    expect(storageLocationLabel({ city: 'Unknown' })).toBe('Europe');
    expect(storageLocationLabel({ city: ' ' })).toBe('Europe');
  });
});

describe('resolveInfoShareCount — the Info sheet "Shared" row (task 1592 item 2)', () => {
  const NOW = Date.parse('2026-09-27T22:00:00Z');
  const never = async () => {
    throw new Error('must not fetch when the server sent share_count');
  };

  test('a server with the fix: share_count on the single-file response is used as-is', async () => {
    expect(await resolveInfoShareCount({ share_count: 2 }, never, NOW)).toBe(2);
    expect(await resolveInfoShareCount({ share_count: 0 }, never, NOW)).toBe(0);
  });

  test('an older server (no share_count): counts the owner\'s active links instead of saying "Not shared"', async () => {
    const links = [
      { expires_at: null },
      { expires_at: '2026-10-04T20:45:15Z' },
      { expires_at: '2026-09-20T00:00:00Z' }, // expired — the listing does not count it
    ];
    const count = await resolveInfoShareCount({}, async () => links, NOW);
    expect(count).toBe(2);
    expect(formatShareStatus(count)).toBe('Shared · 2 links');
  });

  test('share state unknown (fetch fails, e.g. not the owner) → null, the row is hidden', async () => {
    const count = await resolveInfoShareCount(
      { share_count: undefined },
      async () => {
        throw new Error('404');
      },
      NOW,
    );
    expect(count).toBeNull();
  });

  test('countActiveShareLinks mirrors `expires_at IS NULL OR expires_at > NOW()`', () => {
    expect(countActiveShareLinks([], NOW)).toBe(0);
    expect(countActiveShareLinks([{ expires_at: '2026-09-27T22:00:00Z' }], NOW)).toBe(0);
    expect(countActiveShareLinks([{ expires_at: '2026-09-27T22:00:01Z' }, {}], NOW)).toBe(2);
  });
});
