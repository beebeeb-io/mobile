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
  test('the engine marks itself built and its quiesce interrupts and waits for the cache connections', () => {
    // A plain flag set in init: the observer reads it and never constructs the engine.
    expect(ENGINE).toContain('BackupGateLifecycle.noteEngineBuilt()');
    // The flag flips only AFTER the engine's own didEnterBackground observer is live: before it, nobody would quiesce.
    const observed = ENGINE.indexOf('selector: #selector(handleAppDidEnterBackground)');
    expect(observed).toBeGreaterThan(-1);
    expect(ENGINE.indexOf('BackupGateLifecycle.noteEngineBuilt()')).toBeGreaterThan(observed);
    expect(ENGINE).not.toMatch(/claimLifecycleOwnership|hasLifecycleOwner/);
    expect(ENGINE).toContain('FileProviderCacheDB.shared.interruptInFlightStatements()');
    // Everything is interrupted first, then ONE deadline for all three waits, run at once: the main thread blocks `timeout` in total.
    expect(ENGINE).toMatch(/BackupSQLiteQuiesce\.waitForAll\(timeout: timeout, \[\s*\{ BackupSQLiteQuiesce\.waitForSerialQueue\(self\.dbQueue, timeout: \$0\) \},\s*\{ ThumbnailQueueDB\.shared\.waitForQuiet\(timeout: \$0\) \},\s*\{ FileProviderCacheDB\.shared\.waitForQuiet\(timeout: \$0\) \},/);
    expect(ENGINE).not.toMatch(/deadline\.timeIntervalSinceNow/);
  });

  test('the gate is seeded at launch by a small observer, so the cache path never needs the engine', () => {
    const delegate = readFileSync(join(IOS, 'BeebeebAppDelegate.swift'), 'utf8');
    const launch = delegate.slice(delegate.indexOf('didFinishLaunchingWithOptions'), delegate.indexOf('handleEventsForBackgroundURLSession'));
    const start = launch.indexOf('BackupGateLifecycle.shared.start(isBackground: application.applicationState == .background)');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(launch.indexOf('NativeBackupEngine.registerBackgroundTaskEarly()'));
    expect(launch.replace(/\/\/[^\n]*/g, '')).not.toContain('NativeBackupEngine.shared');
    // the observer quiesces only the stores the engine does not own, and never builds the engine
    const lifecycle = read('BackupGateLifecycle.swift');
    expect(lifecycle.replace(/\/\/[^\n]*/g, '')).not.toMatch(/NativeBackupEngine/);
    expect(delegate).toMatch(/extension BackupGateLifecycle \{[\s\S]*?ThumbnailQueueDB\.shared\.interruptInFlightStatement\(\)[\s\S]*?FileProviderCacheDB\.shared\.interruptInFlightStatements\(\)[\s\S]*?BackupSQLiteQuiesce\.waitForAll/);
    expect(lifecycle).toContain('gate.setForeground(!isBackground)');
    // a scene-based app activates through its scene; the owed reset is paid on foreground even with no cache writer
    expect(lifecycle).toMatch(/sceneWillEnterForeground[\s\S]*sceneDidActivate/);
    expect(lifecycle).toMatch(/gate\.setForeground\(true\)\s*payOwedReset\(\)/);
    expect(delegate).toMatch(/payOwedReset: \{\s*DispatchQueue\.global\(qos: \.utility\)\.async \{ settleOwedFileProviderCacheReset\(\) \}/);
    expect(lifecycle).toContain('guard !engineIsBuilt() else { return }');
  });

  test('the cache path never builds the engine, and the gate has no owner to ask for', () => {
    const cacheDb = read('FileProviderCacheDB.swift');
    expect(cacheDb.replace(/\/\/[^\n]*/g, '')).not.toMatch(/NativeBackupEngine|ensureLifecycleOwner|hasLifecycleOwner/);
    expect(read('BackupExecutionGate.swift')).not.toMatch(/hasLifecycleOwner|claimLifecycleOwnership|lifecycleOwned/);
    const ext = MODULE.slice(MODULE.indexOf('extension FileProviderCacheDB {'), MODULE.indexOf('private let fileProviderCacheResetOwedKey'));
    expect(ext.replace(/\/\/[^\n]*/g, '')).not.toMatch(/NativeBackupEngine|usleep|Thread\./);
    expect(ext).toMatch(/static let shared = FileProviderCacheDB\(\s*gate: \.shared,\s*owedStore:/);
    // none of the cache's JS-called closures, nor the helpers they call, reach for the engine
    for (const closure of ['syncFileProviderCache', 'removeFileProviderEntries', 'getFileProviderAuthRequiredAt', 'clearFileProviderAuthRequired', 'setFileProviderProtectedFolder']) {
      const start = MODULE.indexOf(`AsyncFunction("${closure}")`);
      expect(MODULE.slice(start, start + 3500).split('AsyncFunction("').slice(0, 2).join('').replace(/\/\/[^\n]*/g, '')).not.toContain('NativeBackupEngine');
    }
    for (const fn of ['private func bumpFileProviderCacheVersion(', 'private func ensureFileProviderCacheDatabase()', 'private func resetFileProviderCacheDatabase(at url: URL)']) {
      const start = MODULE.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      expect(MODULE.slice(start, MODULE.indexOf('\n}\n', start)).replace(/\/\/[^\n]*/g, '')).not.toContain('NativeBackupEngine');
    }
    // enter() has no owner path: it asks the gate and answers
    const enter = cacheDb.slice(cacheDb.indexOf('public func enter() -> Section?'), cacheDb.indexOf('// `SQLiteResetScope`'));
    expect(enter).not.toMatch(/usleep|\.wait\(|Lifecycle/);
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
    expect((module.match(/section\.setBusyTimeout\(db, milliseconds: 2000\)/g) ?? []).length).toBe(6); // + removeFileProviderEntries (round 5)
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
    // the closure count at the probe, not only the current state: a closure that already reopened still counts
    expect(body).toContain('let gateClosuresAtProbe = FileProviderCacheDB.shared.gateClosures');
    expect(body).toContain('FileProviderCacheDB.shared.gateClosures != gateClosuresAtProbe');
    expect(body.indexOf('FileProviderCacheDB.shared.gateRefuses')).toBeLessThan(body.indexOf('"stage": cacheReady ? "registration_cache_version_bump"'));
    expect(readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8')).toMatch(/result\?\.deferred === 'gate_closed'/);
  });

  test('a write only goes ahead when the owed reset was paid; a stopped reset is owed; a refused schema step is not-now; remove checks its BEGIN', () => {
    // 3a: the result of settle is used by all three writers
    expect((MODULE.match(/guard settleOwedFileProviderCacheReset\(\) else \{ return owedResetUnpaidAnswer\(since: closuresAtStart\) \}/g) ?? []).length).toBe(3);
    expect((MODULE.match(/let closuresAtStart = FileProviderCacheDB\.shared\.gateClosures/g) ?? []).length).toBe(3);
    // not-now only while the gate is the reason; a real reset failure is `failed`, counted towards the fallback
    expect(MODULE).toMatch(/func owedResetUnpaidAnswer\(since closuresAtStart: UInt64\) -> \[String: Any\] \{[^}]*?FileProviderCacheDB\.shared\.gateRefuses \|\| FileProviderCacheDB\.shared\.gateClosures != closuresAtStart\s*\?\s*FileProviderCacheOutcome<Int>\.notNow\.bridged\s*:\s*FileProviderCacheOutcome<Int>\.failed\.bridged/);
    expect(MODULE).toContain('FileProviderCacheDB.shared.settleOwedReset({');
    // NEVER unlink the cache database: the extension holds its connection open for the life of its process and never
    // reopens it, so a deleted file leaves the previous account's names visible in Files for good. A reset that keeps
    // failing ESCALATES (the domain is removed, as a sign-out does) and stays owed.
    const settle = MODULE.slice(MODULE.indexOf('func settleOwedFileProviderCacheReset() -> Bool {'), MODULE.indexOf('\n}\n', MODULE.indexOf('func settleOwedFileProviderCacheReset() -> Bool {')));
    expect(settle).toMatch(/escalate: \{[\s\S]*?removeFileProviderDomainIfRegistered\(\)/);
    expect(settle.replace(/\/\/[^\n]*/g, '')).not.toMatch(/removeItem|unlink|trashItem/);
    expect(read('FileProviderCacheDB.swift').replace(/\/\/[^\n]*/g, '')).not.toMatch(/removeItem|unlink|FileManager|trashItem/);
    // the only unlink of the cache database in the module is the pre-existing "cannot even open it" branch of the reset
    const resetFn = MODULE.slice(MODULE.indexOf('private func resetFileProviderCacheDatabase(at url: URL)'));
    expect((resetFn.slice(0, resetFn.indexOf('\n}\n')).match(/removeItem\(at: url\)/g) ?? []).length).toBe(1);
    for (const fn of ['private func bumpFileProviderCacheVersion(', 'private func ensureFileProviderCacheDatabase()']) {
      const start = MODULE.indexOf(fn);
      expect(MODULE.slice(start, MODULE.indexOf('\n}\n', start)).replace(/\/\/[^\n]*/g, '')).not.toMatch(/removeItem|unlink/);
    }
    for (const closure of ['syncFileProviderCache', 'removeFileProviderEntries', 'getFileProviderAuthRequiredAt', 'clearFileProviderAuthRequired', 'setFileProviderProtectedFolder']) {
      const start = MODULE.indexOf(`AsyncFunction("${closure}")`);
      expect(MODULE.slice(start, start + 4500).split('AsyncFunction("').slice(0, 2).join('').replace(/\/\/[^\n]*/g, '')).not.toMatch(/removeItem|unlink/);
    }
    // registration never mounts over an unpaid reset
    const registration = MODULE.slice(MODULE.indexOf('private func registerMountedFileProviderDomainLocked('));
    expect(registration.indexOf('files.registration_refused_reset_owed')).toBeGreaterThan(registration.indexOf('gateProbe.finish(closing: nil)'));
    expect(registration.indexOf('files.registration_refused_reset_owed')).toBeLessThan(registration.indexOf('let domain = '));
    // removeFileProviderEntries: a DELETE that cannot be prepared is a failure, and it waits like the others
    const removeFn = MODULE.slice(MODULE.indexOf('AsyncFunction("removeFileProviderEntries")'), MODULE.indexOf('AsyncFunction("getFileProviderAuthRequiredAt")'));
    expect(removeFn).toContain('section.setBusyTimeout(db, milliseconds: 2000)');
    expect(removeFn).toMatch(/\} else \{[^}]*deleteResult = SQLITE_ERROR/);
    // a step that fails with the gate open fails the transaction (apply and remove), never an ok with fewer rows
    const db = read('FileProviderCacheDB.swift');
    expect((db.match(/return fail\(\)|\? fail\(\) : abandon\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(MODULE).toMatch(/if deleteResult != SQLITE_OK && deleteResult != SQLITE_DONE \{[\s\S]*?FileProviderCacheOutcome<Int>\.failed\.bridged/);
    expect(MODULE).toMatch(/case \.failed: return FileProviderCacheOutcome<Int>\.failed\.bridged/);
    // 3b: a reset section the gate stops after admitting it leaves the debt (Section.finish), in both resets
    expect(read('FileProviderCacheDB.swift')).toMatch(/if isReset && !admits \{ owner\.markResetOwed\(\) \}/);
    expect(read('FileProviderCacheDB.swift')).toMatch(/section\.isReset = true\s*return section/);
    expect(MODULE).toMatch(/section\.isReset = true\s*\n/);
    // 5: a schema statement the gate stopped is not-now, never done(0)
    expect(MODULE).toMatch(/guard sqlite3_exec\(db, statement, nil, nil, nil\) == SQLITE_OK else \{[^}]*return section\.admits\s*\?\s*FileProviderCacheOutcome<Int>\.done\(0\)\.bridged\s*:\s*FileProviderCacheOutcome<Int>\.notNow\.bridged/);
    // 6: removeFileProviderEntries stops at a failed BEGIN, like apply
    const remove = MODULE.slice(MODULE.indexOf('AsyncFunction("removeFileProviderEntries")'), MODULE.indexOf('AsyncFunction("getFileProviderAuthRequiredAt")'));
    expect(remove).toMatch(/guard sqlite3_exec\(db, "BEGIN", nil, nil, nil\) == SQLITE_OK else \{\s*return FileProviderCacheOutcome<Int>\.notNow\.bridged/);
    // the in-memory debt counts when the store is unusable
    expect(read('FileProviderCacheDB.swift')).toContain('return owedInMemory || owedStore?.get() == true');
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
    expect(runner).toMatch(/"file-provider-cache-quiesce-test\.swift\|[^"]*FileProviderCacheDB\.swift[^"]*BackupGateLifecycle\.swift[^"]*BackupExecutionGate\.swift"/);
    expect(runner).toMatch(/thumbnail-queue-quiesce-test\.swift\|file-provider-cache-quiesce-test\.swift\)/);
  });
});
