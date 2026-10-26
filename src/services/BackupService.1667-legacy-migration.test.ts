// @ts-nocheck
/**
 * Task 1667 round 13 (review of mobile#182 at a19037f9, item 2, P1 data
 * integrity): sign-out must not re-arm `migrateLegacyRootBackups`.
 *
 * At a19037f9 the "migrated" record lived in the folder cache
 * (`beebeeb_backup_folders`), which sign-out clears since this PR. Every
 * sign-in with backup on then ran the migration again, and it matched root
 * items by their DECRYPTED name: the user's own root "Photos" folder (made on
 * the web, an encrypted name) was moved into Backups/<device>/Camera Roll and
 * renamed "Photos (legacy)", and so were a root contacts.vcf / calendar.ics.
 *
 * Now (a) the record is once per DEVICE in its own key that sign-out never
 * clears, and (b) only an item with a marker the pre-category backup code
 * left is moved: a plaintext `name_encrypted` (written before names were
 * encrypted), or the folder id the May 2026 runner stored.
 *
 * Drives the real exported `ensureBackupFolders` and the real sign-out cache
 * clear; every dependency is mocked (isolated-runner rule).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Task 2233: this service now reads installed app identity through appVersion().
mock.module('expo-constants', () => ({ default: { expoConfig: { version: '0.9.0' } } }));
mock.module('expo-application', () => ({ nativeApplicationVersion: '1.0.1', nativeBuildVersion: '8' }));

type Entry = { id: string; parent_id: string | null; is_folder: boolean; name_encrypted: string; created_at: string };

const listings = new Map<string, Entry[]>();
const created: Array<{ parentId: string | undefined; id: string }> = [];
const readable = new Map<string, string>();
const moves: Array<{ id: string; parentId: string }> = [];
const renames: string[] = [];

function sealed(id: string, parent: string | null, isFolder = true): Entry {
  return {
    id,
    parent_id: parent,
    is_folder: isFolder,
    name_encrypted: JSON.stringify({ nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUFBQUFBQUFBQUFBQUFBQUFBQUE=' }),
    created_at: '2026-09-26T11:05:57Z',
  };
}

function plaintext(id: string, parent: string | null, name: string, isFolder: boolean): Entry {
  return { id, parent_id: parent, is_folder: isFolder, name_encrypted: name, created_at: '2026-05-03T00:00:00Z' };
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
  listAllFiles: async (parentId?: string) => [...(listings.get(parentId ?? 'root') ?? [])],
  findFile: async (parentId: string | undefined, match: (f: Entry) => boolean | Promise<boolean>) => {
    for (const f of listings.get(parentId ?? 'root') ?? []) {
      if (await match(f)) return f;
    }
    return undefined;
  },
  moveFile: async (id: string, parentId: string) => {
    moves.push({ id, parentId });
    for (const [parent, entries] of listings) {
      const at = entries.findIndex((e) => e.id === id);
      if (at >= 0) {
        const [entry] = entries.splice(at, 1);
        listings.set(parent, entries);
        listings.set(parentId, [...(listings.get(parentId) ?? []), { ...entry, parent_id: parentId }]);
      }
    }
  },
  renameFile: async (id: string) => { renames.push(id); },
  trashFiles: async () => {},
  getFileIndex: async () => ({ changed: false }),
}));
// Task 1959: the reconcile reads the index through file-index-loader, whose
// cache module writes to the documents directory — keep it in memory here.
mock.module('../lib/file-index-cache', () => ({
  loadCachedFileIndex: async () => null,
  saveCachedFileIndex: async () => {},
  clearCachedFileIndex: async () => {},
  fileIndexCacheGeneration: () => 0,
  cachedFileIndexEpoch: () => undefined,
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
const { clearBackupFolderCacheForSignOut } = await import('../lib/backup-folder-cache');

const DONE_KEY = 'beebeeb_backup_legacy_migration';

/** The account's Backups tree already exists (so nothing is created). */
function backupsTree() {
  listings.set('backups', [sealed('device-a', 'backups')]);
  readable.set('backups', 'Backups');
  readable.set('device-a', 'bb-ios27');
  listings.set('device-a', [sealed('cam', 'device-a'), sealed('con', 'device-a'), sealed('cal', 'device-a')]);
  readable.set('cam', 'Camera Roll');
  readable.set('con', 'Contacts');
  readable.set('cal', 'Calendar');
}

async function signOutAndIn() {
  await clearBackupFolderCacheForSignOut();
  await ensureBackupFolders('camera_roll');
}

beforeEach(() => {
  listings.clear();
  created.length = 0;
  readable.clear();
  moves.length = 0;
  renames.length = 0;
  secure.clear();
  setBackupEncryption({
    encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
    decryptChunkFn: async () => new Uint8Array(),
    encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' }),
    decryptMetadataFn: async (fileId: string) => {
      const name = readable.get(fileId);
      if (name == null) throw new Error('decryption failed: ciphertext is invalid or key is wrong');
      return JSON.stringify({ name, mime_type: null });
    },
  });
});

describe('1667 r13 item 2: the legacy root migration never moves the user\'s own items', () => {
  test('L1 a user-created root "Photos" folder and contacts.vcf / calendar.ics stay put across sign-out + sign-in', async () => {
    backupsTree();
    listings.set('root', [
      sealed('backups', null),
      sealed('my-photos', null),
      sealed('my-contacts', null, false),
      sealed('my-cal', null, false),
    ]);
    readable.set('my-photos', 'Photos');
    readable.set('my-contacts', 'contacts.vcf');
    readable.set('my-cal', 'calendar.ics');

    await ensureBackupFolders('camera_roll');
    await signOutAndIn();
    await signOutAndIn();

    expect(moves).toEqual([]);
    expect(renames).toEqual([]);
    expect(listings.get('root')!.map((e) => e.id).sort()).toEqual(['backups', 'my-cal', 'my-contacts', 'my-photos']);
  });

  test('L2 a genuine legacy layout (plaintext names) migrates exactly once per device', async () => {
    backupsTree();
    listings.set('root', [
      sealed('backups', null),
      plaintext('legacy-photos', null, 'Photos', true),
      plaintext('legacy-contacts', null, 'contacts.vcf', false),
      plaintext('legacy-cal', null, 'calendar.ics', false),
    ]);

    await ensureBackupFolders('camera_roll');
    expect(moves).toEqual([
      { id: 'legacy-photos', parentId: 'cam' },
      { id: 'legacy-contacts', parentId: 'con' },
      { id: 'legacy-cal', parentId: 'cal' },
    ]);
    // (The mock's rename does not change `name_encrypted`, so the self-heal
    // renames the moved files once more; count distinct ids.)
    expect([...new Set(renames)].sort()).toEqual(['legacy-cal', 'legacy-contacts', 'legacy-photos']);
    const record = JSON.parse(secure.get(DONE_KEY)!);
    expect(record.completedAt).toBeTruthy();
    expect([record.camera_roll, record.contacts, record.calendar]).toEqual([1, 1, 1]);

    // Another legacy item appears at the root later (e.g. restored from the
    // Trash): the device already migrated, so nothing moves again, also not
    // after sign-out + sign-in.
    listings.set('root', [...listings.get('root')!, plaintext('legacy-photos-2', null, 'Photos', true)]);
    await signOutAndIn();
    await ensureBackupFolders('camera_roll');
    expect(moves.length).toBe(3);
    expect(secure.has(DONE_KEY)).toBe(true);
  });

  test('L3 the May 2026 runner\'s encrypted-name "Photos" folder is found by the id it stored', async () => {
    backupsTree();
    secure.set('beebeeb_photos_folder_id', 'runner-photos');
    listings.set('root', [sealed('backups', null), sealed('runner-photos', null), sealed('my-photos', null)]);
    readable.set('runner-photos', 'Photos');
    readable.set('my-photos', 'Photos');

    await ensureBackupFolders('camera_roll');
    expect(moves).toEqual([{ id: 'runner-photos', parentId: 'cam' }]);
  });

  test('L4 upgrade: a record an earlier build left in the folder cache is kept through sign-out', async () => {
    backupsTree();
    secure.set('beebeeb_backup_folders', JSON.stringify({ legacyMigration: { completedAt: '2026-05-12T00:00:00Z', camera_roll: 1 } }));
    listings.set('root', [sealed('backups', null), plaintext('late-legacy', null, 'Photos', true)]);

    await ensureBackupFolders('camera_roll');
    expect(JSON.parse(secure.get(DONE_KEY)!).completedAt).toBe('2026-05-12T00:00:00Z');
    await signOutAndIn();
    expect(moves).toEqual([]);
  });

  test('L5 sign-out clears the folder cache but never the device record', async () => {
    backupsTree();
    listings.set('root', [sealed('backups', null)]);
    await ensureBackupFolders('camera_roll');
    expect(secure.has(DONE_KEY)).toBe(true);
    await clearBackupFolderCacheForSignOut();
    expect(secure.has('beebeeb_backup_folders')).toBe(false);
    expect(secure.has(DONE_KEY)).toBe(true);
  });
  test('L6 the review scenario: migrated once, then the user makes a root "Photos" folder; sign-out + sign-in leaves it', async () => {
    backupsTree();
    listings.set('root', [sealed('backups', null)]);
    await ensureBackupFolders('camera_roll'); // first run on this device: nothing legacy
    listings.set('root', [...listings.get('root')!, sealed('made-on-web', null)]);
    readable.set('made-on-web', 'Photos');
    await signOutAndIn();
    expect(moves).toEqual([]);
    expect(renames).toEqual([]);
  });
});
