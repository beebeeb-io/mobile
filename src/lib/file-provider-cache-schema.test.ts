// @ts-nocheck — reads Swift source and runs the extracted production SQLite helpers on macOS.
/**
 * Task 1722 (f, 2026-10-14): the first "Mount Beebeeb in Files" on a fresh install failed with
 * "Files integration is unavailable on this device". `syncFileProviderCache` created the cache
 * database with only `file_cache`; the forced reset before the mount ran `DELETE FROM sync_state`,
 * which fails with "no such table", so the fail-closed domain-add gate refused the mount.
 *
 * Fixed by giving both main-app writers ONE schema (`fileProviderCacheSchemaStatements`) and by
 * creating any missing table inside the reset transaction before its DELETEs. The extension's
 * `CacheManager.runMigrations` is a separate compiled target, so its copy is pinned to the same
 * statements here instead of shared by import.
 *
 * Imports no app module (fs + child_process only), so it needs no `mock.module` calls.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const MODULE_SWIFT = readFileSync(join(ROOT, 'modules', 'beebeeb-crypto', 'ios', 'BeebeebCryptoModule.swift'), 'utf8');
const CACHE_MANAGER_SWIFT = readFileSync(join(ROOT, 'targets', 'file-provider', 'CacheManager.swift'), 'utf8');
const REQUIRE_NATIVE_SWIFT_HARNESSES = process.env.BB_REQUIRE_NATIVE_SWIFT_HARNESSES === '1';

function nativeSwiftHarnessTest(name: string, fn: () => void, timeout?: number): void {
  if (process.platform === 'darwin') {
    test(name, fn, timeout);
    return;
  }
  if (REQUIRE_NATIVE_SWIFT_HARNESSES) {
    test(name, () => {
      throw new Error('native Swift harnesses require macOS; run this in CI swift-gate');
    }, timeout);
    return;
  }
  test.skip(`${name} [macOS Swift harness; required in CI swift-gate]`, fn, timeout);
}

/** Brace-matched slice of `source` starting at `signature` (signature through the closing brace). */
function bracedBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated body for ${signature}`);
}

/** The `private let fileProviderCacheSchemaStatements = [ ... ]` declaration, bracket-matched. */
function schemaDeclaration(): string {
  const signature = 'private let fileProviderCacheSchemaStatements = [';
  const start = MODULE_SWIFT.indexOf(signature);
  if (start === -1) throw new Error('fileProviderCacheSchemaStatements declaration not found');
  const open = start + signature.length - 1;
  let depth = 0;
  for (let i = open; i < MODULE_SWIFT.length; i += 1) {
    if (MODULE_SWIFT[i] === '[') depth += 1;
    if (MODULE_SWIFT[i] === ']') {
      depth -= 1;
      if (depth === 0) return MODULE_SWIFT.slice(start, i + 1);
    }
  }
  throw new Error('unterminated fileProviderCacheSchemaStatements declaration');
}

/** Every SQL statement in a Swift string-array literal, whitespace-normalised. */
function sqlStatements(swiftArray: string): string[] {
  const statements: string[] = [];
  const pattern = /"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)"/g;
  for (const match of swiftArray.matchAll(pattern)) {
    const sql = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (sql) statements.push(sql);
  }
  return statements;
}

const syncBody = bracedBody(
  MODULE_SWIFT,
  'AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]], prune: Bool?, pruneParents: [Any]?) -> Int in',
);

describe('task 1722 (f): one File Provider cache schema for every writer', () => {
  test('syncFileProviderCache runs the shared schema statements, not an inline single-table CREATE', () => {
    expect(syncBody).toContain('for statement in fileProviderCacheSchemaStatements');
    expect(syncBody).not.toMatch(/CREATE TABLE/);
  });

  test('the shared schema creates all three tables the forced reset deletes from', () => {
    const statements = sqlStatements(schemaDeclaration());
    for (const table of ['file_cache', 'sync_state', 'upload_queue']) {
      expect(statements.some((sql) => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`))).toBe(true);
    }
  });

  test('the extension CacheManager migrations are the same statements, in the same order', () => {
    const migrations = bracedBody(CACHE_MANAGER_SWIFT, 'private func runMigrations() {');
    const declaration = migrations.slice(migrations.indexOf('let statements = ['));
    expect(sqlStatements(declaration)).toEqual(sqlStatements(schemaDeclaration()));
  });

  test('the reset creates missing tables inside its transaction, before the first DELETE', () => {
    const reset = bracedBody(MODULE_SWIFT, 'private func resetFileProviderCacheDatabase(at url: URL) -> Bool {');
    const begin = reset.indexOf('"BEGIN"');
    const schema = reset.indexOf('for statement in fileProviderCacheSchemaStatements');
    const firstDelete = reset.indexOf('DELETE FROM file_cache');
    expect(begin).toBeGreaterThan(-1);
    expect(schema).toBeGreaterThan(begin);
    expect(firstDelete).toBeGreaterThan(schema);
  });
});

describe('task 1722 (f): the forced reset works on the database a fresh install actually has', () => {
  nativeSwiftHarnessTest('actual resetFileProviderCacheDatabase clears a file_cache-only database and leaves the full schema', () => {
    const declaration = schemaDeclaration();
    const vacuum = bracedBody(MODULE_SWIFT, 'private func vacuumRetryingOnceOnBusy(');
    const reset = bracedBody(MODULE_SWIFT, 'private func resetFileProviderCacheDatabase(at url: URL) -> Bool {');
    const dir = mkdtempSync(join(tmpdir(), 'bb-1722-schema-'));
    const source = join(dir, 'main.swift');
    writeFileSync(source, `
import Foundation
import SQLite3

${declaration}

${vacuum}

${reset}

var count = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAIL: \\(label)\\n".utf8))
    exit(1)
  }
  count += 1
}

func exec(_ db: OpaquePointer?, _ sql: String) {
  var error: UnsafeMutablePointer<Int8>?
  if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK {
    let message = error.map { String(cString: $0) } ?? "unknown"
    FileHandle.standardError.write(Data("FAIL: sql \\(sql): \\(message)\\n".utf8))
    exit(1)
  }
}

func scalar(_ db: OpaquePointer?, _ sql: String) -> Int32 {
  var stmt: OpaquePointer?
  defer { sqlite3_finalize(stmt) }
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
  return sqlite3_column_int(stmt, 0)
}

func open(_ url: URL) -> OpaquePointer? {
  var db: OpaquePointer?
  guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
    FileHandle.standardError.write(Data("FAIL: open\\n".utf8))
    exit(1)
  }
  return db
}

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)

// The database syncFileProviderCache used to leave behind on a fresh install:
// file_cache only, with the decrypted rows the app pushed.
let freshInstall = root.appendingPathComponent("fresh-install.sqlite")
do {
  let db = open(freshInstall)
  exec(db, """
  CREATE TABLE file_cache (
    id TEXT PRIMARY KEY, parent_id TEXT, name_encrypted TEXT, name_decrypted TEXT, mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0, is_folder INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
    has_thumbnail INTEGER NOT NULL DEFAULT 0, thumbnail_data BLOB, thumbnail_nonce BLOB, created_at TEXT, updated_at TEXT,
    sync_anchor INTEGER NOT NULL DEFAULT 0, is_materialized INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO file_cache (id, name_decrypted) VALUES ('a', 'previous-account-name.pdf');
  INSERT INTO file_cache (id, name_decrypted) VALUES ('b', 'another.txt');
  """)
  sqlite3_close(db)
}

check(resetFileProviderCacheDatabase(at: freshInstall), "reset of a file_cache-only database reports success")
do {
  let db = open(freshInstall)
  check(scalar(db, "SELECT count(*) FROM file_cache") == 0, "file_cache rows removed")
  check(scalar(db, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'") == 1, "sync_state created")
  check(scalar(db, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'upload_queue'") == 1, "upload_queue created")
  check(scalar(db, "SELECT count(*) FROM sync_state") == 0, "sync_state empty")
  check(scalar(db, "PRAGMA user_version") == 1, "purge epoch bumped once")
  sqlite3_close(db)
}

// A database with the full schema still resets exactly as before.
let full = root.appendingPathComponent("full.sqlite")
do {
  let db = open(full)
  for statement in fileProviderCacheSchemaStatements { exec(db, statement) }
  exec(db, "INSERT INTO file_cache (id) VALUES ('x'); INSERT INTO sync_state (key, value) VALUES ('container.root.anchor', '1'); INSERT INTO upload_queue (id, created_at) VALUES ('u', 'now'); PRAGMA user_version = 4;")
  sqlite3_close(db)
}
check(resetFileProviderCacheDatabase(at: full), "reset of a full-schema database reports success")
do {
  let db = open(full)
  check(scalar(db, "SELECT count(*) FROM file_cache") + scalar(db, "SELECT count(*) FROM sync_state") + scalar(db, "SELECT count(*) FROM upload_queue") == 0, "all rows removed")
  check(scalar(db, "PRAGMA user_version") == 5, "full-schema epoch bumped once")
  sqlite3_close(db)
}

// A missing database is still "nothing reset" (false): clearFileProviderCacheState
// handles absence before it ever calls the reset.
check(!resetFileProviderCacheDatabase(at: root.appendingPathComponent("absent.sqlite")), "absent database is not reported as reset")

print("cache-schema harness: \\(count) cases passed")
`);
    const binary = join(dir, 'harness');
    const output = join(dir, 'output.log');
    execFileSync('xcrun', ['swiftc', source, '-o', binary, '-lsqlite3'], { stdio: 'pipe', timeout: 120_000 });
    try {
      execFileSync('/bin/sh', ['-c', '"$1" "$2" > "$3" 2>&1', 'cache-schema', binary, dir, output], { timeout: 30_000 });
    } finally {
      // Surface the harness's own FAIL line in the bun failure output.
      // eslint-disable-next-line no-console
      console.log(readFileSync(output, 'utf8'));
    }
    expect(readFileSync(output, 'utf8')).toContain('cache-schema harness: 10 cases passed');
  }, 150_000);
});
