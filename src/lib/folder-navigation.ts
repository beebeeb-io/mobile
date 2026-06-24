export interface BreadcrumbEntry {
  id: string | null;
  name: string;
}

export interface FolderBreadcrumbTarget {
  id: string;
  name: string;
}

export interface FolderListEntry {
  id: string;
  is_folder: boolean;
  parent_id?: string | null;
}

export interface VisibleFolderRequestState<T> {
  visibleFolderKey: string;
  rows: readonly T[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

export type VisibleFolderRequestEvent<T> =
  | { type: 'start'; requestParentId: string | null; isRefresh?: boolean; hasVisibleRows?: boolean }
  | { type: 'success'; requestParentId: string | null; rows: readonly T[] }
  | { type: 'error'; requestParentId: string | null; error: string; renderedCachedIndex?: boolean }
  | { type: 'finally'; requestParentId: string | null };

export interface VisibleFolderRequestTransition<T> {
  state: VisibleFolderRequestState<T>;
  applied: boolean;
}

export function folderCacheKey(parentId: string | null): string {
  return parentId ?? 'root';
}

/**
 * Push a folder onto the breadcrumb stack while keeping the path cycle-safe.
 *
 * Bad legacy/sync data can expose the currently-open folder (or one of its
 * ancestors) as a child row. Re-opening that row must be idempotent/jump back,
 * not append `Backups > Backups > ...` forever.
 */
export function appendFolderToBreadcrumbStack<T extends BreadcrumbEntry>(
  stack: readonly T[],
  folder: FolderBreadcrumbTarget,
): BreadcrumbEntry[] {
  const existingIndex = stack.findIndex((entry) => entry.id === folder.id);
  if (existingIndex >= 0) return stack.slice(0, existingIndex + 1);
  return [...stack, { id: folder.id, name: folder.name }];
}

/** Hide impossible folder rows where a folder is listed as its own child. */
export function filterSelfChildEntries<T extends FolderListEntry>(
  entries: readonly T[],
  parentId: string | null,
): T[] {
  if (parentId == null) return [...entries];
  return entries.filter((entry) => !(entry.is_folder && entry.id === parentId));
}

/**
 * A folder fetch may resolve after the user has already navigated elsewhere.
 * Cache those rows if useful, but only render them when they still belong to
 * the folder currently owning the shared visible `files` state.
 */
export function shouldApplyFolderRequestToVisibleState(
  requestParentId: string | null,
  visibleFolderKey: string,
): boolean {
  return folderCacheKey(requestParentId) === visibleFolderKey;
}

export function shouldApplyFilesForFolderToVisibleRows(
  requestParentId: string | null,
  visibleFolderKey: string,
): boolean {
  return shouldApplyFolderRequestToVisibleState(requestParentId, visibleFolderKey);
}

/**
 * Pure controller model for the shared visible Files list state. It mirrors the
 * stale-request guard used by FilesScreen: after navigation changes the visible
 * folder key, an older request may still update caches elsewhere, but it must
 * not change visible rows, loading, refreshing, or error state.
 */
export function reduceVisibleFolderRequestState<T>(
  state: VisibleFolderRequestState<T>,
  event: VisibleFolderRequestEvent<T>,
): VisibleFolderRequestTransition<T> {
  if (!shouldApplyFolderRequestToVisibleState(event.requestParentId, state.visibleFolderKey)) {
    return { state, applied: false };
  }

  switch (event.type) {
    case 'start': {
      const shouldRefresh = event.isRefresh === true || event.hasVisibleRows === true;
      return {
        state: {
          ...state,
          loading: shouldRefresh ? state.loading : true,
          refreshing: shouldRefresh,
          error: null,
        },
        applied: true,
      };
    }
    case 'success':
      return {
        state: {
          ...state,
          rows: event.rows,
        },
        applied: true,
      };
    case 'error':
      if (event.renderedCachedIndex === true) {
        return { state, applied: true };
      }
      return {
        state: {
          ...state,
          error: event.error,
        },
        applied: true,
      };
    case 'finally':
      return {
        state: {
          ...state,
          loading: false,
          refreshing: false,
        },
        applied: true,
      };
  }
}
