// @ts-nocheck
/**
 * Task 1669 Issue 2 (lead review finding A) — `NativeBackupEngine.db` ordering guard.
 *
 * `init()` now ENQUEUES `openDatabase()` on the private serial `dbQueue`
 * instead of running it (so `.shared` cannot block the launch thread on
 * SQLite). That is only sound if (1) the enqueue is issued directly from
 * `init()` — before `.shared` is visible to any caller — and (2) every read
 * or write of `db` goes through `dbQueue`. The first WIP enqueued it from
 * inside a second queue's closure, which is a race that the compiler cannot
 * see: `NativeBackupEngine.shared.x()` -> `dbQueue.sync { guard let db }`
 * could run first and silently no-op on `db == nil`.
 *
 * Swift cannot be compiled on this platform, so this drives the source audit
 * in `swift-db-queue-audit.ts` against the REAL file, and — because a guard
 * must prove it can go red — against in-memory MUTATED copies that each
 * reintroduce one specific bug.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditDbQueue } from './swift-db-queue-audit';

const SWIFT = join(import.meta.dir, '../../modules/beebeeb-crypto/ios/NativeBackupEngine.swift');
const source = readFileSync(SWIFT, 'utf8');

function mutate(from: string | RegExp, to: string): string {
  const out = source.replace(from, to);
  if (out === source) throw new Error(`mutation did not apply: ${from}`);
  return out;
}

describe('NativeBackupEngine.swift: the real file', () => {
  const audit = auditDbQueue(source);

  test('the audit actually parsed the file (a guard that examined nothing is a RED)', () => {
    expect(audit.functionsParsed).toBeGreaterThan(100);
    expect(audit.touchingDb.length).toBeGreaterThanOrEqual(35);
    expect(audit.guarded.length).toBeGreaterThanOrEqual(10);
    expect(audit.requires.length).toBeGreaterThanOrEqual(25);
  });

  test('0 violations: every db accessor is on dbQueue, or is only called from dbQueue', () => {
    expect(audit.violations).toEqual([]);
  });

  test('openDatabase() has exactly one call site, a direct dbQueue.async in init()', () => {
    expect(audit.openDatabaseCallLines.length).toBe(1);
    expect(audit.openDatabaseEnqueuedFromInit).toBe(true);
  });

  test('round 2: the stricter call-site matcher examined every REQUIRES call (any receiver, hops excluded) and found them all on dbQueue', () => {
    expect(audit.callSitesChecked).toBeGreaterThanOrEqual(50);
    expect(audit.callSitesOnDbQueue).toBe(audit.callSitesChecked);
    expect(audit.dbQueueClosures).toBeGreaterThanOrEqual(50);
    expect(audit.hopClosures).toBeGreaterThanOrEqual(20); // Task { } / other-queue .async hops were really classified
  });

  test('the accessor that used to bypass dbQueue is now self-guarded', () => {
    expect(audit.guarded.some((k) => k.startsWith('resetRetryExhaustedUploadsForManualRun@'))).toBe(true);
  });
});

describe('the audit goes RED on each deliberate mutation (guard red-proof)', () => {
  test('MUTATION 1 — the WIP bug: openDatabase enqueued from inside a second queue closure', () => {
    const bad = mutate(
      'dbQueue.async { [weak self] in self?.openDatabase() }',
      'DispatchQueue(label: "deferred-init").async { [weak self] in self?.dbQueue.async { self?.openDatabase() } }',
    );
    const audit = auditDbQueue(bad);
    expect(audit.openDatabaseEnqueuedFromInit).toBe(false);
    expect(audit.violations.some((v) => v.includes('is not a direct dbQueue.async in init()'))).toBe(true);
  });

  test('MUTATION 2 — openDatabase run as a blocking dbQueue.sync in init() (the launch stall)', () => {
    const bad = mutate('dbQueue.async { [weak self] in self?.openDatabase() }', 'dbQueue.sync { openDatabase() }');
    expect(auditDbQueue(bad).openDatabaseEnqueuedFromInit).toBe(false);
  });

  test('MUTATION 3 — openDatabase called a second time, off init', () => {
    const bad = mutate('  private func ensureTables() {', '  func reopenForTest() { openDatabase() }\n  private func ensureTables() {');
    const audit = auditDbQueue(bad);
    expect(audit.violations.some((v) => v.includes('expected exactly 1 openDatabase() call site, found 2'))).toBe(true);
  });

  test('MUTATION 4 — a db accessor that bypasses dbQueue (new function reading db unguarded, called from a plain method)', () => {
    const bad = mutate(
      '  private func ensureTables() {',
      '  private func rogueCount() -> Int { guard let db = db else { return 0 }; return Int(sqlite3_total_changes(db)) }\n  func rogueCaller() -> Int { return rogueCount() }\n  private func ensureTables() {',
    );
    const audit = auditDbQueue(bad);
    expect(audit.violations.some((v) => v.startsWith('rogueCount() called at line'))).toBe(true);
  });

  test('MUTATION 5 — the pre-fix resetRetryExhaustedUploadsForManualRun: dbQueue.sync wrapper removed', () => {
    // Recreate the original unguarded shape: unwrap the closure body.
    const start = source.indexOf('func resetRetryExhaustedUploadsForManualRun() {');
    const open = source.indexOf('dbQueue.sync {', start);
    expect(open).toBeGreaterThan(start);
    // Replace the wrapper with a plain `do {` so braces stay balanced but db is no longer on dbQueue.
    const bad = source.slice(0, open) + 'do {' + source.slice(open + 'dbQueue.sync {'.length);
    // a caller off dbQueue must now be flagged
    const callerSrc = bad.replace('  private func ensureTables() {', '  func callsReset() { resetRetryExhaustedUploadsForManualRun() }\n  private func ensureTables() {');
    const audit = auditDbQueue(callerSrc);
    expect(audit.violations.some((v) => v.startsWith('resetRetryExhaustedUploadsForManualRun() called at line'))).toBe(true);
  });

  test('MUTATION 6 — db touched directly in init()', () => {
    const bad = mutate('    setupMetadataSession()\n', '    setupMetadataSession()\n    _ = sqlite3_libversion_number() + Int32(db == nil ? 0 : 1)\n');
    expect(auditDbQueue(bad).violations.some((v) => v.includes('init()'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 2 (lead ruling 4): the call-site matcher must see ANY receiver, and a hop to another
// queue / Task inside a dbQueue closure must not count as "on dbQueue".
// ---------------------------------------------------------------------------
const ROGUE = '  private func rogueCount() -> Int { guard let db = db else { return 0 }; return Int(sqlite3_total_changes(db)) }\n';
/** Adds `rogueCount()` (a REQUIRES accessor) plus `extra` members to the class. */
function withRogue(extra: string): string {
  return mutate('  private func ensureTables() {', `${ROGUE}${extra}\n  private func ensureTables() {`);
}
const violatesCall = (src: string) => auditDbQueue(src).violations.some((v) => v.startsWith('rogueCount() called at line'));

describe('round 2: the audit goes RED on receiver forms and queue/Task hops (in-test mutations)', () => {
  test('CONTROL — a call directly inside dbQueue.sync stays green (the stricter audit is not just always-red)', () => {
    const src = withRogue('  func okCaller() -> Int { return dbQueue.sync { rogueCount() } }');
    expect(auditDbQueue(src).violations).toEqual([]);
  });

  test('CONTROL — Task { dbQueue.sync { f() } }: a dbQueue closure INSIDE a hop is on dbQueue again', () => {
    const src = withRogue('  func okTask() { Task { _ = self.dbQueue.sync { self.rogueCount() } } }');
    expect(auditDbQueue(src).violations).toEqual([]);
  });

  test('CONTROL — the labelled form dbQueue.sync(execute: { f() }) is recognised as on dbQueue', () => {
    const src = withRogue('  func okExec() -> Int { return dbQueue.sync(execute: { rogueCount() }) }');
    expect(auditDbQueue(src).violations).toEqual([]);
  });

  test('MUTATION 7 — self?.fn( off dbQueue (weak-self closure on the main queue)', () => {
    expect(violatesCall(withRogue('  func m7() { DispatchQueue.main.async { [weak self] in _ = self?.rogueCount() } }'))).toBe(true);
  });

  test('MUTATION 8 — self!.fn( off dbQueue', () => {
    expect(violatesCall(withRogue('  func m8() -> Int { return self!.rogueCount() }'))).toBe(true);
  });

  test('MUTATION 9 — engine.fn( / any <expr>.fn( receiver off dbQueue', () => {
    expect(violatesCall(withRogue('  func m9(engine: NativeBackupEngine) -> Int { return engine.rogueCount() }'))).toBe(true);
    expect(violatesCall(withRogue('  func m9b() -> Int { return NativeBackupEngine.shared.rogueCount() }'))).toBe(true);
    expect(violatesCall(withRogue('  func m9c() -> Int { return (self).rogueCount() }'))).toBe(true);
  });

  test('MUTATION 10 — Task { f() } inside a dbQueue closure is NOT on dbQueue', () => {
    expect(violatesCall(withRogue('  func m10() { dbQueue.async { Task { _ = self.rogueCount() } } }'))).toBe(true);
  });

  test('MUTATION 11 — Task.detached { f() } inside a dbQueue closure is NOT on dbQueue', () => {
    expect(violatesCall(withRogue('  func m11() { dbQueue.sync { Task.detached(priority: .background) { _ = self.rogueCount() } } }'))).toBe(true);
  });

  test('MUTATION 12 — a hop to ANOTHER queue inside a dbQueue closure is NOT on dbQueue', () => {
    expect(violatesCall(withRogue('  func m12() { dbQueue.async { self.queue.async { _ = self.rogueCount() } } }'))).toBe(true);
    expect(violatesCall(withRogue('  func m12b() { dbQueue.async { DispatchQueue.global(qos: .utility).async { _ = self.rogueCount() } } }'))).toBe(true);
    expect(violatesCall(withRogue('  func m12c() { dbQueue.async { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { _ = self.rogueCount() } } }'))).toBe(true);
  });

  test('MUTATION 13 — a hop inside a REQUIRES function does not inherit its on-queue-ness', () => {
    // m13 touches db and is only ever called from dbQueue (so it is a legitimate REQUIRES host),
    // but the call in its Task body runs elsewhere.
    const src = withRogue('  private func m13() { guard let db = db else { return }; _ = db; Task { _ = self.rogueCount() } }\n  func m13caller() { dbQueue.sync { m13() } }');
    expect(violatesCall(src)).toBe(true);
  });

  test('MUTATION 14 — a direct db read inside a Task nested in a dbQueue closure', () => {
    const src = mutate(
      '  private func ensureTables() {',
      '  func m14() { dbQueue.async { Task { _ = self.db } } }\n  private func ensureTables() {',
    );
    expect(auditDbQueue(src).violations.some((v) => /db touched at line \d+ inside a Task hop/.test(v))).toBe(true);
  });
});
