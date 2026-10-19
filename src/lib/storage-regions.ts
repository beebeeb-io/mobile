/**
 * Storage location by COUNTRY (task 2050, supersedes the per-datacenter model
 * of task 1919) — the pure model. No imports: everything here is testable
 * without native modules.
 *
 * Product model (Guus, 2026-10-19): "Europe" is the DEFAULT: any of our
 * European data centers, the server places the data. Below it the person can
 * pin new uploads to one COUNTRY (Germany, Finland). A country that is not live
 * yet is listed as coming soon and cannot be chosen. A city is never shown,
 * sent or read: cities together identify the hosting provider
 * (docs/canon/data-residency.md). `no-city-in-copy.guard.test.ts` keeps it so.
 *
 * Everything derives from the server's list (`GET /api/v1/storage-regions`,
 * also `choices` on `GET /api/v1/me/region`). The client keeps NO table of ids
 * or countries: a country that turns live changes the screen without an App
 * Store release.
 */

export type StorageRegionStatus = 'live' | 'coming_soon';

/** One validated entry of the server's list. Never carries a city or a datacenter. */
export interface StorageRegionChoice {
  /** Send verbatim to `PUT /me/region`: `europe`, or a lower-case country code. */
  id: string;
  /** `region` is the default "any" entry; `country` is one specific country. */
  kind: 'region' | 'country';
  /** `Europe`, or the country's name (`Germany`). Never a city. */
  name: string;
  country: string | null;
  country_code: string | null;
  status: StorageRegionStatus;
  selectable: boolean;
  is_default: boolean;
  /**
   * Other stored values that mean this same row (lower case). Empty for a
   * server that speaks countries. An OLDER server (task 1919: one row per
   * datacenter) is folded into countries and keeps its datacenter ids here, so
   * a stored `fsn1` still selects the Germany row.
   */
  aliases: string[];
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function statusOf(v: unknown): StorageRegionStatus | null {
  return v === 'live' || v === 'coming_soon' ? v : null;
}

/**
 * Validate the wire list. Malformed entries are dropped rather than rendered,
 * and a coming-soon entry is never selectable whatever the payload claims.
 * Anything that is not a list (an older server has no `choices`) is empty.
 *
 * An OLDER server sends one `kind: 'datacenter'` entry per datacenter, named
 * after its city. Those are folded into one row per country (named by the
 * country, never the city). An entry with no country cannot be shown without
 * naming a city, so it is dropped. The folded row's id is the first selectable
 * datacenter's id, which that server accepts on PUT.
 */
export function parseChoices(raw: unknown): StorageRegionChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: StorageRegionChoice[] = [];
  const byCountry = new Map<string, StorageRegionChoice>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = text(r.id);
    const status = statusOf(r.status);
    if (!id || !status) continue;
    const selectable = status === 'live' && r.selectable === true;

    if (r.kind === 'region') {
      const name = text(r.name);
      if (!name) continue;
      out.push({
        id,
        kind: 'region',
        name,
        country: null,
        country_code: null,
        status,
        selectable,
        is_default: r.is_default === true,
        aliases: [],
      });
      continue;
    }

    const country = text(r.country);
    if (!country) continue; // an older server's datacenter with no country: not showable without a city

    if (r.kind === 'country') {
      out.push({
        id,
        kind: 'country',
        name: text(r.name) ?? country,
        country,
        country_code: text(r.country_code),
        status,
        selectable,
        is_default: false,
        aliases: [],
      });
      continue;
    }

    // Older server: a datacenter. Fold it into its country.
    const key = (text(r.country_code) ?? country).toLowerCase();
    const existing = byCountry.get(key);
    if (!existing) {
      const row: StorageRegionChoice = {
        id,
        kind: 'country',
        name: country,
        country,
        country_code: text(r.country_code),
        status,
        selectable,
        is_default: false,
        aliases: [id.toLowerCase()],
      };
      byCountry.set(key, row);
      out.push(row);
    } else {
      existing.aliases.push(id.toLowerCase());
      // The row is live as soon as one of its datacenters is, and is sent by that one's id.
      if (selectable && !existing.selectable) {
        existing.id = id;
        existing.status = 'live';
        existing.selectable = true;
      }
    }
  }
  return out;
}

/** Does the stored value (lower case) mean this row? */
export function choiceMatches(choice: StorageRegionChoice, wanted: string): boolean {
  return choice.id.toLowerCase() === wanted || choice.aliases.includes(wanted);
}

/** The label shown for a stored location: the country's name, else "Europe". Never a city. */
export function storageLocationLabel(country: string | null | undefined): string {
  const c = typeof country === 'string' ? country.trim() : '';
  return c === '' || c.toLowerCase() === 'unknown' ? 'Europe' : c;
}

/**
 * Where a file REALLY is: the country of the server's `storage_location` on a
 * file response. Absent, malformed or "Unknown" is no country: we never guess
 * one, and we never read the (deprecated) city an older or transitional server
 * may still send next to it.
 */
export function fileStorageCountry(file: unknown): string | null {
  if (!file || typeof file !== 'object') return null;
  const loc = (file as { storage_location?: unknown }).storage_location;
  if (!loc || typeof loc !== 'object') return null;
  const country = (loc as { country?: unknown }).country;
  if (typeof country !== 'string') return null;
  const trimmed = country.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
  return trimmed;
}

/** "Only store in Germany". The name is the server's; the client keeps no country table. */
export function strictLabel(countryName: string): string {
  return `Only store in ${countryName}`;
}

/** The explanation under the strict switch. Off by default. */
export function strictExplanation(countryName: string): string {
  return `Off by default. If ${countryName} cannot take a new file, the upload stops instead of going to another EU country.`;
}

/**
 * The 409 `region_unavailable_strict` refusal in words: names the COUNTRY the
 * server sent (`country`, never the deprecated `city` alias) and says what to
 * do. Null when the error is not that refusal.
 */
export function strictRefusalMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; details?: unknown };
  if (e.code !== 'region_unavailable_strict') return null;
  const d = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
  const country = text(d.country);
  const where = country ?? 'Your chosen country';
  return `${where} can't take new files right now, so this upload stopped. Your choice is set to only ${country ?? 'that country'}. Try again later, or allow other EU countries in Settings.`;
}

/**
 * The native uploader's error envelope carries only `{ status, code, message }`
 * (NativeManualUploader.swift), not the refusal's `country`. The server's own
 * sentence for this one refusal starts with the country ("Germany can't take new
 * files right now, ..."), so the name is read back from it. Anything that does
 * not look like that sentence yields no country, and the copy says "Your chosen
 * country" instead of guessing.
 */
export function strictCountryFromMessage(message: string | null | undefined): string | null {
  const m = /^(.{1,60}?) can't take new files right now/.exec(typeof message === 'string' ? message.trim() : '');
  return m ? text(m[1]) : null;
}
