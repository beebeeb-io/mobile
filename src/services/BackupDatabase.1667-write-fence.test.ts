// @ts-nocheck
/**
 * Task 1667 round 8 (Codex P1 "Fence late photo scans before resetting the
 * manifest", mobile#182 at 556ef334) — the JS side of the write fence.
 *
 * Every write `BackupDatabase` makes to `beebeeb-backup.db` runs behind a
 * `BackupWriteTicket` taken when the caller's work started: the account
 * epoch AND the storage-purge generation (every purge hold advances it). The
 * ticket is checked in the same synchronous step that starts the statement,
 * after the purge barrier and the handle await.
 *
 * (a) the account-deletion order (purge BEFORE sign-out, so the epoch does
 *     not move): a write that waited out the purge hold writes nothing.
 * (b) a re-queue whose remaining chunks wait out a purge, and a verification
 *     result that settles after a sign-out, write nothing.
 * (c) a ticket taken after the purge and the next sign-in writes normally.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const runs: string[] = [];
let afterRun: (() => void | Promise<void>) | null = null;

class FakeDb {
  async execAsync(): Promise<void> {}
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (/PRAGMA\s+user_version/i.test(sql)) return { user_version: 99 } as T;
    return null;
  }
  async getAllAsync(): Promise<unknown[]> { return []; }
  async runAsync(sql: string): Promise<{ changes: number; lastInsertRowId: number }> {
    runs.push(sql.replace(/\s+/g, ' ').trim());
    const hook = afterRun;
    if (hook) await hook();
    return { changes: 1, lastInsertRowId: 1 };
  }
  async closeAsync(): Promise<void> {}
}

mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiRemove: async () => {}, getAllKeys: async () => [] },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => new FakeDb(),
}));

const { advanceAccountEpoch } = await import('../lib/account-epoch');
const { backupWriteTicket } = await import('../lib/backup-write-ticket');

// Task 1667 round 10: BackupDatabase opens only through the native JS-open
// gate (backup-manifest-js-open-gate.ts); with none registered it refuses.
// These tests are about other behaviour: admit every open.
const { registerBackupManifestJsOpenGate } = await import('../lib/backup-manifest-js-open-gate');
registerBackupManifestJsOpenGate(async () => ({ ok: 1, reason: null }));

async function loadBackupDatabase() {
  const db = await import(`./BackupDatabase?backupDatabaseWriteFenceTest=${Math.random()}`);
  await db.initDatabase();
  runs.length = 0;
  return db;
}

const tick = () => new Promise((r) => setTimeout(r, 1));
const writesOf = (prefix: string) => runs.filter((sql) => sql.startsWith(prefix));

beforeEach(() => {
  runs.length = 0;
  afterRun = null;
});

describe('(a) a write that waited out a storage purge writes nothing (account-deletion order: purge first, epoch unchanged)', () => {
  test('markRemoteDeleted ticketed before the hold, released after it', async () => {
    const db = await loadBackupDatabase();
    const ticket = backupWriteTicket(); // the delete started
    const hold = await db.suspendForStoragePurge(); // DeleteAccountScreen: purge first
    const write = db.markRemoteDeleted('local-1', ticket);
    await tick();
    expect(writesOf('UPDATE backup_assets SET status = \'remote_deleted\'')).toEqual([]); // waiting on the barrier
    hold.resume(); // the native reset ran inside the hold
    await write;
    expect(writesOf('UPDATE backup_assets SET status = \'remote_deleted\'')).toEqual([]);
    expect(db.droppedBackupWrites()).toContain('markRemoteDeleted');
  });

  test('recordVerification (an INSERT) ticketed before the hold', async () => {
    const db = await loadBackupDatabase();
    const ticket = backupWriteTicket();
    const hold = await db.suspendForStoragePurge();
    const write = db.recordVerification('file-of-A', true, undefined, 10, ticket);
    await tick();
    hold.resume();
    await write;
    expect(writesOf('INSERT INTO backup_verification')).toEqual([]);
    expect(writesOf('DELETE FROM backup_verification')).toEqual([]);
  });
});

describe('(b) chunks and late results after a purge or a sign-out', () => {
  test('a re-queue whose next chunks wait out a purge hold stops after the chunk that ran before it', async () => {
    const db = await loadBackupDatabase();
    const ticket = backupWriteTicket();
    const ids = Array.from({ length: 1200 }, (_, i) => `r${i}`);
    // The purge (hold, native reset, resume) lands while the FIRST chunk's
    // UPDATE is running: the epoch check between chunks still passes (the
    // account-deletion order does not move it), the barrier then holds the
    // next chunk, and the ticket check after it drops it.
    // (Not awaited inside the statement: the hold waits for it to finish.)
    afterRun = () => {
      afterRun = null;
      void db.suspendForStoragePurge().then((hold) => setTimeout(() => hold.resume(), 2));
    };
    const changed = await db.resetUploadedState(ids, ticket);
    expect(writesOf('UPDATE backup_assets SET status = \'pending_upload\'').length).toBe(1);
    expect(changed).toBe(1);
  });

  test('a verification result that settles after a sign-out is not recorded', async () => {
    const db = await loadBackupDatabase();
    const ticket = backupWriteTicket(); // verifySingleFile started under A
    advanceAccountEpoch(); // clearToken() (A signs out while the download runs)
    await db.recordVerification('file-of-A', true, undefined, 10, ticket);
    expect(writesOf('INSERT INTO backup_verification')).toEqual([]);
    expect(db.droppedBackupWrites()).toContain('recordVerification');
  });

  test('a delete-cascade manifest update that settles after a sign-out writes nothing', async () => {
    const db = await loadBackupDatabase();
    const ticket = backupWriteTicket();
    advanceAccountEpoch();
    const changed = await db.markRemoteDeletedByFileIds(['file-of-A'], ticket);
    expect(changed).toBe(0);
    expect(writesOf('UPDATE backup_assets SET status = \'remote_deleted\'')).toEqual([]);
  });
});

describe('(c) a ticket taken after the purge and the next sign-in writes normally', () => {
  test('every writer runs its statement under a fresh ticket', async () => {
    const db = await loadBackupDatabase();
    const hold = await db.suspendForStoragePurge();
    hold.resume();
    advanceAccountEpoch(); // setToken(B)
    const t = backupWriteTicket();
    await db.markRemoteDeleted('local-1', t);
    await db.recordVerification('file-of-B', true, undefined, 10, t);
    await db.markRemoteDeletedByFileIds(['file-of-B'], t);
    expect(await db.resetUploadedState(['file-of-B'], t)).toBe(1);
    await db.markFailed('local-2', 'boom', t);
    await db.markUploading('local-2', t);
    await db.upsertPendingUpload('local-3', 'photo', 10, 1, t);
    await db.markUploadComplete('local-3', 'file-of-B-3', t);
    await db.markPendingDelete('local-3', t);
    await db.markOrphaned('local-3', t);
    await db.removePendingDelete('local-3', t);
    await db.recoverStuckUploads(t);
    await db.retryAllFailed(t);
    await db.clearAllData(t);
    expect(writesOf('UPDATE backup_assets SET status = \'remote_deleted\'').length).toBe(2);
    expect(writesOf('INSERT INTO backup_verification').length).toBe(1);
    // resetUploadedState + retryAllFailed
    expect(writesOf('UPDATE backup_assets SET status = \'pending_upload\'').length).toBe(2);
    expect(writesOf('INSERT INTO backup_assets').length).toBe(1);
    // removePendingDelete + clearAllData
    expect(writesOf('DELETE FROM backup_assets').length).toBe(2);
    // 14 writers; recordVerification runs two statements (insert + trim).
    expect(runs.length).toBe(15);
    expect(db.droppedBackupWrites()).toEqual([]);
  });
});
