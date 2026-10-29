/**
 * date-format — dates shown to people, in the DEVICE locale's own form
 * (task 1592 item 8).
 *
 * A bare `toLocaleString()` printed a share link's expiry as
 * "4/10/2026, 22:45:15": all-numeric, so it reads as 10 April to one person
 * and 4 October to another, with seconds nobody needs. These helpers keep the
 * device locale's order and words (`undefined` locale = the device's) but
 * always spell the month, so the date cannot be misread: "Oct 4, 2026" on an
 * en-US device, "4 Oct 2026" on en-GB, "4 okt 2026" on nl-NL.
 *
 * `locale` is only for tests; product code passes nothing.
 */

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** "Oct 4, 2026" (en-US) · "4 Oct 2026" (en-GB) — or '' for no/invalid date. */
export function formatDate(value: Date | string | number | null | undefined, locale?: string): string {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Date plus hours:minutes (no seconds), in the locale's own clock (12/24 h). */
export function formatDateTime(value: Date | string | number | null | undefined, locale?: string): string {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * A ZIP entry's time, as the wall-clock time it was written with (task 1592
 * item 7).
 *
 * The ZIP format stores an MS-DOS date/time: the LOCAL time of the machine
 * that made the archive, with no time zone. JSZip 3 (`DataReader.readDate`)
 * decodes those fields with `Date.UTC(...)`, i.e. it treats local time as
 * UTC; on a device east of UTC a file made at 22:38 on Sep 27 then displays
 * as Sep 28. The honest reading of a zone-less time is "that clock time
 * here", so the UTC fields JSZip filled are re-read as local fields.
 */
export function zipDosDateAsLocal(jszipDate: Date | null | undefined): Date | null {
  if (!jszipDate || isNaN(jszipDate.getTime())) return null;
  return new Date(
    jszipDate.getUTCFullYear(),
    jszipDate.getUTCMonth(),
    jszipDate.getUTCDate(),
    jszipDate.getUTCHours(),
    jszipDate.getUTCMinutes(),
    jszipDate.getUTCSeconds(),
  );
}
