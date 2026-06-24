// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  appendFolderToBreadcrumbStack,
  filterSelfChildEntries,
  shouldApplyFilesForFolderToVisibleRows,
  shouldApplyFolderRequestToVisibleState,
  reduceVisibleFolderRequestState,
  type BreadcrumbEntry,
} from './folder-navigation';

const root: BreadcrumbEntry = { id: null, name: 'Drive' };
const backups: BreadcrumbEntry = { id: 'backups-root', name: 'Backups' };

describe('folder breadcrumb navigation', () => {
  test('does not append another crumb when tapping the current folder again', () => {
    const stack = [root, backups];

    const next = appendFolderToBreadcrumbStack(stack, { id: 'backups-root', name: 'Backups' });

    expect(next).toEqual([root, backups]);
  });

  test('jumps to an ancestor instead of appending a duplicate ancestor crumb', () => {
    const device = { id: 'device-folder', name: 'iPhone' };
    const stack = [root, backups, device];

    const next = appendFolderToBreadcrumbStack(stack, { id: 'backups-root', name: 'Backups' });

    expect(next).toEqual([root, backups]);
  });

  test('filters an impossible self-child row but preserves a real same-name child', () => {
    const entries = [
      { id: 'backups-root', is_folder: true, parent_id: 'backups-root' },
      { id: 'nested-backups', is_folder: true, parent_id: 'backups-root' },
      { id: 'photo-1', is_folder: false, parent_id: 'backups-root' },
    ];

    expect(filterSelfChildEntries(entries, 'backups-root')).toEqual([
      { id: 'nested-backups', is_folder: true, parent_id: 'backups-root' },
      { id: 'photo-1', is_folder: false, parent_id: 'backups-root' },
    ]);
  });

  test('does not render a stale root fetch result after navigating into a child folder', () => {
    expect(shouldApplyFilesForFolderToVisibleRows(null, 'child-folder')).toBe(false);
  });

  test('does not let a stale root fetch update shared visible folder state', () => {
    expect(shouldApplyFolderRequestToVisibleState(null, 'child-folder')).toBe(false);
    expect(shouldApplyFolderRequestToVisibleState('child-folder', 'child-folder')).toBe(true);
  });

  test('keeps stale root request lifecycle from mutating visible child folder state', () => {
    const rootRows = [{ id: 'root-row', is_folder: true, parent_id: null }];
    const childRows = [{ id: 'child-row', is_folder: false, parent_id: 'child-folder' }];
    const matchingChildRows = [{ id: 'child-row-2', is_folder: false, parent_id: 'child-folder' }];

    const rootStarted = reduceVisibleFolderRequestState(
      {
        visibleFolderKey: 'root',
        rows: [],
        loading: false,
        refreshing: false,
        error: 'previous root error',
      },
      { type: 'start', requestParentId: null },
    );

    expect(rootStarted.applied).toBe(true);
    expect(rootStarted.state).toEqual({
      visibleFolderKey: 'root',
      rows: [],
      loading: true,
      refreshing: false,
      error: null,
    });

    const childVisible = {
      visibleFolderKey: 'child-folder',
      rows: childRows,
      loading: true,
      refreshing: false,
      error: 'child error',
    };

    const staleRootSuccess = reduceVisibleFolderRequestState(
      childVisible,
      { type: 'success', requestParentId: null, rows: rootRows },
    );
    expect(staleRootSuccess.applied).toBe(false);
    expect(staleRootSuccess.state).toBe(childVisible);

    const staleRootError = reduceVisibleFolderRequestState(
      staleRootSuccess.state,
      { type: 'error', requestParentId: null, error: 'root failed' },
    );
    expect(staleRootError.applied).toBe(false);
    expect(staleRootError.state).toBe(childVisible);

    const staleRootFinally = reduceVisibleFolderRequestState(
      staleRootError.state,
      { type: 'finally', requestParentId: null },
    );
    expect(staleRootFinally.applied).toBe(false);
    expect(staleRootFinally.state).toBe(childVisible);

    const matchingChildSuccess = reduceVisibleFolderRequestState(
      staleRootFinally.state,
      { type: 'success', requestParentId: 'child-folder', rows: matchingChildRows },
    );
    expect(matchingChildSuccess.applied).toBe(true);
    expect(matchingChildSuccess.state.rows).toEqual(matchingChildRows);

    const matchingChildError = reduceVisibleFolderRequestState(
      matchingChildSuccess.state,
      { type: 'error', requestParentId: 'child-folder', error: 'child failed' },
    );
    expect(matchingChildError.applied).toBe(true);
    expect(matchingChildError.state.error).toBe('child failed');

    const matchingChildFinally = reduceVisibleFolderRequestState(
      matchingChildError.state,
      { type: 'finally', requestParentId: 'child-folder' },
    );
    expect(matchingChildFinally.applied).toBe(true);
    expect(matchingChildFinally.state.loading).toBe(false);
    expect(matchingChildFinally.state.refreshing).toBe(false);
  });
});
