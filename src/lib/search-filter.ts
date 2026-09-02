/**
 * Client-side helpers for the 1338b bottom search bar: filter-by-kind and
 * match highlighting.
 *
 * There is no server-side "kind" filter to call — the encrypted search index
 * (`search-index.ts`) returns name/path/type matches only, and `fileCategory`
 * (`media.ts`) is itself already a client-side MIME-type bucket computed over
 * already-decrypted metadata. Filtering by kind here is the same trust
 * boundary as the search match itself: it runs over files FilesScreen has
 * already decrypted into `displayedFiles`, never a new server round-trip.
 */

import type { fileCategory } from './media'

/** The seven buckets `fileCategory` already produces. */
export type FileKind = ReturnType<typeof fileCategory>

/**
 * The capsule row shown under the bottom search bar. `fileCategory` has no
 * bucket finer than these seven, and the canvas names no capsule for audio —
 * `documents` is the catch-all for pdf/doc/audio/file so every kind has a
 * home without inventing a capsule the design doesn't show.
 */
export type SearchFilterKind = 'all' | 'folders' | 'photos' | 'videos' | 'documents'

export const SEARCH_FILTER_KINDS: ReadonlyArray<{ value: SearchFilterKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'folders', label: 'Folders' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'documents', label: 'Documents' },
]

/** Whether a file of the given category should show under the chosen filter kind. */
export function matchesSearchFilterKind(category: FileKind, kind: SearchFilterKind): boolean {
  switch (kind) {
    case 'all':
      return true
    case 'folders':
      return category === 'folder'
    case 'photos':
      return category === 'image'
    case 'videos':
      return category === 'video'
    case 'documents':
      return category === 'pdf' || category === 'doc' || category === 'audio' || category === 'file'
  }
}

/**
 * Merge relevance-ranked encrypted-search-index matches with unranked local
 * name-substring fallback matches, then apply the kind filter — as PURE,
 * order-preserving operations only. This function's whole reason to exist is
 * that it cannot call any kind of "sort by date/name/size" — there is no
 * `sortOrder` parameter, nothing to accidentally thread one through. Ranking
 * is the caller's contract: `vaultResults` must already be in the order the
 * search index wants shown (best match first), and this function preserves
 * that order verbatim for every item that survives the kind filter, only
 * appending `localFallback` items (in their own given order) after it.
 *
 * This exists because `FilesScreen.tsx`'s first 1338b draft called
 * `applySortOrder` over the merged, already-ranked list — which reads as
 * harmless (it is the same list, just re-sorted) but silently threw away
 * relevance in favour of the user's ambient browsing sort (date-desc by
 * default), so the best match for a query could sink to the bottom of the
 * results. Routing the merge through here, with no sort concept in scope,
 * makes that regression impossible to reintroduce without deleting this
 * function's only job.
 */
export function mergeRankedSearchResults<T extends { id: string }>(
  vaultResults: readonly T[],
  localFallback: readonly T[],
  categoryOf: (item: T) => FileKind,
  kind: SearchFilterKind,
): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const item of [...vaultResults, ...localFallback]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return kind === 'all' ? merged : merged.filter((item) => matchesSearchFilterKind(categoryOf(item), kind))
}

export interface HighlightSplit {
  before: string
  match: string
  after: string
}

/**
 * Split `name` around the first case-insensitive occurrence of `query`, for
 * the amber match highlight in a search result row. Returns null when there
 * is no query or no match — the caller renders the plain name then.
 *
 * Only the first occurrence is highlighted (matching the single-term queries
 * this bar is built for); a name with no match still renders correctly since
 * `renderEmpty` already tells the story with a dedicated empty state.
 */
export function splitForHighlight(name: string, query: string): HighlightSplit | null {
  const q = query.trim()
  if (!q) return null
  const index = name.toLowerCase().indexOf(q.toLowerCase())
  if (index === -1) return null
  return {
    before: name.slice(0, index),
    match: name.slice(index, index + q.length),
    after: name.slice(index + q.length),
  }
}
