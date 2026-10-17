/**
 * Task 1919 review (mobile#178, P1) — the location of ONE file's ciphertext.
 *
 * Rows built from the CRDT tree (`FilesScreen.syncNodeToFileEntry`) carry no
 * per-file `storage_location`, and with several live datacenters the default
 * pool's city is withheld (storage-region.ts), so a sheet fed only the row
 * said "Europe" for a file that sits in another datacenter. The server's
 * `GET /api/v1/files/:id` returns the city of the pool the file landed in;
 * this completes the row from there. A failed fetch, or a server that names
 * no place, yields `null` and the caller falls back as before.
 */
import { useEffect, useState } from 'react';
import { getFile, type FileEntry } from './api';
import { fileStorageCity } from './preview-info';

export type FileStorageLocation = NonNullable<FileEntry['storage_location']>;
type FileFetcher = (id: string) => Promise<Pick<FileEntry, 'storage_location'>>;
type FileLike = { id: string; storage_location?: FileEntry['storage_location'] };

export async function loadFileStorageLocation(
  file: FileLike,
  fetchFile: FileFetcher = getFile,
): Promise<FileStorageLocation | null> {
  if (fileStorageCity(file, null) !== null) return file.storage_location ?? null;
  try {
    const full = await fetchFile(file.id);
    return fileStorageCity(full, null) !== null ? (full.storage_location ?? null) : null;
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
