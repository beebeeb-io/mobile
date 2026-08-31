// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

type BackupRow = {
  local_asset_id: string;
  status: string;
  asset_type: string;
  file_size: number;
  created_at: string;
};

class FakeBackupDb {
  rows = new Map<string, BackupRow>();
  userVersion = 0;

  async execAsync(sql: string): Promise<void> {
    if (/UPDATE backup_assets SET status = 'pending_upload' WHERE status = 'pending'/.test(sql)) {
      for (const row of this.rows.values()) {
        if (row.status === 'pending') row.status = 'pending_upload';
      }
    }
    if (/UPDATE backup_assets SET status = 'uploaded' WHERE status = 'uploading'/.test(sql)) {
      for (const row of this.rows.values()) {
        if (row.status === 'uploading') row.status = 'uploaded';
      }
    }
    const versionMatch = sql.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i);
    if (versionMatch) this.userVersion = Number(versionMatch[1]);
  }

  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (/PRAGMA\s+user_version/i.test(sql)) {
      return { user_version: this.userVersion } as T;
    }
    return null;
  }
}

const databases = new Map<string, FakeBackupDb>();

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => {
    let db = databases.get(name);
    if (!db) {
      db = new FakeBackupDb();
      databases.set(name, db);
    }
    return db;
  },
}));

async function loadBackupDatabase() {
  return import(`./BackupDatabase?backupDatabaseTest=${Math.random()}`);
}

function getBackupDb(): FakeBackupDb {
  const db = databases.get('beebeeb-backup.db');
  if (!db) throw new Error('backup database was not opened');
  return db;
}

function seedRow(localAssetId: string, status: string): void {
  const db = getBackupDb();
  db.rows.set(localAssetId, {
    local_asset_id: localAssetId,
    status,
    asset_type: 'photo',
    file_size: 1,
    created_at: '2026-07-05T00:00:00.000Z',
  });
}

describe('BackupDatabase legacy status enum migration', () => {
  beforeEach(() => {
    databases.clear();
    databases.set('beebeeb-backup.db', new FakeBackupDb());
  });

  test('migrates legacy uploading rows on the first-ever open only', async () => {
    seedRow('legacy-uploading', 'uploading');

    const firstLaunch = await loadBackupDatabase();
    await firstLaunch.initDatabase();

    expect(getBackupDb().rows.get('legacy-uploading')?.status).toBe('uploaded');

    seedRow('active-uploading-after-migration', 'uploading');

    const secondLaunch = await loadBackupDatabase();
    await secondLaunch.initDatabase();

    expect(getBackupDb().rows.get('active-uploading-after-migration')?.status).toBe('uploading');
  });
});
