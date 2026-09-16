/**
 * Data-residency region picker data layer (task 1422).
 *
 * Server model (docs/canon/data-residency.md "The truth"): ONE live region
 * today (Falkenstein, Germany), with Helsinki (Finland) and Ede (Netherlands)
 * as committed roadmap regions (decision 1413, 2026-09-13 — Guus: "Coming
 * soon indeed" — keep naming them). `GET /api/v1/regions` (+ `GET
 * /api/v1/me/region` for the user's current preference) is the live source
 * of truth, so a region the server activates appears here without an App
 * Store release. The PLANNED list below exists ONLY to keep the honest
 * "Coming soon" rows for regions the API does not (yet) return — never
 * delete these rows, and never claim a planned region is live before the API
 * actually says so (this is exactly the mistake decision 1413 warns against).
 *
 * A planned region is matched against the live payload by CITY name
 * (case-insensitive), not by continent code: the server groups pools by
 * continent (`storage.rs::list_regions` — one row per continent, `continent`
 * is a coarse code like "europe"/"us"/"asia"), so a newly-live Helsinki pool
 * may or may not get its own distinct continent code depending on how it's
 * provisioned. Matching on city is the one thing that stays correct either
 * way, and it's what actually flips the row from "Coming soon" to live.
 */
import { getAvailableRegions, getUserRegion, setUserRegion, type AvailableRegion } from './api';

export interface PlannedRegion {
  /** Stable UI key. NEVER sent to the server — planned regions are not selectable. */
  id: string;
  label: string;
  /** Matched case-insensitively against a live region's `example_city`. */
  city: string;
}

// Decision 1413 (2026-09-13, Guus: "Coming soon indeed"): keep naming
// Helsinki and Ede as committed roadmap regions. Do NOT delete these rows —
// see docs/canon/data-residency.md "The truth".
export const PLANNED_REGIONS: readonly PlannedRegion[] = [
  { id: 'helsinki-fi', label: 'Helsinki', city: 'Helsinki' },
  { id: 'ede-nl', label: 'Ede', city: 'Ede' },
];

// Shown only when the live fetch fails before anything else has loaded.
// Mirrors today's one real live pool so the picker is never blank or wrong —
// never a fabricated list.
const STATIC_FALLBACK_REGIONS: readonly AvailableRegion[] = [{
  continent: 'europe',
  display_name: 'Europe',
  example_city: 'Falkenstein',
  provider: '',
  is_default: true,
}];

// city -> country, for the same honest "name the city" subtitle web uses
// (docs/canon/data-residency.md — never the hosting provider). Add an entry
// here when a city can appear in the region list, live or coming-soon.
const COUNTRY_BY_CITY: Record<string, string> = {
  falkenstein: 'Germany',
  helsinki: 'Finland',
  ede: 'Netherlands',
};

function locationLabel(city: string): string {
  const country = COUNTRY_BY_CITY[city.toLowerCase()];
  return country ? `${city}, ${country}` : city;
}

export interface RegionRow {
  /** Continent code for a live row (sent to `PUT /me/region`); the matching
   *  `PlannedRegion.id` for a coming-soon row. */
  id: string;
  label: string;
  subtitle: string;
  available: boolean;
  isDefault: boolean;
}

/** Merge a live `/api/v1/regions` payload with the honest coming-soon rows. */
export function mergeRegions(apiRegions: readonly AvailableRegion[]): RegionRow[] {
  const liveCities = new Set(
    apiRegions
      .map((r) => (r.example_city ?? r.city ?? '').toLowerCase())
      .filter(Boolean),
  );

  const liveRows: RegionRow[] = apiRegions.map((r) => ({
    id: r.continent,
    label: r.display_name,
    subtitle: locationLabel(r.example_city ?? r.city ?? r.display_name),
    available: true,
    isDefault: r.is_default,
  }));

  const comingSoonRows: RegionRow[] = PLANNED_REGIONS
    .filter((p) => !liveCities.has(p.city.toLowerCase()))
    .map((p) => ({
      id: p.id,
      label: p.label,
      subtitle: 'Coming soon',
      available: false,
      isDefault: false,
    }));

  return [...liveRows, ...comingSoonRows];
}

/** The picker's rows before any network round-trip completes, and the
 *  fallback shown if the live fetch fails. */
export const DEFAULT_REGION_ROWS: readonly RegionRow[] = mergeRegions(STATIC_FALLBACK_REGIONS);

export interface RegionsData {
  rows: RegionRow[];
  preferredRegion: string | null;
  /** true when the live fetch failed and `rows` is the static fallback, not a real API answer. */
  refreshFailed: boolean;
}

/** Fetch + merge. Never throws — a failed fetch degrades to the static rows. */
export async function loadRegionsData(): Promise<RegionsData> {
  try {
    const [liveRegions, userRegion] = await Promise.all([
      getAvailableRegions(),
      getUserRegion(),
    ]);
    const live = liveRegions.length > 0 ? liveRegions : userRegion.available_regions;
    return {
      rows: mergeRegions(live),
      preferredRegion: userRegion.preferred_region,
      refreshFailed: false,
    };
  } catch {
    return {
      rows: [...DEFAULT_REGION_ROWS],
      preferredRegion: null,
      refreshFailed: true,
    };
  }
}

/** Apply a region selection. No-ops (never calls the API) for a coming-soon row. */
export async function selectRegion(
  row: Pick<RegionRow, 'id' | 'available'>,
): Promise<{ preferred_region: string } | null> {
  if (!row.available) return null;
  return setUserRegion(row.id);
}
