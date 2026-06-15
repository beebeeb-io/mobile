/**
 * useSearchIndex — fetches the encrypted vault search index once the vault
 * is unlocked, holds it in state, and exposes `search(query)` for incremental
 * client-side querying as the user types.
 *
 * Mutating helpers (`indexFile`, `unindexFile`) keep the in-memory index up
 * to date when the user uploads or deletes files. Persistence to the server
 * is debounced — the index is uploaded at most once per `SAVE_DEBOUNCE_MS`
 * after the last edit so a burst of uploads doesn't trigger a burst of PUTs.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useCrypto } from './crypto-context'
import {
  createEmptyIndex,
  fetchIndex,
  removeIndexEntry,
  saveIndex,
  searchIndex,
  updateIndexEntry,
  type SearchIndex,
  type SearchIndexEntry,
  type SearchResult,
} from './search-index'

const SAVE_DEBOUNCE_MS = 1500

export interface UseSearchIndex {
  /** True once the first fetch attempt has settled (success OR failure). */
  ready: boolean
  /** Run a client-side query against the in-memory index. */
  search: (query: string) => SearchResult[]
  /** Insert/update an entry; schedules a debounced server save. */
  indexFile: (fileId: string, entry: SearchIndexEntry) => void
  /** Remove an entry; schedules a debounced server save. */
  unindexFile: (fileId: string) => void
  /** Ids currently present in the in-memory index — for the full-vault reconcile
   *  (task 0778A) that back-fills files added on another client. */
  getIndexedIds: () => Set<string>
}

export function useSearchIndex(): UseSearchIndex {
  const { isUnlocked, getIndexKey } = useCrypto()
  const indexRef = useRef<SearchIndex | null>(null)
  const indexKeyRef = useRef<Uint8Array | null>(null)
  const [ready, setReady] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch the index from the server as soon as the vault is unlocked. If the
  // user signs out and back in we throw away the previous in-memory copy and
  // refetch with the new master key.
  useEffect(() => {
    if (!isUnlocked) {
      indexRef.current = null
      indexKeyRef.current = null
      setReady(false)
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const indexKey = await getIndexKey()
        if (cancelled) return
        indexKeyRef.current = indexKey

        const fetched = await fetchIndex(indexKey)
        if (cancelled) return
        indexRef.current = fetched ?? createEmptyIndex()
      } catch {
        // Non-fatal — search just falls back to empty results until next
        // unlock. The local-folder filter still works.
        indexRef.current = createEmptyIndex()
      } finally {
        if (!cancelled) setReady(true)
      }
    })()

    return () => { cancelled = true }
  }, [isUnlocked, getIndexKey])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const idx = indexRef.current
      const key = indexKeyRef.current
      if (!idx || !key) return
      void saveIndex(idx, key).catch(() => { /* swallow */ })
    }, SAVE_DEBOUNCE_MS)
  }, [])

  const search = useCallback((query: string): SearchResult[] => {
    const idx = indexRef.current
    if (!idx) return []
    return searchIndex(idx, query)
  }, [])

  const getIndexedIds = useCallback((): Set<string> => {
    const idx = indexRef.current
    return new Set(idx ? Object.keys(idx.files) : [])
  }, [])

  const indexFile = useCallback((fileId: string, entry: SearchIndexEntry) => {
    if (!indexRef.current) return
    indexRef.current = updateIndexEntry(indexRef.current, fileId, entry)
    scheduleSave()
  }, [scheduleSave])

  const unindexFile = useCallback((fileId: string) => {
    if (!indexRef.current) return
    indexRef.current = removeIndexEntry(indexRef.current, fileId)
    scheduleSave()
  }, [scheduleSave])

  // Flush any pending save when the consumer unmounts (best-effort).
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [])

  return { ready, search, indexFile, unindexFile, getIndexedIds }
}
