// @ts-nocheck
/**
 * Task 1959 round 3: the delete cascade prunes the decrypted-name cache under
 * the account epoch it STARTED under. The prune runs after several awaits
 * (manifest, offline copies, thumbnails); a sign-out + sign-in in between must
 * not let it write the previous account's names into the next session.
 */
import { describe, expect, mock, test } from 'bun:test';

let holdManifest = false;
const manifestPending: Array<() => void> = [];
const pruneEpochs: unknown[] = [];

mock.module('../services/BackupDatabase', () => ({
  markRemoteDeletedByFileIds: async () => {
    if (holdManifest) await new Promise<void>((resolve) => manifestPending.push(resolve));
    return 0;
  },
}));
mock.module('../services/BackupService', () => ({ invalidateBackupFolderCacheIfDeleted: async () => {} }));
mock.module('./offline-manager', () => ({
  offlineManager: { offlineFolderIds: () => [], getStatus: () => null, removeFile: async () => {}, removeFolder: async () => {} },
}));
mock.module('./thumbnail-cache', () => ({ invalidateCachedThumbnails: async () => {}, invalidateNativeThumbnailCache: async () => {} }));
mock.module('./name-cache', () => ({
  pruneNameCache: async (_ids: string[], epoch: unknown) => { pruneEpochs.push(epoch); return 0; },
}));

const { onFilesDeleted } = await import('./delete-cascade');
const { accountEpoch, advanceAccountEpoch, isCurrentAccountEpoch, sameAccountEpoch } = await import('./account-epoch');

describe('delete cascade name-cache prune (task 1959 round 3)', () => {
  test('the prune carries the epoch the cascade started under, not the one current when it got there', async () => {
    const atStart = accountEpoch();
    holdManifest = true;
    const cascade = onFilesDeleted(['a1']);
    await new Promise((r) => setTimeout(r, 1));
    advanceAccountEpoch(); // clearToken(A)
    advanceAccountEpoch(); // setToken(B)
    holdManifest = false;
    for (const r of manifestPending.splice(0)) r();
    await cascade;
    expect(pruneEpochs.length).toBe(1);
    expect(sameAccountEpoch(pruneEpochs[0], atStart)).toBe(true);
    expect(isCurrentAccountEpoch(pruneEpochs[0])).toBe(false);
  });
});
