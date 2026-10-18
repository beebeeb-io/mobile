// @ts-nocheck
/**
 * Task 1667 round 7 (Codex P1 "Retain the database handle when closing
 * fails", mobile#182 at dc531405) + the round 7 sweep of BackupDatabase.ts.
 *
 * The REAL BackupDatabase.ts and storage-purge-participants.ts, with a fake
 * expo-sqlite whose connections each know whether they are really closed.
 * Real expo-sqlite marks a handle closed BEFORE sqlite3_close reports back
 * (SQLiteModule.swift closeDatabase: `db.isClosed = true` then throws on a
 * non-OK close), so a handle whose close rejected may still hold the file
 * open and every later closeAsync() on it rejects. `stuck` models that.
 *
 * Asserted:
 *   - a handle whose close failed is never forgotten: every later
 *     closeHandles() returns false while it may still be open, even after the
 *     module reopened (and closed) a fresh handle;
 *   - once a retry of that close succeeds, closeHandles() is true again;
 *   - a close that fails transiently is retried within the same call;
 *   - an open whose migration throws does not leave its connection open
 *     and untracked.
 */
import { describe, expect, mock, test } from 'bun:test';

let nextId = 0;
const all: FakeDb[] = [];
let migrationFailsOnce = false;
let nextConnectionUnclosable = false;

class FakeDb {
  id = ++nextId;
  reallyOpen = true;
  /** closeAsync rejects this many more times (Infinity = never closes). */
  failCloses = 0;
  closeCalls = 0;
  constructor() {
    all.push(this);
    if (nextConnectionUnclosable) {
      nextConnectionUnclosable = false;
      this.failCloses = Infinity;
    }
  }
  async execAsync(sql: string): Promise<void> {
    if (migrationFailsOnce && /journal_mode/i.test(sql)) {
      migrationFailsOnce = false;
      throw new Error('disk I/O error');
    }
  }
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (/PRAGMA\s+user_version/i.test(sql)) return { user_version: 99 } as T;
    if (/COUNT/i.test(sql)) return { count: 0 } as T;
    return null;
  }
  async getAllAsync(): Promise<unknown[]> { return []; }
  async runAsync(): Promise<{ changes: number }> { return { changes: 0 }; }
  async closeAsync(): Promise<void> {
    this.closeCalls += 1;
    if (this.failCloses > 0) {
      this.failCloses -= 1;
      throw new Error('unable to close due to unfinalized statements');
    }
    this.reallyOpen = false;
  }
}

mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => new FakeDb(),
}));

const BackupDatabase = await import('./BackupDatabase');
const { withStoragePurgeParticipantsSuspended } = await import('../lib/storage-purge-participants');

const liveConnections = () => all.filter((d) => d.reallyOpen).length;

/** One sign-out whose native reset failed: hold -> closeHandles -> resume. */
async function purgeAfterFailedReset(): Promise<{ closed: boolean; liveAtDecision: number }> {
  return withStoragePurgeParticipantsSuspended(async ({ closeHandles }) => {
    const closed = await closeHandles();
    return { closed, liveAtDecision: liveConnections() };
  });
}

describe('round 7 (Codex P1): a handle whose close failed is retained until it really closes', () => {
  test('a stuck handle keeps every later closeHandles() false, even after a fresh handle was opened and closed', async () => {
    await BackupDatabase.initDatabase();
    const first = all[all.length - 1];
    first.failCloses = Infinity;

    const one = await purgeAfterFailedReset();
    expect(one.closed).toBe(false);

    // The module goes on with a NEW connection after resume.
    await BackupDatabase.getUploadedCount('photo');
    const second = all[all.length - 1];
    expect(second).not.toBe(first);

    // Next sign-out with a failed reset: the new handle closes fine, but the
    // first one may still be open. The bug: this returned true and the
    // native recovery unlinked the file beneath `first`.
    const two = await purgeAfterFailedReset();
    expect(second.reallyOpen).toBe(false);
    expect(first.reallyOpen).toBe(true);
    expect(two.liveAtDecision).toBe(1);
    expect(two.closed).toBe(false);
    // It was retried, not forgotten.
    expect(first.closeCalls).toBeGreaterThan(3);
    expect(BackupDatabase.unclosedHandleCount()).toBe(1);

    // When that close finally succeeds, closeHandles() is true again.
    first.failCloses = 0;
    await BackupDatabase.getUploadedCount('photo');
    const three = await purgeAfterFailedReset();
    expect(three.closed).toBe(true);
    expect(three.liveAtDecision).toBe(0);
    expect(BackupDatabase.unclosedHandleCount()).toBe(0);
  });

  test('a close that fails once is retried inside the same call', async () => {
    await BackupDatabase.getUploadedCount('photo');
    const handle = all[all.length - 1];
    handle.failCloses = 1;
    const result = await purgeAfterFailedReset();
    expect(handle.closeCalls).toBe(2);
    expect(result.closed).toBe(true);
    expect(result.liveAtDecision).toBe(0);
  });

  test('control: a handle that closes at once reports closed, with one close call', async () => {
    await BackupDatabase.getUploadedCount('photo');
    const handle = all[all.length - 1];
    const result = await purgeAfterFailedReset();
    expect(handle.closeCalls).toBe(1);
    expect(result.closed).toBe(true);
  });
});

describe('round 7 sweep: an open whose migration throws does not leak its connection', () => {
  test('the connection the failed open created is closed, and closeHandles() can see none left open', async () => {
    // Start from no handle: a purge with a failed reset leaves none.
    await purgeAfterFailedReset();
    const before = all.length;
    migrationFailsOnce = true;
    await expect(BackupDatabase.initDatabase()).rejects.toThrow('disk I/O error');
    expect(all.length).toBe(before + 1);
    const failed = all[all.length - 1];
    // The bug: dbPromise rejected, the open connection was dropped, and the
    // purge below reported "closed" with it still open.
    expect(failed.reallyOpen).toBe(false);
    const result = await purgeAfterFailedReset();
    expect(result.liveAtDecision).toBe(0);
    expect(result.closed).toBe(true);
  });

  test('when that close fails too, the connection is tracked and closeHandles() stays false', async () => {
    await purgeAfterFailedReset();
    migrationFailsOnce = true;
    nextConnectionUnclosable = true;
    const before = all.length;
    await expect(BackupDatabase.initDatabase()).rejects.toThrow('disk I/O error');
    expect(all.length).toBe(before + 1);
    const stuck = all[all.length - 1];
    expect(stuck.reallyOpen).toBe(true);
    const result = await purgeAfterFailedReset();
    expect(result.closed).toBe(false);
    expect(BackupDatabase.unclosedHandleCount()).toBe(1);
  });
});
