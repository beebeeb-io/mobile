import { ApiError, friendlyError } from './api';

export type TrashDeletion = {
  deletedIds: string[];
  liveFolders: number;
  noLongerTrashed: number;
  error?: unknown;
};

export function trashDeleteError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    if (error.code === 'not_trashed') {
      return 'This item is no longer in Trash. Refresh to see its current location.';
    }
    if (error.code === 'has_live_descendants') {
      return 'This folder contains live files and was kept. Move or restore those files before permanently deleting it.';
    }
  }
  return friendlyError(error);
}

export async function deleteTrashItems(
  ids: readonly string[],
  remove: (id: string) => Promise<void>,
): Promise<TrashDeletion> {
  const result: TrashDeletion = { deletedIds: [], liveFolders: 0, noLongerTrashed: 0 };
  for (const id of ids) {
    try {
      await remove(id);
      result.deletedIds.push(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'has_live_descendants') {
        result.liveFolders += 1;
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'not_trashed') {
        result.noLongerTrashed += 1;
      } else {
        result.error = error;
        break;
      }
    }
  }
  return result;
}

export function trashDeletionMessage(result: TrashDeletion): string {
  if (!result.error && result.liveFolders === 0 && result.noLongerTrashed === 0) return 'Trash emptied';
  const count = result.deletedIds.length;
  const messages = [`${count} item${count === 1 ? '' : 's'} permanently deleted.`];
  if (result.liveFolders > 0) {
    const n = result.liveFolders;
    messages.push(`${n} folder${n === 1 ? '' : 's'} kept because ${n === 1 ? 'it contains' : 'they contain'} live files.`);
  }
  if (result.noLongerTrashed > 0) {
    const n = result.noLongerTrashed;
    messages.push(`${n} item${n === 1 ? '' : 's'} kept because ${n === 1 ? 'it is' : 'they are'} no longer in Trash.`);
  }
  if (result.error) messages.push(trashDeleteError(result.error));
  return messages.join(' ');
}
