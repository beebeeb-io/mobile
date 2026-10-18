// @ts-nocheck
/**
 * Task 1959 round 3: the backup reconcile's re-queue (`resetUploadedState`)
 * is bound to the account epoch the reconcile started under.
 *
 * The reconcile checks the epoch right before it calls `resetUploadedState`,
 * but the re-queue then awaits the database handle (and, for a long orphan
 * list, one UPDATE per chunk). A sign-out + sign-in inside that window let A's
 * "the Backups root is gone" verdict re-queue every uploaded row of the
 * manifest B now uses.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const runs: string[] = [];
let afterRun: (() => void) | null = null;
let holdOpen = false;
const openPending: Array<() => void> = [];

class FakeDb {
  async execAsync(): Promise<void> {}
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (/PRAGMA\s+user_version/i.test(sql)) return { user_version: 99 } as T;
    return null;
  }
  async getAllAsync(): Promise<unknown[]> { return []; }
  async runAsync(sql: string): Promise<{ changes: number }> {
    runs.push(sql.replace(/\s+/g, ' ').trim());
    afterRun?.();
    return { changes: 1 };
  }
}

mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiRemove: async () => {}, getAllKeys: async () => [] },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    if (holdOpen) await new Promise<void>((resolve) => openPending.push(resolve));
    return new FakeDb();
  },
}));

const { advanceAccountEpoch } = await import('../lib/account-epoch');
// Task 1667 round 8: writers take a BackupWriteTicket (account epoch + the
// storage-purge generation); the epoch rules below are unchanged.
const { backupWriteTicket } = await import('../lib/backup-write-ticket');
const accountEpoch = backupWriteTicket;

async function loadBackupDatabase() {
  return import(`./BackupDatabase?backupDatabaseEpochTest=${Math.random()}`);
}

const tick = () => new Promise((r) => setTimeout(r, 1));

beforeEach(() => {
  runs.length = 0;
  afterRun = null;
  holdOpen = false;
  openPending.length = 0;
});

describe('resetUploadedState is bound to the reconcile\'s account epoch (task 1959 round 3)', () => {
  test('a full re-queue that started under A runs no UPDATE once A has signed out', async () => {
    const db = await loadBackupDatabase();
    const underA = accountEpoch();
    holdOpen = true;
    const reset = db.resetUploadedState(undefined, underA);
    await tick();
    advanceAccountEpoch(); // clearToken()
    advanceAccountEpoch(); // setToken(B)
    holdOpen = false;
    for (const r of openPending.splice(0)) r();
    expect(await reset).toBe(0);
    expect(runs.filter((sql) => sql.startsWith('UPDATE backup_assets SET status = \'pending_upload\''))).toEqual([]);
  });

  test('a per-id re-queue stops between chunks once the epoch moved', async () => {
    const db = await loadBackupDatabase();
    const underA = accountEpoch();
    // Open the handle first so only the chunk loop is in play.
    await db.resetUploadedState([], underA);
    runs.length = 0;
    const ids = Array.from({ length: 1200 }, (_, i) => `r${i}`);
    // Sign-out lands while the FIRST chunk's UPDATE is running.
    afterRun = () => { afterRun = null; advanceAccountEpoch(); };
    await db.resetUploadedState(ids, underA);
    expect(runs.length).toBe(1);
  });

  test('under the current epoch every chunk runs', async () => {
    const db = await loadBackupDatabase();
    const now = accountEpoch();
    const ids = Array.from({ length: 1200 }, (_, i) => `r${i}`);
    const changed = await db.resetUploadedState(ids, now);
    expect(changed).toBe(runs.length);
    expect(runs.length).toBeGreaterThan(1);
  });
});
