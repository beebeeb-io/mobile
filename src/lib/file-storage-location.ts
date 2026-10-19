/**
 * Task 1919 review (mobile#178, P1), by COUNTRY since task 2050 — the location
 * of ONE file's ciphertext.
 *
 * Rows built from the CRDT tree (`FilesScreen.syncNodeToFileEntry`) carry no
 * per-file `storage_location`, so a sheet fed only the row could not say which
 * country the file is in. The server's `GET /api/v1/files/:id` returns it
 * (`{ country, country_code }`); this completes the row from there. A failed
 * fetch, or a server that names no country, yields `null` and the caller
 * shows "Europe". A city is never read.
 */
import { useEffect, useState } from 'react';
import { getFile, type FileEntry } from './api';
import { fileStorageCountry } from './storage-regions';

export type FileStorageLocation = NonNullable<FileEntry['storage_location']>;
type FileFetcher = (id: string) => Promise<Pick<FileEntry, 'storage_location'>>;
type FileLike = { id: string; storage_location?: FileEntry['storage_location'] };

export async function loadFileStorageLocation(
  file: FileLike,
  fetchFile: FileFetcher = getFile,
): Promise<FileStorageLocation | null> {
  if (fileStorageCountry(file) !== null) return file.storage_location ?? null;
  try {
    const full = await fetchFile(file.id);
    return fileStorageCountry(full) !== null ? (full.storage_location ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The file's own storage location while `file` is set (a sheet is open for
 * it); `null` until known, or when it cannot be read. Re-reads per file id.
 */
export function useFileStorageLocation(file: FileLike | null | undefined): FileStorageLocation | null {
  const [state, setState] = useState<{ id: string; loc: FileStorageLocation | null } | null>(null);
  const id = file?.id ?? null;
  useEffect(() => {
    if (!file || !id) return;
    let cancelled = false;
    void loadFileStorageLocation(file).then((loc) => {
      if (!cancelled) setState({ id, loc });
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the id: a re-render with a fresh row object for the same file
    // must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return state && state.id === id ? state.loc : null;
}
