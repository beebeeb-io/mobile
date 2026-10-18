/**
 * photo-index-source — where the Photos tab gets its row list from (task 1959).
 *
 * Extracted from PhotosScreen.tsx (`getPhotoCandidates`) so the network
 * behaviour of the Photos tab's focus refresh is unit-testable without
 * rendering the screen.
 */

import { ApiError, getAllImages, getFileIndex } from './api';
import type { FileEntry } from './api';
import { loadCachedFileIndex, saveCachedFileIndex, type CachedFileIndex } from './file-index-cache';
import { photoCandidatesFromIndex } from './photo-candidates';
import { filterByExcludedFolders, filterByExcludedFoldersDirect } from './photo-library-filter';

export async function getPhotoCandidates(
  cachedIndex?: CachedFileIndex | null,
  excludedFolderIds?: Set<string>,
): Promise<FileEntry[]> {
  const excluded = excludedFolderIds ?? new Set<string>();
  try {
    const existingIndex = cachedIndex ?? await loadCachedFileIndex();
    const index = await getFileIndex(existingIndex?.hash);
    if (!index.changed && existingIndex) {
      // Pass the FULL index (folder rows included) so exclusion is transitive.
      return filterByExcludedFolders(
        existingIndex.files,
        photoCandidatesFromIndex(existingIndex.files),
        excluded,
      );
    }
    if (index.files) {
      await saveCachedFileIndex(index.hash, index.files);
      return filterByExcludedFolders(
        index.files,
        photoCandidatesFromIndex(index.files),
        excluded,
      );
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
