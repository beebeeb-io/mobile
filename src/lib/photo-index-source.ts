/**
 * photo-index-source — where the Photos tab gets its row list from (task 1959).
 *
 * Extracted from PhotosScreen.tsx (`getPhotoCandidates`) so the network
 * behaviour of the Photos tab's focus refresh is unit-testable without
 * rendering the screen. It reads the vault index through
 * `file-index-loader.ts`, which coalesces the per-focus requests (in-flight
 * dedupe + a revalidation window + the hash path). Before task 1959 this
 * called GET /files/index on every focus of the Photos tab.
 */

import { ApiError, getAllImages } from './api';
import type { FileEntry } from './api';
import type { CachedFileIndex } from './file-index-cache';
import { loadFileIndex } from './file-index-loader';
import { photoCandidatesFromIndex } from './photo-candidates';
import { filterByExcludedFolders, filterByExcludedFoldersDirect } from './photo-library-filter';

export interface PhotoCandidatesOptions {
  /** Explicit refresh (pull-to-refresh, retry after a bulk action found
   *  missing rows): ask the server even inside the revalidation window. */
  force?: boolean;
}

export async function getPhotoCandidates(
  cachedIndex?: CachedFileIndex | null,
  excludedFolderIds?: Set<string>,
  options: PhotoCandidatesOptions = {},
): Promise<FileEntry[]> {
  const excluded = excludedFolderIds ?? new Set<string>();
  try {
    const { files } = await loadFileIndex({
      force: options.force,
      // Round 4: a photo uploaded inside the window must show on the next
      // focus. Rows the sync write-through added carry no `is_media`; ones
      // this device uploaded are classified locally, any other forces a
      // revalidation (file-index-loader.ts).
      revalidateUnclassified: true,
      ...(cachedIndex !== undefined ? { cached: cachedIndex } : {}),
    });
    if (files) {
      // Pass the FULL index (folder rows included) so exclusion is transitive.
      return filterByExcludedFolders(files, photoCandidatesFromIndex(files), excluded);
    }
  } catch (err) {
    // Older API builds do not have /files/index yet. Because /files/{id}
    // also exists, those builds may treat "index" as a UUID and return 400
    // instead of 404. Fall back to the media endpoint in all unsupported-route
    // cases, but keep auth/network/server errors visible.
    if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 404 && err.status !== 405)) {
      throw err;
    }
  }

  // Legacy /files/media path has no folder tree — degrade to direct-parent
  // exclusion (transitive exclusion only matters on the index path above).
  return filterByExcludedFoldersDirect(await getAllImages(), excluded);
}
