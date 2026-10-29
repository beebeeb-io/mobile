// @ts-nocheck
import { describe, expect, mock, test } from 'bun:test';

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
mock.module('./api', () => ({ ApiError, friendlyError: (error: Error) => error.message }));
const { deleteTrashItems, trashDeleteError, trashDeletionMessage } = await import('./trash-delete');

describe('1946 Empty Trash partial refusal', () => {
  test('continues after both typed 409 refusals and reports what was kept', async () => {
    const visited: string[] = [];
    const result = await deleteTrashItems(['folder', 'restored', 'clean'], async id => {
      visited.push(id);
      if (id === 'folder') throw new ApiError(409, 'raw', 'has_live_descendants');
      if (id === 'restored') throw new ApiError(409, 'raw', 'not_trashed');
    });
    expect(visited).toEqual(['folder', 'restored', 'clean']);
    expect(result.deletedIds).toEqual(['clean']);
    expect(trashDeletionMessage(result)).toBe('1 item permanently deleted. 1 folder kept because it contains live files. 1 item kept because it is no longer in Trash.');
  });
  test('stops on an unknown failure but preserves the successful IDs for cleanup', async () => {
    const visited: string[] = [];
    const error = new ApiError(503, 'Storage unavailable');
    const result = await deleteTrashItems(['clean', 'failed', 'later'], async id => {
      visited.push(id);
      if (id === 'failed') throw error;
    });
    expect(visited).toEqual(['clean', 'failed']);
    expect(result.deletedIds).toEqual(['clean']);
    expect(result.error).toBe(error);
    expect(trashDeletionMessage(result)).toContain('1 item permanently deleted.');
    expect(trashDeletionMessage(result)).not.toContain('Trash emptied');
  });
  test('single-item typed refusals do not expose raw codes', () => {
    expect(trashDeleteError(new ApiError(409, 'not_trashed', 'not_trashed'))).toBe('This item is no longer in Trash. Refresh to see its current location.');
    expect(trashDeleteError(new ApiError(409, 'has_live_descendants', 'has_live_descendants'))).toBe('This folder contains live files and was kept. Move or restore those files before permanently deleting it.');
  });
  test('all successful deletions say Trash emptied', async () => {
    expect(trashDeletionMessage(await deleteTrashItems(['one', 'two'], async () => {}))).toBe('Trash emptied');
  });
});
