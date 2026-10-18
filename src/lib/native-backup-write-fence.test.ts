// @ts-nocheck
/**
 * Task 1667 round 8 (Codex P1 "Fence late photo scans before resetting the
 * manifest", mobile#182 at 556ef334) — the write fence's source guards.
 *
 * Swift cannot be compiled on the Linux containers, and the engine itself
 * cannot be built in the swiftc tests (PhotoKit, Expo, uniffi), so the
 * WIRING is checked here against the real files: every manifest write in
 * `NativeBackupEngine.swift` sits behind a ticket check in its own `dbQueue`
 * block (`swift-write-fence-audit.ts`), every async producer takes its ticket
 * before its slow step, the handle advances the fence at the start of every
 * reset, and every JS write to the same database takes a ticket.
 * `scripts/swift-tests/manifest-write-fence-test.swift` runs the fence itself
 * on real SQLite.
 *
 * Each guard is shown red on a named in-memory mutation of the real file.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditWriteFence, EXEMPT } from './swift-write-fence-audit';
import { stripSwift } from './swift-db-queue-audit';

const IOS = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const engine = readFileSync(join(IOS, 'NativeBackupEngine.swift'), 'utf8');
const handleSwift = readFileSync(join(IOS, 'BackupManifestHandle.swift'), 'utf8');
const fenceSwift = readFileSync(join(IOS, 'ManifestWriteFence.swift'), 'utf8');
const backupDb = readFileSync(join(import.meta.dir, '../services/BackupDatabase.ts'), 'utf8');

function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`signature not found: ${signature}`);
  // The body is the first `{` after the parameter list (a default parameter
  // value can itself contain `{}`).
  let from = at + signature.length - 1;
  if (signature.endsWith('(')) {
    let parens = 0;
    for (let i = from; i < src.length; i += 1) {
      if (src[i] === '(') parens += 1;
      else if (src[i] === ')') {
        parens -= 1;
        if (parens === 0) {
          from = i;
          break;
        }
      }
    }
  }
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced: ${signature}`);
}

function mutate(src: string, from: string | RegExp, to: string): string {
  const out = src.replace(from, to);
  if (out === src) throw new Error(`mutation did not apply: ${from}`);
  return out;
}

/** Index of `a` < index of `b`, both present. */
function before(src: string, a: string, b: string): boolean {
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  return i > -1 && j > -1 && i < j;
}

// ---------------------------------------------------------------- producers

/** Each async producer takes its ticket before its slow step (fetch, network, batch). */
function producerOrder(src: string): string[] {
  const code = stripSwift(src);
  const bad: string[] = [];
  const check = (label: string, sig: string, ticket: string, slow: string) => {
    const b = body(code, sig);
    if (!before(b, ticket, slow)) bad.push(label);
  };
  check('scan', 'func scanPhotoLibraryForPendingUploads(', 'manifestWriteTicket(', 'fetchAssetsForBackup(');
  check('photo_library_change', 'func photoLibraryDidChange(', 'manifestWriteTicket(', 'changeDetails(');
  check('batch.rebuild', 'func processBatch(', 'manifestWriteTicket(', 'ensureManifestReadyForUploads(');
  check('batch.upload', 'func processBatch(', 'manifestWriteTicket(', 'uploadSingleAsset(');
  check('sign_out_mark_flush', 'func flushServerMarksForSignOut(', 'manifestWriteTicket(', 'SignOutMarkFlush.run(');
  check('background_task', 'private func handleBackgroundTask(', 'manifestWriteTicket(', 'scanPhotoLibraryForPendingUploads(');
  check('drain', 'private func startDrainLoop(', 'manifestWriteTicket(', 'recoverStuckUploads()');
  check('claim', 'func claimManifest(', 'manifestWriteTicket(', 'dbQueue.sync');
  check('chunk_put', 'private func uploadStagedChunk(', 'chunkTaskTickets[task.taskIdentifier] = ticket', 'task.resume()');
  return bad;
}

describe('NativeBackupEngine.swift: every manifest write is fenced', () => {
  const audit = auditWriteFence(engine);

  test('the audit examined the file (a guard that found nothing is a RED)', () => {
    expect(audit.writerFns.length).toBeGreaterThanOrEqual(20);
    expect(audit.sections.length).toBeGreaterThanOrEqual(50);
    expect(audit.sections.filter((s) => s.status === 'fenced').length).toBeGreaterThanOrEqual(41);
    expect(audit.sections.filter((s) => s.status === 'reset').length).toBeGreaterThanOrEqual(4);
  });

  test('0 violations: each writing dbQueue block checks its ticket first, is the reset, or is an exemption with a reason', () => {
    expect(audit.violations).toEqual([]);
    expect(audit.unusedExemptions).toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(40);
  });

  test('the Codex paths are fenced: scan, observer callback, rebuild steps, kept marks, mark records, sign-out flush, batch, chunk callbacks', () => {
    const fenced = new Set(audit.sections.filter((s) => s.status === 'fenced').map((s) => s.fn));
    for (const fn of [
      'scanPhotoLibraryForPendingUploads', 'photoLibraryDidChange', 'ensureManifestReadyForUploads',
      'applyKeptPendingMarks', 'markOnServer', 'flushServerMarksForSignOut', 'processBatch', 'startDrainLoop',
      'uploadSingleAsset', 'uploadStagedAsset', 'stageEncryptedAsset', 'resolveStagedChunks', 'uploadStagedChunk',
      'urlSession', 'claimManifest',
    ]) expect(fenced.has(fn)).toBe(true);
    expect(audit.sections.filter((s) => s.fn === 'ensureManifestReadyForUploads' && s.status === 'fenced').length).toBe(2);
  });

  test('the exempt uploadTaskMap branch is dead: nothing ever inserts into uploadTaskMap', () => {
    expect(stripSwift(engine)).not.toMatch(/uploadTaskMap\[[^\]]+\]\s*=/);
  });

  test('every producer takes its ticket before its slow step', () => {
    expect(producerOrder(engine)).toEqual([]);
    // The background task hands its ticket to its scan and its batch.
    const bg = body(engine, 'private func handleBackgroundTask(');
    expect(bg).toMatch(/scanPhotoLibraryForPendingUploads\(reason: "Background backup scan", ticket: writeTicket\)/);
    expect(bg).toMatch(/processBatch\(limit: mode\.batchLimit, ticket: writeTicket\)/);
  });

  test('observer-spawned scans are tracked and cancelled by stop() (best effort; the fence is the guarantee)', () => {
    const code = stripSwift(engine);
    expect(body(code, 'private func registerPhotoObserver(')).not.toMatch(/Task \{/);
    expect((body(code, 'private func registerPhotoObserver(').match(/spawnScan\(/g) ?? []).length).toBe(2);
    expect(body(engine, 'func photoLibraryDidChange(')).toMatch(/spawnScan\(reason: "Selected albums rescanned"/);
    const stop = body(code, 'func stop() {');
    expect(before(stop, 'cancelScanTasks()', 'guard isRunning else { return }')).toBe(true);
    const scan = body(code, 'func scanPhotoLibraryForPendingUploads(');
    expect(before(scan, 'fetchAssetsForBackup(', 'guard !Task.isCancelled else { return false }')).toBe(true);
  });

  test('the sign-out runs stop() before the reset, and bindAccount (the sign-in) binds the fence before its first write', () => {
    const prep = body(engine, 'func prepareForStoragePurge(\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> (kept: Set<String>, resetFailed: Bool) {');
    expect(before(prep, 'stop()', 'manifestHandle.resetForSignOut(')).toBe(true);
    const bind = body(engine, 'func bindAccount(userId: String) {');
    expect(before(bind, 'dbQueue.sync { manifestHandle.writeFence.bind(accountId: userId) }', 'claimManifest(forAccount: userId)')).toBe(true);
    // No other call site binds (and so unseals) the fence.
    expect((stripSwift(engine).match(/writeFence\.bind\(/g) ?? []).length).toBe(1);
  });

  test('chunk callbacks only touch the rows of the upload session they were sent for', () => {
    expect(engine).toMatch(/AND a\.upload_session_id = \?/);
    for (const sig of ['private func markChunkUploaded(', 'private func markChunkFailed(']) {
      const fn = body(engine, sig);
      expect(fn).toMatch(/WHERE \\\(Self\.chunkSessionPredicate\)/);
      expect(fn).toMatch(/sqlite3_bind_text\(stmt, 4, \(uploadSessionId as NSString\)/);
    }
  });
});

describe('BackupManifestHandle.swift: every reset advances the fence first', () => {
  test('resetForSignOut seals the fence before it reads or deletes anything', () => {
    const reset = stripSwift(body(handleSwift, 'func resetForSignOut(\n    outgoingAccountId: String?,\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> Bool {'));
    expect(reset.trim().startsWith('writeFence.advanceForSignOut()')).toBe(true);
  });

  test('nothing else moves or unseals the fence: only the sign-out reset advances it, only bindAccount binds it', () => {
    const all = stripSwift(engine) + stripSwift(handleSwift);
    expect((all.match(/writeFence\.advanceForSignOut\(\)/g) ?? []).length).toBe(1);
    expect((all.match(/writeFence\.bind\(/g) ?? []).length).toBe(1);
  });

  test('every FencedManifestWrites function checks the fence before it touches the database', () => {
    const code = stripSwift(fenceSwift);
    const enumBody = body(code, 'enum FencedManifestWrites {');
    const fns = [...enumBody.matchAll(/static func (\w+)\(/g)].map((m) => m[1]);
    // Round 10: + promoteCheckedHits (the batch server check).
    expect(fns.length).toBe(7);
    for (const f of fns) {
      const b = body(enumBody, `static func ${f}(`);
      expect(before(b, 'fence.admits(ticket, writer:', 'guard let db else')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- JS writers

/** The statements of a body, comment lines dropped. */
function statements(b: string): string {
  return b.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
}

/** Exported BackupDatabase functions whose body writes; each must use getWriteDb. */
function jsWriters(src: string): { writers: string[]; unfenced: string[] } {
  const writers: string[] = [];
  const unfenced: string[] = [];
  for (const m of src.matchAll(/export async function (\w+)\(/g)) {
    const b = body(src.slice(m.index), `export async function ${m[1]}(`);
    if (!/\b(INSERT\s+INTO|UPDATE\s+backup_\w+|DELETE\s+FROM)\b/.test(b)) continue;
    writers.push(m[1]);
    if (/\bgetDb\(\)/.test(b) || !/getWriteDb\(\w+, '\w+'\)/.test(b)) unfenced.push(m[1]);
  }
  return { writers, unfenced };
}

describe('BackupDatabase.ts: every JS write takes a ticket', () => {
  test('all 14 writers use the fenced write handle', () => {
    const { writers, unfenced } = jsWriters(backupDb);
    expect(writers.length).toBe(14);
    expect(unfenced).toEqual([]);
  });

  test('the storage-purge hold advances the purge generation before anything else', () => {
    const hold = body(backupDb, 'export async function suspendForStoragePurge(): Promise<StoragePurgeHold> {');
    expect(statements(hold).startsWith('advanceBackupPurgeGeneration();')).toBe(true);
  });

  test('the ticket is checked in the same step that starts the statement', () => {
    const fenced = body(backupDb, 'async function onHandleFenced<T>(');
    const lines = fenced.split('\n').map((l) => l.trim()).filter(Boolean);
    const awaitHandle = lines.indexOf('const db = await dbPromise;');
    expect(awaitHandle).toBeGreaterThan(-1);
    expect(lines[awaitHandle + 1]).toBe('if (!admitsBackupWrite(ticket)) {');
    expect(fenced.indexOf('callStarted();')).toBeGreaterThan(fenced.indexOf('admitsBackupWrite(ticket)'));
    // No await between the check and the call.
    const between = fenced.slice(fenced.indexOf('admitsBackupWrite(ticket)'), fenced.indexOf('return await call(db);'));
    expect(between).not.toMatch(/\bawait\b/);
  });

  test('each production caller takes its ticket when its work starts, before its first await', () => {
    const read = (p: string) => readFileSync(join(import.meta.dir, p), 'utf8');
    const verifier = body(read('../services/BackupVerifier.ts'), 'async function verifySingleFile(deps: VerifyDeps): Promise<boolean> {');
    expect(before(statements(verifier), 'const writeTicket = backupWriteTicket();', 'await ')).toBe(true);
    expect((verifier.match(/recordVerification\([^;]*writeTicket\)/g) ?? []).length).toBe(6);
    const cascade = body(read('./delete-cascade.ts'), 'export async function onFilesDeleted(');
    expect(before(statements(cascade), 'const writeTicket = backupWriteTicket();', 'await ')).toBe(true);
    expect(cascade).toMatch(/markRemoteDeletedByFileIds\(unique, writeTicket\)/);
    const reconcile = body(read('../services/BackupService.ts'), 'export async function reconcileDerivedStateAgainstServer(): Promise<void> {');
    expect(before(statements(reconcile), 'const writeTicket = backupWriteTicket();', 'await ')).toBe(true);
    expect((reconcile.match(/resetUploadedState\([^)]*, writeTicket\)/g) ?? []).length).toBe(2);
    const photos = read('../screens/PhotosScreen.tsx');
    const del = photos.slice(photos.indexOf("setBulkStatus('Deleting from Beebeeb...');"));
    expect(before(statements(del), 'const writeTicket = backupWriteTicket();', 'await trashFiles(')).toBe(true);
    expect(del).toMatch(/markRemoteDeleted\(localAssetId, writeTicket\)/);
  });
});

// ---------------------------------------------------------------- red-proof

describe('each guard goes RED on a named mutation (guard red-proof)', () => {
  test('M1 — one upload write loses its ticket check', () => {
    const bad = mutate(engine, /dbQueue\.sync \{\n(\s*)guard admitsWrite\(ticket, "markStaging"\) else \{ return \}\n/, 'dbQueue.sync {\n');
    expect(auditWriteFence(bad).violations.some((v) => v.includes('uploadSingleAsset') && v.includes('markStaging'))).toBe(true);
  });

  test('M2 — the scan takes its ticket after the PhotoKit fetch (the Codex window)', () => {
    const bad = mutate(
      engine,
      'guard let ticket = callerTicket ?? manifestWriteTicket("scan") else { return false }',
      'let __deferred = 0',
    ).replace('guard !Task.isCancelled else { return false }\n    let scanned', 'guard let ticket = callerTicket ?? manifestWriteTicket("scan") else { return false }\n    guard !Task.isCancelled else { return false }\n    let scanned');
    expect(producerOrder(bad)).toContain('scan');
  });

  test('M3 — the observer callback inserts straight into the store (the 556ef334 shape)', () => {
    const bad = mutate(
      engine,
      /let written = FencedManifestWrites\.scanInsert\(\n\s*self\.db, fence: self\.manifestHandle\.writeFence, ticket: ticket, writer: "photo_library_change\.insert",\n\s*assets: inserted, selection: nil, nowMs: self\.nowMs\(\)\n\s*\)/,
      'let written = FencedManifestWrites.ScanWrite.written(inserted: BackupManifestStore.insertScannedAssets(self.db!, inserted, nowMs: self.nowMs()))',
    );
    expect(auditWriteFence(bad).violations.some((v) => v.includes('photoLibraryDidChange'))).toBe(true);
  });

  test('M4 — a new writer with an inline INSERT, called from an async block without a ticket', () => {
    const bad = mutate(
      engine,
      '  // MARK: - Task 1667 round 8: manifest write fence\n',
      '  private func lateWriter() { dbQueue.async { [weak self] in guard let db = self?.db else { return }; sqlite3_exec(db, "INSERT INTO backup_assets (local_asset_id) VALUES (1)", nil, nil, nil) } }\n  // MARK: - Task 1667 round 8: manifest write fence\n',
    );
    expect(auditWriteFence(bad).violations.some((v) => v.includes('lateWriter'))).toBe(true);
  });

  test('M5 — a FencedManifestWrites call handed no ticket', () => {
    const bad = mutate(
      engine,
      'self.db, fence: self.manifestHandle.writeFence, ticket: ticket, writer: "scan.insert",',
      'self.db, fence: self.manifestHandle.writeFence, ticket: nil, writer: "scan.insert",',
    );
    expect(auditWriteFence(bad).violations.some((v) => v.includes('FencedManifestWrites.scanInsert'))).toBe(true);
  });

  test('M6 — an exemption whose section is gone is reported stale', () => {
    const bad = mutate(engine, /\n    \/\/ Recover any rows stuck in 'uploading' state\n    dbQueue\.async \{ \[weak self\] in\n      self\?\.recoverStuckUploads\(\)\n    \}/, '');
    expect(auditWriteFence(bad).violations).toContain('stale exemption: stop has no unfenced write section');
  });

  test('M7 — resetForSignOut no longer advances the fence first', () => {
    const bad = mutate(handleSwift, '    writeFence.advanceForSignOut()\n', '');
    const reset = stripSwift(body(bad, 'func resetForSignOut(\n    outgoingAccountId: String?,\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> Bool {'));
    expect(reset.trim().startsWith('writeFence.advanceForSignOut()')).toBe(false);
  });

  test('M8 — a FencedManifestWrites function writes before its fence check', () => {
    const bad = mutate(
      fenceSwift,
      '    guard fence.admits(ticket, writer: "rebuild.apply_map") else { return nil }\n    guard let db else { return nil }\n',
      '    guard let db else { return nil }\n    guard fence.admits(ticket, writer: "rebuild.apply_map") else { return nil }\n',
    );
    const b = body(stripSwift(bad), 'static func applyServerMap(');
    expect(before(b, 'fence.admits(ticket, writer:', 'guard let db else')).toBe(false);
  });

  test('M9 — a JS writer goes back to the raw handle', () => {
    const bad = mutate(backupDb, "const db = await getWriteDb(ticket, 'recordVerification');", 'const db = await getDb();');
    expect(jsWriters(bad).unfenced).toEqual(['recordVerification']);
  });

  test('M10 — the purge hold stops advancing the purge generation', () => {
    const bad = mutate(backupDb, '  advanceBackupPurgeGeneration();\n  if (purgeHolds === 0) {', '  if (purgeHolds === 0) {');
    const hold = body(bad, 'export async function suspendForStoragePurge(): Promise<StoragePurgeHold> {');
    expect(statements(hold).startsWith('advanceBackupPurgeGeneration();')).toBe(false);
  });

  test('CONTROL — the real files stay green under the same checks', () => {
    expect(auditWriteFence(engine).violations).toEqual([]);
    expect(producerOrder(engine)).toEqual([]);
    expect(jsWriters(backupDb).unfenced).toEqual([]);
  });
});
