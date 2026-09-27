/**
 * preview-info — pure helpers for the Preview Info sheet (task 1583).
 *
 * Guus's device screenshot (build 219, 2026-09-27) showed the sheet listing
 * machine detail ("Chunks 1"), a row that contradicted the card above it
 * ("Encryption: Decrypted on this device" under "Encrypted on your device"),
 * the version number twice (a "Version" row AND the Versions section), and a
 * storage row that named no city ("Europe · EU region"). The row list and the
 * location label are decided here, dependency-free, so they are unit tested.
 */

export interface InfoRow {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * Detail rows the Info sheet never shows, and why:
 * - Name / Kind / Size: the sheet's own title and subline already say them.
 * - Storage: replaced by the sheet's own "Stored in" row (a named city).
 * - Chunks: an upload implementation detail, not something a person needs.
 * - Encryption: the amber card states it in words; "Decrypted on this device"
 *   under "Encrypted on your device" read as a contradiction.
 * - Version: the Versions section lists every version with its date.
 */
export const INFO_SHEET_HIDDEN_LABELS: readonly string[] = [
  'Name',
  'Kind',
  'Size',
  'Storage',
  'Chunks',
  'Encryption',
  'Version',
];

/** Rows whose value is machine text (brand rule: "if you can't read it aloud, it's mono"). */
const MONO_LABELS: readonly string[] = ['Type'];

/**
 * The Info sheet's extra rows, from the preview's full detail row list:
 * hidden labels dropped, empty values dropped, the first row per label kept,
 * and machine values marked mono. Order is preserved.
 */
export function buildInfoSheetRows(detailRows: readonly InfoRow[]): InfoRow[] {
  const seen = new Set<string>();
  const out: InfoRow[] = [];
  for (const row of detailRows) {
    if (INFO_SHEET_HIDDEN_LABELS.includes(row.label)) continue;
    if (!row.value || !row.value.trim()) continue;
    if (seen.has(row.label)) continue;
    seen.add(row.label);
    out.push({
      label: row.label,
      value: row.value,
      mono: row.mono ?? MONO_LABELS.includes(row.label),
    });
  }
  return out;
}

/** Country for each LIVE storage city (docs/canon/data-residency.md: one
 * live region today). Copy form: "Falkenstein, Germany". A future city
 * reads as the city alone until it is added here. */
const CITY_COUNTRY: Record<string, string> = {
  falkenstein: 'Germany',
};

/** Placeholder city strings that name no place and must never be shown. */
const NOT_A_CITY = new Set(['', 'eu region', 'unknown', 'local']);

/**
 * The "Stored in" value. `region` is `GET /api/v1/region` (the default
 * pool's location — the server documents it as the source for "stored in
 * {city}"); `null` while loading or when the call failed.
 *
 * A known city reads "Falkenstein, Germany"; an unknown real city reads as
 * the city alone; no city at all reads "Europe" — never a filler like
 * "EU region".
 */
export function storageLocationLabel(region: { city?: string | null } | null | undefined): string {
  const city = region?.city?.trim() ?? '';
  if (NOT_A_CITY.has(city.toLowerCase())) return 'Europe';
  const country = CITY_COUNTRY[city.toLowerCase()];
  return country ? `${city}, ${country}` : city;
}

/** Where the Info sheet opens: the top, or scrolled to the Versions section
 * (the bottom bar's "Versions" button and the ⋯ menu's "Version history"). */
export type InfoSheetFocus = 'info' | 'versions';

/**
 * Task 1592 item 2 — how many ACTIVE link shares a file has, for the Info
 * sheet's "Shared" row.
 *
 * The file listings carry `share_count`, but `GET /api/v1/files/:id` did not
 * (server PR 1592 adds it, owner only), so the sheet read `undefined` and
 * said "Not shared" for every file — a false statement about a privacy
 * fact. Order:
 * 1. `share_count` on the single-file response (a server with the fix);
 * 2. otherwise (an older server) the owner's links from
 *    `GET /api/v1/shares/by-file/:id`, counted with the listing's own
 *    definition (`countActiveShareLinks`);
 * 3. otherwise `null` = unknown: the sheet hides the row rather than guess.
 */
export async function resolveInfoShareCount(
  file: { share_count?: number | null },
  fetchLinks: () => Promise<ReadonlyArray<{ expires_at?: string | null }>>,
  now: number = Date.now(),
): Promise<number | null> {
  if (typeof file.share_count === 'number' && Number.isFinite(file.share_count)) {
    return Math.max(0, file.share_count);
  }
  try {
    return countActiveShareLinks(await fetchLinks(), now);
  } catch {
    return null;
  }
}

/** The listing's definition of an active link: no expiry, or an expiry in
 * the future (the server's `expires_at IS NULL OR expires_at > NOW()`). */
export function countActiveShareLinks(
  links: ReadonlyArray<{ expires_at?: string | null }>,
  now: number = Date.now(),
): number {
  return links.filter((l) => {
    if (!l.expires_at) return true;
    const t = Date.parse(l.expires_at);
    return Number.isNaN(t) ? true : t > now;
  }).length;
}
