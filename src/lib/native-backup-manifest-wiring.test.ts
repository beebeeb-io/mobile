// @ts-nocheck
/**
 * Task 1667 — structural guards on the native wiring around the camera-roll
 * backup manifest. The SQL behaviour itself is tested for real (swiftc +
 * SQLite) in scripts/swift-tests/backup-manifest-store-test.swift; what the
 * compiler cannot check is that the engine and the module CALL it in the
 * right places and order:
 *
 *   1. sign-out: `purgePlaintextStorage` empties the manifest through the
 *      engine's handle (`prepareForStoragePurge`) BEFORE the registry purge,
 *      and passes the kept files to it; `prepareForStoragePurge` stops and
 *      unbinds the engine first (a bound engine would re-upload into the
 *      emptied manifest), clears the Backups folder id (1962 Bug 4), and closes
 *      its own handle when the reset fails.
 *   2. ownership: `bindAccount` claims the manifest BEFORE its same-account
 *      early return; every completed upload records its account.
 *   3. rebuild: no batch reads pending uploads before
 *      `ensureManifestReadyForUploads`; every completed upload is marked on the
 *      server; the scan rebuilds and catches up on marks.
 *   4. JS hands the canonical device id to native before enable/trigger.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IOS = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const engine = readFileSync(join(IOS, 'NativeBackupEngine.swift'), 'utf8');
const moduleSwift = readFileSync(join(IOS, 'BeebeebCryptoModule.swift'), 'utf8');
const backupContext = readFileSync(join(import.meta.dir, 'backup-context.tsx'), 'utf8');

/** Strip `//` comments so prose that names a call never counts as the call. */
function code(s: string): string {
  return s.replace(/\/\/[^\n]*/g, '');
}

/** The `{ ... }` body that follows `signature` (brace matched). */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`signature not found: ${signature}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return code(src.slice(open + 1, i));
    }
  }
  throw new Error(`unbalanced: ${signature}`);
}

function order(src: string, ...needles: string[]): number[] {
  return needles.map((n) => src.indexOf(n));
}

describe('1. sign-out empties the manifest in place, before the registry purge', () => {
  const purge = body(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');

  test('prepareForStoragePurge runs before purgeAll, and purgeAll keeps what it returned', () => {
    const [prep, purgeAll] = order(
      purge,
      'let keptBackupDatabase = NativeBackupEngine.shared.prepareForStoragePurge()',
      'PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce, preserving: keptBackupDatabase)',
    );
    expect(prep).toBeGreaterThan(-1);
    expect(purgeAll).toBeGreaterThan(prep);
  });

  const prep = body(engine, 'func prepareForStoragePurge() -> Set<String> {');

  test('the engine is stopped and unbound BEFORE the manifest is emptied', () => {
    const [stop, unbind, reset] = order(prep, 'stop()', 'clearAccountAndPurgeStaged()', 'BackupManifestStore.resetInPlace(db)');
    expect(stop).toBeGreaterThan(-1);
    expect(unbind).toBeGreaterThan(stop);
    expect(reset).toBeGreaterThan(unbind);
  });

  test('the Backups folder id does not outlive the account (1962 Bug 4)', () => {
    expect(prep).toMatch(/parentFolderId = nil/);
  });

  test('the reset runs on dbQueue and a failed reset closes the handle instead of keeping it', () => {
    expect(prep).toMatch(/dbQueue\.sync \{[\s\S]*BackupManifestStore\.resetInPlace\(db\)[\s\S]*sqlite3_close_v2\(db\)\s*self\.db = nil\s*return \[\]/);
  });

  test('the kept paths are the database and its WAL sidecars', () => {
    expect(prep).toMatch(/return \[dbPath, dbPath \+ "-wal", dbPath \+ "-shm"\]/);
  });
});

describe('2. rows carry the account that owns them', () => {
  test('bindAccount claims the manifest BEFORE its same-account early return', () => {
    const bind = body(engine, 'func bindAccount(userId: String) {');
    const [claim, guardSame] = order(bind, 'claimManifest(forAccount: userId)', 'guard currentAccountId != userId else { return }');
    expect(claim).toBeGreaterThan(-1);
    expect(guardSame).toBeGreaterThan(claim);
  });

  test('every completed upload records its account', () => {
    const calls = (code(engine).match(/markUploadComplete\(assetId:[^)]*\)/g) ?? []).filter((c) => !c.includes(': String'));
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/accountId: batchAccountId/);
    const fn = body(engine, 'private func markUploadComplete(assetId: String, remoteFileId: String, accountId: String) {');
    expect(fn).toMatch(/BackupManifestStore\.markUploaded\([\s\S]*accountId: accountId/);
  });
});

describe('3. an empty manifest is rebuilt before any upload; uploads are marked on the server', () => {
  test('processBatch gates on ensureManifestReadyForUploads before it reads pending uploads', () => {
    const batch = body(engine, 'func processBatch(limit: Int = 12) async throws -> Int {');
    const [gate, pending] = order(
      batch,
      'guard await ensureManifestReadyForUploads(accountId: batchAccountId, authToken: authToken, baseURL: baseURL) else {',
      'getPendingUploads(limit: limit)',
    );
    expect(gate).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(gate);
  });

  test('a failed server fetch blocks uploads (returns false), it never proceeds into an empty manifest', () => {
    const ready = body(engine, 'func ensureManifestReadyForUploads(accountId: String, authToken: String, baseURL: String) async -> Bool {');
    const catchBlock = body(ready, 'catch {');
    expect(catchBlock).toMatch(/return false\s*$/);
    expect(catchBlock).not.toMatch(/return true/);
    expect(ready).toMatch(/guard let deviceId = backupDeviceId, !deviceId\.isEmpty else \{[\s\S]*?return false\s*\}/);
    // Ready only after the server map was applied (or nothing needed it).
    const [apply, ready1] = order(ready, 'BackupManifestStore.applyServerMap(', 'manifestReadyForAccount = accountId\n    RuntimeTrace');
    expect(apply).toBeGreaterThan(-1);
    expect(ready1).toBeGreaterThan(apply);
  });

  test('both upload completions are followed by a server mark', () => {
    const src = code(engine);
    const completions = [...src.matchAll(/markUploadComplete\(assetId: asset\.localAssetId/g)].map((m) => m.index ?? -1);
    expect(completions.length).toBe(2);
    for (const at of completions) {
      const next = src.indexOf('await markOnServer(', at);
      const nextCompletion = src.indexOf('markUploadComplete(assetId:', at + 1);
      expect(next).toBeGreaterThan(at);
      if (nextCompletion > -1) expect(next).toBeLessThan(nextCompletion);
    }
  });

  test('the scan rebuilds and catches up on server marks', () => {
    const scan = body(engine, 'func scanPhotoLibraryForPendingUploads(reason: String) async -> Bool {');
    const [rebuild, flush] = order(scan, 'await ensureManifestReadyForUploads(', 'await flushServerMarks(');
    expect(rebuild).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(rebuild);
  });

  test('the map calls send the device id the server keys photo_backup_state by', () => {
    const fetch = body(engine, 'private func fetchServerIdentifierMap(');
    const mark = body(engine, 'func markOnServer(');
    for (const b of [fetch, mark]) expect(b).toMatch(/setValue\(deviceId, forHTTPHeaderField: "X-Beebeeb-Device-Id"\)/);
    expect(fetch).toMatch(/\/api\/v1\/files\/photo-backup\/identifiers/);
    expect(mark).toMatch(/\/api\/v1\/files\/photo-backup\/mark/);
  });
});

describe('4. JS hands the canonical device id to native first', () => {
  test('mirrorBackupSessionForNative syncs the device id before anything else', () => {
    const fn = body(backupContext, 'async function mirrorBackupSessionForNative(): Promise<void> {');
    const [sync, register] = order(fn, 'await syncBackupDeviceIdToNative();', 'registerDevice()');
    expect(sync).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(sync);
  });

  test('both native enable paths go through mirrorBackupSessionForNative first', () => {
    const src = code(backupContext);
    for (const call of ['await enablePhotoBackup(token, userId);', 'await triggerImmediateBackup(token, userId);']) {
      const at = src.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      const mirror = src.lastIndexOf('await mirrorBackupSessionForNative();', at);
      expect(mirror).toBeGreaterThan(-1);
      expect(at - mirror).toBeLessThan(200);
    }
  });
});
