// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches the convention in the other src/lib/*.test.ts files).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { formatDate, formatDateTime, zipDosDateAsLocal } from './date-format';

describe('formatDate / formatDateTime (task 1592 item 8)', () => {
  // Local-time construction so the calendar day is the same in every TZ.
  const oct4 = new Date(2026, 9, 4, 22, 45, 15);

  test('spells the month in the locale order — never an all-numeric date', () => {
    expect(formatDate(oct4, 'en-US')).toBe('Oct 4, 2026');
    expect(formatDate(oct4, 'en-GB')).toBe('4 Oct 2026');
    expect(formatDate(oct4, 'nl-NL')).toBe('4 okt 2026');
    for (const locale of ['en-US', 'en-GB', 'nl-NL', 'de-DE']) {
      expect(formatDate(oct4, locale)).not.toMatch(/^\d+[/.-]\d+[/.-]\d+$/);
    }
  });

  test('date-time has hours and minutes, no seconds, in the locale clock', () => {
    const us = formatDateTime(oct4, 'en-US');
    expect(us).toContain('Oct 4, 2026');
    expect(us).toContain('10:45');
    expect(us).toContain('PM');
    expect(us).not.toContain(':15');
    const gb = formatDateTime(oct4, 'en-GB');
    expect(gb).toContain('4 Oct 2026');
    expect(gb).toContain('22:45');
    expect(gb).not.toContain(':15');
  });

  test('no / invalid date → empty string (callers show nothing, never "Invalid Date")', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('not a date')).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDate('2026-10-04T20:45:15Z', 'en-GB')).toMatch(/Oct 2026$/);
  });
});

describe('zipDosDateAsLocal (task 1592 item 7)', () => {
  // `bun test` runs in UTC by default, where the bug is invisible (local ==
  // UTC). The 222 regression was on a CEST device: run these east of UTC.
  const prevTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Amsterdam';
  });
  afterAll(() => {
    process.env.TZ = prevTz;
  });

  test('the harness really is east of UTC (else this block proves nothing)', () => {
    expect(new Date(Date.UTC(2026, 8, 27, 22, 38)).getDate()).toBe(28);
  });

  test('keeps the wall-clock fields JSZip decoded as UTC', () => {
    // JSZip's DataReader.readDate: new Date(Date.UTC(y, m, d, h, min, s)).
    const fromJszip = new Date(Date.UTC(2026, 8, 27, 22, 38, 10));
    const local = zipDosDateAsLocal(fromJszip)!;
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(8);
    expect(local.getDate()).toBe(27);
    expect(local.getHours()).toBe(22);
    expect(local.getMinutes()).toBe(38);
    expect(local.getSeconds()).toBe(10);
  });

  test('a real archive round-trip: an entry written 22:38 local reads 22:38 local', async () => {
    const zip = new JSZip();
    // JSZip WRITES the DOS fields from the UTC getters of the date given…
    zip.file('note.txt', 'hi', { date: new Date(Date.UTC(2026, 8, 27, 22, 38, 0)) });
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const read = await JSZip.loadAsync(bytes);
    // …and READS them back with Date.UTC — so `.date` alone is zone-shifted
    // on any device not at UTC. The helper yields the stored clock time.
    const local = zipDosDateAsLocal(read.files['note.txt'].date)!;
    expect([local.getDate(), local.getHours(), local.getMinutes()]).toEqual([27, 22, 38]);
  });

  test('null / invalid → null', () => {
    expect(zipDosDateAsLocal(null)).toBeNull();
    expect(zipDosDateAsLocal(new Date('x'))).toBeNull();
  });
});
