// @ts-nocheck
/**
 * Task 1667 round 10 (review of mobile#182 at 060bfeb0, findings 5 + 7).
 *
 * The REAL BackupDatabase.ts with a fake expo-sqlite: every open asks the
 * native JS-open gate first (backup-manifest-js-open-gate.ts), and opens
 * nothing when it is refused.
 *
 * Asserted:
 *   - with NO gate registered the module refuses to open (fail closed);
 *   - a refusal opens no connection, rejects the call with
 *     BackupManifestNotReadyError, and the NEXT call asks the gate again
 *     (a refused open is not a permanently rejected handle);
 *   - the gate is told whether a connection of ours may still be open.
 */
import { describe, expect, mock, test } from 'bun:test';

let opened = 0;
class FakeDb {
  async execAsync(): Promise<void> {}
  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (/PRAGMA\s+user_version/i.test(sql)) return { user_version: 99 } as T;
    if (/COUNT/i.test(sql)) return { count: 7 } as T;
    return null;
  }
  async getAllAsync(): Promise<unknown[]> { return []; }
  async runAsync(): Promise<{ changes: number }> { return { changes: 0 }; }
  async closeAsync(): Promise<void> {}
}

mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    opened += 1;
    return new FakeDb();
  },
}));

const gateModule = await import('../lib/backup-manifest-js-open-gate');
const BackupDatabase = await import('./BackupDatabase');

describe('round 10: BackupDatabase opens the manifest only through the native gate', () => {
  test('no gate registered: nothing is opened (fail closed)', async () => {
    gateModule.registerBackupManifestJsOpenGate(null);
    const err = await BackupDatabase.getUploadedCount('photo').then(() => null, (e) => e);
    expect(err?.name).toBe('BackupManifestNotReadyError');
    expect(err?.reason).toBe('no_gate');
    expect(opened).toBe(0);
  });

  test('a refusal opens nothing and is retried on the next call; an admission opens once', async () => {
    const calls: boolean[] = [];
    let verdict = { ok: 0, reason: 'pending_reset_failed' };
    gateModule.registerBackupManifestJsOpenGate(async (prior: boolean) => {
      calls.push(prior);
      return verdict;
    });
    for (let i = 0; i < 3; i += 1) {
      const err = await BackupDatabase.getUploadedCount('photo').then(() => null, (e) => e);
      expect(err?.name).toBe('BackupManifestNotReadyError');
      expect(err?.reason).toBe('pending_reset_failed');
    }
    expect(opened).toBe(0);
    // Asked again on every call: a refusal is not cached as a dead handle.
    expect(calls).toEqual([true, true, true]);
    verdict = { ok: 1, reason: null };
    expect(await BackupDatabase.getUploadedCount('photo')).toBe(7);
    expect(opened).toBe(1);
    expect(calls).toEqual([true, true, true, true]);
    // The open handle is reused; the gate is not asked per call.
    expect(await BackupDatabase.getUploadedCount('photo')).toBe(7);
    expect(opened).toBe(1);
    expect(calls.length).toBe(4);
  });
});
