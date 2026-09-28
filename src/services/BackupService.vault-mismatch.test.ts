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
const traces: Array<{ name: string; fields: Record<string, unknown> }> = [];
mock.module('../lib/runtime-trace', () => ({
  recordRuntimeTrace: (name: string, fields: Record<string, unknown> = {}) => { traces.push({ name, fields }); return null; },
}));

const { ensureBackupFolders, setBackupEncryption } = await import('./BackupService');

// Task 1594 round 2 (F2): fileIds in this set throw a non-decryption
// exception on their NEXT decrypt attempt only (then behave per `readable`),
// simulating a bridge/lifecycle fault (e.g. a released native handle) rather
// than a real wrong-key AEAD failure.
const flakyOnce = new Set<string>();

beforeEach(() => {
  listings.clear();
  created.length = 0;
  readable.clear();
  flakyOnce.clear();
  traces.length = 0;
  secure.clear();
  setBackupEncryption({
    encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
    decryptChunkFn: async () => new Uint8Array(),
    encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' }),
    // Decrypts only what this key "owns"; everything else fails like AES-GCM.
    decryptMetadataFn: async (fileId: string) => {
      if (flakyOnce.has(fileId)) {
        flakyOnce.delete(fileId);
        // NOT an auth-failure message — a bridge/lifecycle fault, e.g. a
        // released native handle mid-flight (BeebeebCryptoModule.getHandle's
        // "Invalid master key handle ID").
        throw new Error('Invalid master key handle ID: 3');
      }
      const name = readable.get(fileId);
      // The real (and only) native decrypt-failure message
      // (repos/core/beebeeb-core/src/error.rs `CoreError::Decryption`).
      if (name == null) throw new Error('decryption failed: ciphertext is invalid or key is wrong');
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

describe('1594 round 2 (F2) — a foreign folder at a level the key otherwise reads is skipped, not a full stop', () => {
  test("own Backups doesn't exist yet, but a readable sibling proves the key works here → creates it instead of blocking on the foreign sibling", async () => {
    // Neither folder here is named "Backups" — this account has never backed
    // up on this device before — but 'other' is an unrelated folder THIS key
    // decrypts fine (e.g. something created from the web app), and 'junk' is
    // a foreign key's leftover that never will be. Round 1 threw
    // VaultKeyMismatchError here (any undecryptable sibling → stop) even
    // though 'other' already proves this is not a wrong-key session — the
    // exact "account already hit by 1594" dead end the review flagged.
    listings.set('root', [sealed('other', null), sealed('junk', null)]);
    readable.set('other', 'Documents');
    // 'junk' is intentionally never added to `readable`.

    const out = await ensureBackupFolders('camera_roll');

    expect(created.map((c) => c.parentId)).toEqual([undefined, created[0].id, created[1].id, created[1].id, created[1].id]);
    expect(out.deviceFolderId).toBe(created[1].id);
    // Skipped with a runtime trace naming only the count/level, never a name.
    const skip = traces.find((t) => t.name === 'backup.foreign_folder_skipped');
    expect(skip?.fields).toEqual({ parentId: 'root', undecryptableFolders: 1, decryptableFolders: 1 });
    expect(JSON.stringify(traces)).not.toMatch(/junk|other/);
  });

  test('a lone undecryptable folder with NOTHING else at that level still stops the backup (still ambiguous)', async () => {
    // Unlike the test above, there is nothing at this level to prove the key
    // works — the wanted folder might be this very one, just unreadable for
    // some other reason. F2 keeps the original fail-closed behaviour here.
    listings.set('root', [sealed('junk', null)]);

    await expect(ensureBackupFolders('camera_roll')).rejects.toThrow(/vault key/i);
    expect(created).toEqual([]);
  });

  test('a transient (non-decryption) exception is retried once and is never treated as a foreign key', async () => {
    listings.set('root', [sealed('backups-real', null)]);
    readable.set('backups-real', 'Backups');
    listings.set('backups-real', [sealed('device-a', 'backups-real')]);
    readable.set('device-a', 'bb-ios27');
    listings.set('device-a', [
      sealed('cam', 'device-a'), sealed('con', 'device-a'), sealed('cal', 'device-a'),
    ]);
    readable.set('cam', 'Camera Roll');
    readable.set('con', 'Contacts');
    readable.set('cal', 'Calendar');
    // The FIRST decrypt attempt for the device folder throws a non-auth,
    // non-decryption exception — must not be counted as a foreign key on the
    // first try.
    flakyOnce.add('device-a');

    const out = await ensureBackupFolders('camera_roll');

    expect(out).toEqual({ deviceFolderId: 'device-a', categoryFolderId: 'cam' });
    expect(created).toEqual([]); // reused device-a — never duplicated
    expect(traces.some((t) => t.name === 'backup.name_decrypt_transient_retry')).toBe(true);
  });

  test('a definite decryption-auth failure (the real native message) is NOT retried — one attempt only', async () => {
    listings.set('root', [sealed('junk', null)]);
    let attempts = 0;
    setBackupEncryption({
      encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
      decryptChunkFn: async () => new Uint8Array(),
      encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' }),
      decryptMetadataFn: async () => {
        attempts += 1;
        throw new Error('decryption failed: ciphertext is invalid or key is wrong');
      },
    });

    await expect(ensureBackupFolders('camera_roll')).rejects.toThrow(/vault key/i);
    expect(attempts).toBe(1);
  });
});
