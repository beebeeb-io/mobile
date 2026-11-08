// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * LD-0002 round 2 (TestFlight 258, `RUNNINGBOARD 0xdead10cc` in
 * `syncFileProviderCache`): every main-app connection to the File Provider cache
 * database goes through `FileProviderCacheDB`, the background execution gate; the
 * quiesce reaches it; the app feeds the gate. The Swift driver
 * scripts/swift-tests/file-provider-cache-quiesce-test.swift proves what the gate
 * DOES; this proves nothing bypasses it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DOCUMENTS_CONTAINER_FILES, auditAppGroupSqlite } from './swift-app-group-sqlite-audit';

const ROOT = join(import.meta.dir, '..', '..');
const IOS = join(ROOT, 'modules', 'beebeeb-crypto', 'ios');
const read = (name: string) => readFileSync(join(IOS, name), 'utf8');
const sources = () =>
  readdirSync(IOS)
    .filter((f) => f.endsWith('.swift'))
    .map((name) => ({ name, source: read(name) }));

const MODULE = read('BeebeebCryptoModule.swift');
const PSP = read('PlaintextStorageProtection.swift');
const ENGINE = read('NativeBackupEngine.swift');

describe('app-group SQLite audit: every main-app open of the File Provider cache is gated', () => {
  const audit = auditAppGroupSqlite(sources());

  test('no violation in the shipped sources', () => {
    expect(audit.violations).toEqual([]);
  });

  test('9 app-group open sites: the 8 in BeebeebCryptoModule.swift and the purge reset in PlaintextStorageProtection.swift', () => {
    expect(audit.appGroupSites.length).toBe(9);
    expect(audit.appGroupSites.every((s) => s.gated)).toBe(true);
    expect(audit.appGroupSites.filter((s) => s.file === 'PlaintextStorageProtection.swift').map((s) => s.where)).toEqual(['resetSQLiteInPlace']);
    expect(audit.appGroupSites.filter((s) => s.file === 'BeebeebCryptoModule.swift').map((s) => s.where).sort()).toEqual([
      'AsyncFunction(clearFileProviderAuthRequired)',
      'AsyncFunction(getFileProviderAuthRequiredAt)',
      'AsyncFunction(removeFileProviderEntries)',
      'AsyncFunction(setFileProviderProtectedFolder)',
      'AsyncFunction(syncFileProviderCache)',
      'bumpFileProviderCacheVersion',
      'ensureFileProviderCacheDatabase',
      'resetFileProviderCacheDatabase',
    ]);
  });

  test('the Documents-container files are the ones this audit was told about, with the opens they have', () => {
    expect(Object.keys(DOCUMENTS_CONTAINER_FILES).sort()).toEqual(['BackupManifestHandle.swift', 'BackupManifestStore.swift', 'ThumbnailQueueDB.swift']);
    expect(audit.documentsSites.map((s) => s.file).sort()).toEqual([
      'BackupManifestHandle.swift', 'BackupManifestStore.swift', 'BackupManifestStore.swift', 'ThumbnailQueueDB.swift',
    ]);
  });

  test('FileProviderCacheDB.swift itself opens nothing (it only gates and closes)', () => {
    expect(audit.sites.filter((s) => s.file === 'FileProviderCacheDB.swift')).toEqual([]);
  });

  // The audit has to be able to fail. Each mutant is one edit to the shipped text.
  const mutate = (file: string, from: string | RegExp, to: string) => {
    const all = sources().map((f) => ({ ...f }));
    const target = all.find((f) => f.name === file)!;
    const before = target.source;
    target.source = typeof from === 'string' ? target.source.replace(from, to) : target.source.replace(from, to);
    expect(target.source).not.toBe(before); // the mutant really changed something
    return auditAppGroupSqlite(all);
  };

  test('mutant: syncFileProviderCache opens without asking the gate -> red', () => {
    const r = mutate('BeebeebCryptoModule.swift', /guard let section = FileProviderCacheDB\.shared\.enter\(\) else \{\n        return FileProviderCacheOutcome<Int>\.notNow\.bridged\n      \}\n      var db: OpaquePointer\?\n      guard sqlite3_open_v2\(\n        dbPath,\n        &db,\n        SQLITE_OPEN_READWRITE \| SQLITE_OPEN_CREATE/, 'var db: OpaquePointer?\n      guard sqlite3_open_v2(\n        dbPath,\n        &db,\n        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE');
    expect(r.violations.some((v) => v.includes('AsyncFunction(syncFileProviderCache)') && v.includes('without asking the gate'))).toBe(true);
  });

  test('mutant: a new raw sqlite3_open_v2 on the cache in another function -> red', () => {
    const r = mutate('BeebeebCryptoModule.swift', 'private func fileProviderCacheDatabaseExists() -> Bool {', 'private func rawPeek() -> Bool {\n  var db: OpaquePointer?\n  guard sqlite3_open_v2("x", &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return false }\n  sqlite3_close(db)\n  return true\n}\n\nprivate func fileProviderCacheDatabaseExists() -> Bool {');
    expect(r.violations.some((v) => v.includes('rawPeek'))).toBe(true);
  });

  test('mutant: a connection that is never attached (an expiry cannot interrupt it) -> red', () => {
    const r = mutate('BeebeebCryptoModule.swift', /defer \{\n    section\.finish\(closing: db\)\n  \}\n  section\.attach\(db\)\n  \/\/ Task 1593 round 7 \(C2\)/, 'defer {\n    section.finish(closing: db)\n  }\n  // Task 1593 round 7 (C2)');
    expect(r.violations.some((v) => v.includes('ensureFileProviderCacheDatabase') && v.includes('never attaches'))).toBe(true);
  });

  test('mutant: a connection closed by hand, not by the section -> red', () => {
    const r = mutate('BeebeebCryptoModule.swift', 'defer { section.finish(closing: db) }\n      section.attach(db)\n      section.setBusyTimeout(db, milliseconds: 2000)\n      for statement in fileProviderCacheSchemaStatements {\n        guard section.admits else { return false }', 'defer { sqlite3_close(db) }\n      section.attach(db)\n      section.setBusyTimeout(db, milliseconds: 2000)\n      for statement in fileProviderCacheSchemaStatements {\n        guard section.admits else { return false }');
    expect(r.violations.some((v) => v.includes('clearFileProviderAuthRequired'))).toBe(true);
  });

  test('mutant: the purge reset opens without a scope -> red', () => {
    const r = mutate('PlaintextStorageProtection.swift', /      guard let entered = scope\.begin\(\) else \{ return \(false, false\) \}\n      section = entered/, '      section = nil');
    expect(r.violations.some((v) => v.includes('resetSQLiteInPlace') && v.includes('without asking the gate'))).toBe(true);
  });

  test('mutant: an unknown new file that opens a database is held to the same rule -> red', () => {
    const all = [...sources(), { name: 'NewCache.swift', source: 'func load() {\n  var db: OpaquePointer?\n  sqlite3_open_v2("p", &db, 0, nil)\n  sqlite3_close(db)\n}\n' }];
    const r = auditAppGroupSqlite(all);
    expect(r.violations.some((v) => v.startsWith('NewCache.swift'))).toBe(true);
  });
});

describe('the gate is wired: the app feeds it, the quiesce reaches the cache, the sign-out reset is inside it', () => {
  test('the engine claims the lifecycle and its quiesce interrupts and waits for the cache connections', () => {
    // The claim comes AFTER the gate is seeded from the real application state: a gate claimed first would read "foreground" in a process started in the background.
    const seed = ENGINE.indexOf('self?.executionGate.setForeground(state != .background)');
    const claim = ENGINE.indexOf('self?.executionGate.claimLifecycleOwnership()');
    expect(seed).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(seed);
    expect(ENGINE).not.toContain('BackupExecutionGate.shared.claimLifecycleOwnership()');
    expect(ENGINE).toContain('FileProviderCacheDB.shared.interruptInFlightStatements()');
    // The cache has its OWN bound, not what the manifest and thumbnail waits left over.
    expect(ENGINE).toMatch(/let cacheQuiet = FileProviderCacheDB\.shared\.waitForQuiet\(timeout: timeout\)/);
    expect(ENGINE).not.toMatch(/FileProviderCacheDB\.shared\.waitForQuiet\(timeout: deadline/);
    expect(ENGINE).toMatch(/return manifestQuiet && thumbnailQuiet && cacheQuiet/);
  });

  test('FileProviderCacheDB.shared only KICKS the lifecycle owner into existence: never on the caller, never waited for', () => {
    const ext = MODULE.slice(MODULE.indexOf('extension FileProviderCacheDB {'), MODULE.indexOf('private let fileProviderCacheResetOwedKey'));
    expect(ext).toMatch(/static let shared = FileProviderCacheDB\(\s*gate: \.shared,\s*ensureLifecycleOwner: \{\s*DispatchQueue\.global\(qos: \.utility\)\.async \{ _ = NativeBackupEngine\.shared \}/);
    expect(ext).not.toMatch(/usleep|Thread\.isMainThread|Thread\.sleep/);
    expect(MODULE).not.toMatch(/FileProviderCacheDB\(gate: BackupExecutionGate\(/);
    // An unclaimed gate refuses (enter() is nil); it does not wait.
    const db = read('FileProviderCacheDB.swift');
    const enter = db.slice(db.indexOf('public func enter() -> Section?'), db.indexOf('// `SQLiteResetScope`'));
    expect(enter).toMatch(/ensureLifecycleOwner\(\)\s*guard gate\.hasLifecycleOwner else \{ return nil \}/);
    expect(enter).not.toMatch(/usleep|\.wait\(/);
  });

  test('enter() reads the gate\'s open state and closure count in ONE step', () => {
    const db = read('FileProviderCacheDB.swift');
    const enter = db.slice(db.indexOf('public func enter() -> Section?'), db.indexOf('// `SQLiteResetScope`'));
    expect(enter).toContain('gate.openState()');
    expect(enter).not.toMatch(/gate\.closures|gate\.canStartSQLiteWork/);
    expect(read('BackupExecutionGate.swift')).toMatch(/public func openState\(\) -> \(open: Bool, closures: UInt64\) \{\s*lock\.lock\(\)\s*defer \{ lock\.unlock\(\) \}\s*return \(isOpenLocked, _closures\)/);
  });

  test('no gated connection waits on a plain busy timeout: they wait with a handler that asks the gate', () => {
    const module = MODULE.replace(/\/\/[^\n]*/g, '');
    expect(module).not.toMatch(/sqlite3_busy_timeout\(db, 2000\)/);
    expect((module.match(/section\.setBusyTimeout\(db, milliseconds: 2000\)/g) ?? []).length).toBe(5);
    expect(PSP).toContain('if let section { section.setBusyTimeout(db, milliseconds: 2000) } else { sqlite3_busy_timeout(db, 2000) }');
    const db = read('FileProviderCacheDB.swift');
    expect(db).toContain('sqlite3_busy_handler(db, fileProviderCacheBusy');
    expect(db).toMatch(/guard wait\.section\.admits else \{ return 0 \}/);
  });

  test('a reset the gate refused is a debt: marked on every refusal, paid first by every writer and on each foreground', () => {
    const db = read('FileProviderCacheDB.swift');
    expect(db).toMatch(/guard let section = enter\(\) else \{\s*\/\/[^\n]*\n\s*markResetOwed\(\)\s*return nil/);
    expect(MODULE).toMatch(/guard let section = FileProviderCacheDB\.shared\.enter\(\) else \{\s*FileProviderCacheDB\.shared\.markResetOwed\(\)\s*return false/);
    for (const closure of ['syncFileProviderCache', 'removeFileProviderEntries', 'setFileProviderProtectedFolder']) {
      const start = MODULE.indexOf(`AsyncFunction("${closure}")`);
      const body = MODULE.slice(start, start + 2500);
      const settle = body.indexOf('settleOwedFileProviderCacheReset()');
      const enter = body.indexOf('FileProviderCacheDB.shared.enter()');
      expect(settle).toBeGreaterThan(-1);
      expect(settle).toBeLessThan(enter);
    }
    expect(ENGINE).toMatch(/DispatchQueue\.global\(qos: \.utility\)\.async \{ settleOwedFileProviderCacheReset\(\) \}/);
  });

  test('a registration the gate refuses is deferred, not failed: nothing is changed and JS registers again on foreground', () => {
    const start = MODULE.indexOf('private func registerMountedFileProviderDomainLocked(');
    const body = MODULE.slice(start, start + 30000);
    const probe = body.indexOf('guard let gateProbe = FileProviderCacheDB.shared.enter()');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(body.indexOf('let domain = '));
    expect((body.match(/status\["deferred"\] = "gate_closed"/g) ?? []).length).toBe(2);
    expect(body.indexOf('FileProviderCacheDB.shared.gateRefuses')).toBeLessThan(body.indexOf('"stage": cacheReady ? "registration_cache_version_bump"'));
    expect(readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8')).toMatch(/result\?\.deferred === 'gate_closed'/);
  });

  test('the transaction stops at a BEGIN that fails', () => {
    const apply = read('FileProviderCacheDB.swift');
    expect(apply).toContain('guard sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK else { return .notNow }');
  });

  test('the sign-out purge resets the cache inside the gate', () => {
    expect(MODULE).toContain('PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce, preserving: manifest.kept.union(ThumbnailQueueDB.storagePurgePaths()), resetScope: FileProviderCacheDB.shared)');
    expect(PSP).toMatch(/static func resetSQLiteInPlace\(_ url: URL, scope: SQLiteResetScope\? = nil\)/);
    expect(PSP).toMatch(/let result = resetSQLiteInPlace\(entry\.url, scope: resetScope\)/);
  });

  test('syncFileProviderCache: gate -> open -> attach -> prepare -> the transaction (FileProviderCacheSync.apply) -> signal; "not_now" is typed', () => {
    const start = MODULE.indexOf('AsyncFunction("syncFileProviderCache")');
    const body = MODULE.slice(start, MODULE.indexOf('AsyncFunction("removeFileProviderEntries")'));
    const order = ['FileProviderCacheDB.shared.enter()', 'sqlite3_open_v2', 'section.attach(db)', 'PRAGMA secure_delete', 'FileProviderCacheSync.apply(', 'signalEnumerator'].map((s) => body.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain('FileProviderCacheOutcome<Int>.notNow.bridged');
    expect(body).toContain('-> [String: Any] in');
  });

  test('the Swift driver is registered with the runner and linked against the vanilla SQLite object', () => {
    const runner = readFileSync(join(ROOT, 'scripts', 'swift-ci', 'run-swift-tests.sh'), 'utf8');
    expect(runner).toMatch(/"file-provider-cache-quiesce-test\.swift\|[^"]*FileProviderCacheDB\.swift[^"]*BackupExecutionGate\.swift"/);
    expect(runner).toMatch(/thumbnail-queue-quiesce-test\.swift\|file-provider-cache-quiesce-test\.swift\)/);
  });
});
