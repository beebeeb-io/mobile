// @ts-nocheck
/**
 * Task 1594 [P0] — BackupService must never build a folder tree it cannot read.
 *
 * With a wrong master key every existing folder name fails to decrypt, so
 * `findChildFolder` saw "no match" and `ensureFolder` sealed a brand-new
 * Backups tree under the wrong key (the dev-DB evidence: 5 folders created in
 * one burst under another account's key). The rule now: a listing that holds
 * folders whose names do not decrypt, and no match, is a vault key mismatch —
 * stop, create nothing.
 *
 * Drives the real exported `ensureBackupFolders`; every dependency is mocked
 * (isolated-runner rule, mobile CLAUDE.md "Tests").
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Entry = { id: string; parent_id: string | null; is_folder: boolean; name_encrypted: string; created_at: string };

// Folder listings by parent id ('root' = the vault root).
const listings = new Map<string, Entry[]>();
const created: Array<{ parentId: string | undefined; id: string }> = [];
// The names this (possibly wrong) key can read, by file id.
const readable = new Map<string, string>();

function sealed(id: string, parent: string | null): Entry {
  // A real encrypted-metadata envelope shape so the service tries to decrypt it.
  return {
    id,
    parent_id: parent,
    is_folder: true,
    name_encrypted: JSON.stringify({ nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUFBQUFBQUFBQUFBQUFBQUFBQUE=' }),
    created_at: '2026-09-26T11:05:57Z',
  };
}

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-file-system/legacy', () => ({ documentDirectory: 'file:///tmp/docs/', cacheDirectory: 'file:///tmp/cache/' }));
const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo-device', () => ({ deviceName: 'bb-ios27', modelName: 'iPhone 17 Pro', osName: 'iOS', osVersion: '27.0' }));

mock.module('../lib/api', () => ({
  createFolder: async (_nameEncrypted: string, parentId: string | undefined, folderId: string) => {
    created.push({ parentId, id: folderId });
    return { id: folderId };
  },
  deleteFile: async () => {},
  downloadFile: async () => { throw new Error('not used'); },
  listAllFiles: async (parentId?: string) => listings.get(parentId ?? 'root') ?? [],
  findFile: async (parentId: string | undefined, match: (f: Entry) => boolean | Promise<boolean>) => {
    for (const f of listings.get(parentId ?? 'root') ?? []) {
      if (await match(f)) return f;
    }
    return undefined;
  },
  moveFile: async () => {},
  renameFile: async () => {},
  trashFiles: async () => {},
  getFileIndex: async () => ({ changed: false }),
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  getContactsBackupStatus: async () => ({ hasKnownBackupState: false }),
  getCalendarBackupStatus: async () => ({ hasKnownBackupState: false }),
  resetContactsBackup: async () => {},
  resetCalendarBackup: async () => {},
}));
mock.module('../lib/encrypted-upload', () => ({
  encryptedUpload: async () => ({ id: 'manifest' }),
  generateFileId: async () => `new-${created.length + 1}`,
}));
mock.module('./BackupDatabase', () => ({
  getAllUploadedRemoteIds: async () => new Set(),
  resetUploadedState: async () => 0,
}));
mock.module('../lib/offline-manager', () => ({
  offlineManager: { offlineFileIds: () => [], offlineFolderIds: () => [], removeFile: async () => {}, removeFolder: async () => {} },
}));
mock.module('../lib/thumbnail-cache', () => ({
  pruneThumbnailsForRemoteFiles: async () => {},
  invalidateCachedThumbnails: async () => {},
  invalidateNativeThumbnailCache: async () => {},
}));
mock.module('../lib/name-cache', () => ({ loadNameCache: async () => ({}), pruneNameCache: async () => {} }));
mock.module('../lib/device-identity', () => ({ getDeviceId: async () => 'device-1' }));

const { ensureBackupFolders, setBackupEncryption } = await import('./BackupService');

beforeEach(() => {
  listings.clear();
  created.length = 0;
  readable.clear();
  secure.clear();
  setBackupEncryption({
    encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
    decryptChunkFn: async () => new Uint8Array(),
    encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' }),
    // Decrypts only what this key "owns"; everything else fails like AES-GCM.
    decryptMetadataFn: async (fileId: string) => {
      const name = readable.get(fileId);
      if (name == null) throw new Error('decryption failed');
      return JSON.stringify({ name, mime_type: null });
    },
  });
});

describe('1594 — ensureFolder refuses to build a tree over names it cannot read', () => {
  test('every root folder undecryptable (a wrong key) → throws a vault key mismatch, creates nothing', async () => {
    listings.set('root', [sealed('backups-real', null), sealed('documents', null), sealed('photos', null)]);

    await expect(ensureBackupFolders('camera_roll')).rejects.toThrow(/vault key/i);
    expect(created).toEqual([]);
  });

  test('an undecryptable device-level listing also stops the backup (no partial tree)', async () => {
    listings.set('root', [sealed('backups-real', null)]);
    readable.set('backups-real', 'Backups');
    listings.set('backups-real', [sealed('device-a', 'backups-real')]);

    await expect(ensureBackupFolders('camera_roll')).rejects.toThrow(/vault key/i);
    expect(created).toEqual([]);
  });

  test('a readable match next to an unreadable sibling is used (no false stop)', async () => {
    listings.set('root', [sealed('stray', null), sealed('backups-real', null)]);
    readable.set('backups-real', 'Backups');
    listings.set('backups-real', [sealed('device-a', 'backups-real')]);
    readable.set('device-a', 'bb-ios27');
    listings.set('device-a', [
      sealed('cam', 'device-a'), sealed('con', 'device-a'), sealed('cal', 'device-a'),
    ]);
    readable.set('cam', 'Camera Roll');
    readable.set('con', 'Contacts');
    readable.set('cal', 'Calendar');

    const out = await ensureBackupFolders('camera_roll');
    expect(out).toEqual({ deviceFolderId: 'device-a', categoryFolderId: 'cam' });
    expect(created).toEqual([]);
  });

  test('an empty vault (first backup) still creates the tree', async () => {
    const out = await ensureBackupFolders('camera_roll');
    expect(created.map((c) => c.parentId)).toEqual([undefined, created[0].id, created[1].id, created[1].id, created[1].id]);
    expect(out.deviceFolderId).toBe(created[1].id);
  });
});
