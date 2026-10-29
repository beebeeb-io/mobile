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
import { choiceMatches, parseChoices, strictExplanation, strictLabel, type StorageRegionChoice } from './storage-regions';

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
  /**
   * Task 2053: "only store in" is on but the stored country is unavailable
   * (not listed, or listed without being selectable). The server REFUSES new
   * uploads (409 `region_unavailable_strict`); it does not place them elsewhere.
   */
  strictRefusal: StrictRefusal | null;
  /** `/me/region` failed, so the current choice is unknown. */
  preferenceLoadFailed: boolean;
  /** Neither the public list nor `/me/region` answered; `rows` is empty. */
  failed: boolean;
}

/** The pinned country that cannot take files while strict is on (task 2053). */
export interface StrictRefusal {
  id: string;
  /** The list's name, else the platform's own name for a two-letter code, else a generic name. */
  name: string;
  /** Still in the server's list (not selectable), as opposed to missing from it. */
  listed: boolean;
}

function strictRefusalFor(
  preferredRegion: string | null,
  strict: boolean,
  unavailable: boolean,
  choices: readonly StorageRegionChoice[],
): StrictRefusal | null {
  if (!strict || !unavailable || preferredRegion == null) return null;
  const id = preferredRegion.trim();
  const wanted = id.toLowerCase();
  const hit = choices.find((c) => !c.is_default && choiceMatches(c, wanted));
  if (hit) return { id, name: hit.name, listed: true };
  let name: string | null = null;
  if (/^[a-z]{2}$/.test(wanted)) {
    try {
      const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(wanted.toUpperCase());
      if (n && n.toUpperCase() !== wanted.toUpperCase()) name = n;
    } catch {
      /* no region names on this runtime: generic name */
    }
  }
  return { id, name: name ?? 'your chosen country', listed: false };
}

/** Honest refusal copy: new uploads are refused, naming the country (never "another data center"). */
export function strictRefusalNote(r: StrictRefusal): string {
  const where = r.name === 'your chosen country' ? 'Your chosen country' : r.name;
  return `${where} can't take new files right now, so new uploads are refused until it is back. Turn this off to allow other EU countries.`;
}

/**
 * What to PUT when "Allow other EU countries" is used. The server re-saves a
 * country it still lists with either strict value, but 400s a value missing
 * from the list: so listed keeps the id, missing sends no preference.
 */
export function allowOthersPayload(r: StrictRefusal): { preferred: string | null; strict: false } {
  return { preferred: r.listed ? r.id : null, strict: false };
}

export async function allowOthers(r: StrictRefusal) {
  const p = allowOthersPayload(r);
  return setUserRegion(p.preferred, p.strict);
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
      strictRefusal: null,
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
  const preferredUnavailable = !preferenceLoadFailed && preferredRegion != null && selectedId === null;
  return {
    rows,
    preferredRegion,
    strict,
    selectedId,
    preferredUnavailable,
    strictRefusal: strictRefusalFor(preferredRegion, strict, preferredUnavailable, choices),
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

/**
 * Whether the "Only store in <country>" switch may be shown, per platform.
 *
 * HIDDEN on iOS (Guus, 2026-10-19, workspace task 2054): with strict on and the
 * chosen country unable to take files, native Camera Backup
 * (`NativeBackupEngine.initUploadSession`) gets the 409 `region_unavailable_strict`,
 * treats it as a plain HTTP failure and dead-letters each asset after 10
 * attempts, silently stranding automatic backups. Android: the app has no native
 * backup path in this repo (the Android crypto module is a stub, Android is
 * post-launch) so its refusal handling cannot be shown to be safe; hidden too.
 * Task 2054 teaches native backup the refusal, then flips these in ONE place.
 */
export const STRICT_PLACEMENT_ON_MOBILE: Record<'ios' | 'android', boolean> = {
  ios: false,
  android: false,
};

function strictAllowedOn(os: string): boolean {
  return os === 'ios' || os === 'android' ? STRICT_PLACEMENT_ON_MOBILE[os] : true;
}

/** `strictSwitchFor`, but null on a platform where strict is hidden. */
export function strictSwitchOnPlatform(rows: readonly RegionRow[], selectedId: string | null, os: string): StrictSwitch | null {
  return strictAllowedOn(os) ? strictSwitchFor(rows, selectedId) : null;
}

/**
 * Where the switch is hidden but the person already has strict on (set on the
 * web or desktop app): one honest, non-interactive line. The app never turns
 * strict off by itself; a country change carries the stored value unchanged.
 */
export function strictNoticeFor(rows: readonly RegionRow[], selectedId: string | null, strict: boolean, os: string): string | null {
  if (!strict || strictAllowedOn(os)) return null;
  const sw = strictSwitchFor(rows, selectedId);
  return sw ? `${sw.label} is on. Change it on the web or desktop app.` : null;
}

/** Copy under the list. */
export const REGION_NOTE =
  'Europe is the default: your files can be stored in any of our European data centers, and we choose. Pick a country to keep new uploads there. Existing files stay where they are. Need to move them? Contact us.';
export const REGION_UNAVAILABLE_NOTE =
  'The country you picked is not available right now. New uploads go to any of our European data centers until it is.';
export const REGION_COUNTRY_HEADER = 'Or choose a country';
export const REGION_COMING_SOON = 'Coming soon';
