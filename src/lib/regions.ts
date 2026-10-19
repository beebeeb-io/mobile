/**
 * Data-residency picker data layer (task 1919, by COUNTRY since task 2050).
 *
 * Product model (Guus, 2026-10-19): "Europe" is the DEFAULT. It means no
 * specific country, any of our European data centers; the server places the
 * files. Below it the user can choose one COUNTRY. Countries that are not live
 * yet are listed as "coming soon" and cannot be chosen. "Only store in
 * <country>" (strict, task 1952) is an off-by-default promise that a new file
 * never goes to another country.
 *
 * EVERYTHING comes from the API. `GET /api/v1/storage-regions` (public) is the
 * list, `GET /api/v1/me/region` is the user's preference and strict flag (and
 * carries the same list as `choices`). This file keeps no list of its own: no
 * static ids, no country table, no planned/coming-soon rows. When the server
 * lists a country, or flips one from coming soon to live, the picker changes
 * without an App Store release. A city is never shown, sent or read, and the
 * provider is never named (src/lib/storage-regions.ts folds an older server's
 * per-datacenter entries into countries).
 *
 * If nothing can be fetched the picker shows no rows and says so (it never
 * invents a list).
 */
import { getStorageRegions, getUserRegion, setUserRegion } from './api';
import { parseChoices, strictExplanation, strictLabel, type StorageRegionChoice } from './storage-regions';

export interface RegionRow {
  /** The server id, sent verbatim to `PUT /me/region`. */
  id: string;
  /** "Europe" or the country's name. Never a city. */
  label: string;
  /** Explanation under the label; empty for a country. */
  subtitle: string;
  /** Selectable: the server says it is live AND selectable. */
  available: boolean;
  comingSoon: boolean;
  /** True only for the "Europe" row (the server's `is_default`). */
  isDefault: boolean;
  /** A specific country (can be made strict), as opposed to the Europe row. */
  isCountry: boolean;
  /** Other stored values meaning this row (an older server's datacenter ids). */
  aliases: readonly string[];
}

/** The Europe row's explanation. Same words as the web app. */
export const EUROPE_SUBTITLE = 'Any of our European data centers. We place your files.';

/** Turn the (parsed) API list into picker rows. Order is the server's order. */
export function buildRegionRows(choices: readonly StorageRegionChoice[]): RegionRow[] {
  return choices.map((c) => ({
    id: c.id,
    label: c.name,
    subtitle: c.kind === 'region' ? EUROPE_SUBTITLE : '',
    available: c.selectable === true && c.status === 'live',
    comingSoon: c.status === 'coming_soon',
    isDefault: c.is_default === true,
    isCountry: c.kind === 'country',
    aliases: c.aliases,
  }));
}

/**
 * Which row shows as selected. No stored preference means the default
 * (Europe) row. A stored country that the API no longer lists as selectable
 * selects NOTHING: showing Europe would misstate the saved value.
 */
export function effectiveSelection(
  rows: readonly RegionRow[],
  preferredRegion: string | null,
): string | null {
  if (preferredRegion == null) {
    return rows.find((r) => r.isDefault && r.available)?.id ?? null;
  }
  const wanted = preferredRegion.trim().toLowerCase();
  return rows.find((r) => r.available && (r.id.toLowerCase() === wanted || r.aliases.includes(wanted)))?.id ?? null;
}

export interface RegionsData {
  rows: RegionRow[];
  /** The stored value from the server: null, "europe" or a country id. */
  preferredRegion: string | null;
  /** "Only store in <country>" is on (task 1952). False when unknown. */
  strict: boolean;
  /** Row id to show as selected, or null. */
  selectedId: string | null;
  /** A country is stored but the API does not list it as selectable now. */
  preferredUnavailable: boolean;
  /** `/me/region` failed, so the current choice is unknown. */
  preferenceLoadFailed: boolean;
  /** Neither the public list nor `/me/region` answered; `rows` is empty. */
  failed: boolean;
}

/** Fetch the list + the preference. Never throws. */
export async function loadRegionsData(): Promise<RegionsData> {
  const [list, pref] = await Promise.allSettled([getStorageRegions(), getUserRegion()]);

  let choices: StorageRegionChoice[] | null = null;
  if (list.status === 'fulfilled' && Array.isArray(list.value)) {
    choices = parseChoices(list.value);
  } else if (pref.status === 'fulfilled' && Array.isArray(pref.value.choices)) {
    choices = parseChoices(pref.value.choices);
  }

  if (!choices) {
    return {
      rows: [],
      preferredRegion: null,
      strict: false,
      selectedId: null,
      preferredUnavailable: false,
      preferenceLoadFailed: pref.status === 'rejected',
      failed: true,
    };
  }

  const rows = buildRegionRows(choices);
  const preferenceLoadFailed = pref.status === 'rejected';
  const preferredRegion = pref.status === 'fulfilled' ? (pref.value.preferred_region ?? null) : null;
  const strict = pref.status === 'fulfilled' && pref.value.region_strict === true;
  // With an unknown preference (offline / failed) select nothing rather than guess.
  const selectedId = preferenceLoadFailed ? null : effectiveSelection(rows, preferredRegion);
  return {
    rows,
    preferredRegion,
    strict,
    selectedId,
    preferredUnavailable: !preferenceLoadFailed && preferredRegion != null && selectedId === null,
    preferenceLoadFailed,
    failed: false,
  };
}

/**
 * Apply a selection. No-ops (never calls the API) for a coming-soon row.
 * PUT replaces the whole choice, so "only store in" is carried across to
 * another COUNTRY (`strict`) and ends when the person goes back to Europe.
 */
export async function selectRegion(
  row: Pick<RegionRow, 'id' | 'available' | 'isCountry'>,
  strict = false,
): Promise<{ preferred_region: string | null; region_strict?: boolean } | null> {
  if (!row.available) return null;
  return setUserRegion(row.id, row.isCountry && strict);
}

/** Turn "only store in" on or off for the country that is currently chosen. */
export async function setStrict(
  row: Pick<RegionRow, 'id' | 'available' | 'isCountry'>,
  strict: boolean,
): Promise<{ preferred_region: string | null; region_strict?: boolean } | null> {
  if (!row.available || !row.isCountry) return null;
  return setUserRegion(row.id, strict);
}

/** The "Only store in <country>" switch: shown only while a specific, available country is selected. */
export interface StrictSwitch {
  row: RegionRow;
  label: string;
  explanation: string;
}

export function strictSwitchFor(rows: readonly RegionRow[], selectedId: string | null): StrictSwitch | null {
  const row = selectedId == null ? undefined : rows.find((r) => r.id === selectedId);
  if (!row || !row.isCountry || !row.available) return null;
  return { row, label: strictLabel(row.label), explanation: strictExplanation(row.label) };
}

/** Copy under the list. */
export const REGION_NOTE =
  'Europe is the default: your files can be stored in any of our European data centers, and we choose. Pick a country to keep new uploads there. Existing files stay where they are. Need to move them? Contact us.';
export const REGION_UNAVAILABLE_NOTE =
  'The country you picked is not available right now. New uploads go to any of our European data centers until it is.';
export const REGION_COUNTRY_HEADER = 'Or choose a country';
export const REGION_COMING_SOON = 'Coming soon';
