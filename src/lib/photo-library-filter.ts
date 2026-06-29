/**
 * Pure folder-inclusion filter helpers for the Photos tab (task 0885).
 *
 * Kept dependency-free (no expo / react-native imports) so the unit test can
 * run under `bun test` without dragging in native modules — the persistence
 * side (SecureStore) lives in `photo-library-prefs.ts`, which re-exports these.
 */

/** Cap the ancestor walk to guard against cyclic parent links in the index. */
const MAX_ANCESTOR_WALK = 64;

/** Minimal shape of a folder row from the file index. */
export interface FolderIndexEntry {
  id: string;
  is_folder?: boolean;
  parent_id?: string | null;
}

/** Minimal shape of any entry that carries a parent folder reference. */
export interface ParentedEntry {
  parent_id?: string | null;
}

function toExcludedSet(excludedIds: Iterable<string>): Set<string> {
  return excludedIds instanceof Set ? excludedIds : new Set(excludedIds);
}

/** Build a child→parent map from the folder rows of a file index. */
export function buildFolderParentMap(indexFiles: FolderIndexEntry[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const entry of indexFiles) {
    if (entry.is_folder) {
      map.set(entry.id, entry.parent_id ?? null);
    }
  }
  return map;
}

/**
 * True when `parentId` — or any of its ancestors — is in `excludedIds`. Walks
 * the parent chain via `parentById`, capped at MAX_ANCESTOR_WALK and guarded
 * against cycles.
 */
export function isAncestorExcluded(
  parentId: string | null | undefined,
  excludedIds: Set<string>,
  parentById: Map<string, string | null>,
): boolean {
  if (excludedIds.size === 0) return false;
  let current = parentId ?? null;
  let depth = 0;
  const seen = new Set<string>();
  while (current && depth < MAX_ANCESTOR_WALK) {
    if (excludedIds.has(current)) return true;
    if (seen.has(current)) break; // cycle guard
    seen.add(current);
    current = parentById.get(current) ?? null;
    depth += 1;
  }
  return false;
}

/**
 * Drop candidate entries that live in (or under) an excluded folder. Exclusion
 * is TRANSITIVE: excluding `Music` hides every album cover under it. Requires
 * the FULL index (folder rows) to walk ancestry — pass `index.files`, not just
 * the media candidates.
 */
export function filterByExcludedFolders<T extends ParentedEntry>(
  indexFiles: FolderIndexEntry[],
  candidates: T[],
  excludedIds: Iterable<string>,
): T[] {
  const excluded = toExcludedSet(excludedIds);
  if (excluded.size === 0) return candidates;
  const parentById = buildFolderParentMap(indexFiles);
  return candidates.filter((entry) => !isAncestorExcluded(entry.parent_id, excluded, parentById));
}

/**
 * Direct-parent-only exclusion, for the legacy `/files/media` fallback which
 * returns media rows without the folder tree. Transitive exclusion degrades to
 * one level on ancient servers — acceptable since the index path is primary.
 */
export function filterByExcludedFoldersDirect<T extends ParentedEntry>(
  candidates: T[],
  excludedIds: Iterable<string>,
): T[] {
  const excluded = toExcludedSet(excludedIds);
  if (excluded.size === 0) return candidates;
  return candidates.filter((entry) => !(entry.parent_id != null && excluded.has(entry.parent_id)));
}

/**
 * Count media files contained by each ancestor folder, for the settings list.
 * Each media file contributes to every folder on its parent chain so toggling
 * either `Music` or `Music/<album>` is meaningful (both show a count). Returns
 * a map of folderId → media count (folders that contain no media are absent).
 */
export function mediaCountByFolder(
  indexFiles: FolderIndexEntry[],
  mediaCandidates: ParentedEntry[],
): Map<string, number> {
  const parentById = buildFolderParentMap(indexFiles);
  const counts = new Map<string, number>();
  for (const media of mediaCandidates) {
    let current = media.parent_id ?? null;
    let depth = 0;
    const seen = new Set<string>();
    while (current && depth < MAX_ANCESTOR_WALK) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
      if (seen.has(current)) break; // cycle guard
      seen.add(current);
      current = parentById.get(current) ?? null;
      depth += 1;
    }
  }
  return counts;
}
