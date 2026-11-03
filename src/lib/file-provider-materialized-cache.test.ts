// @ts-nocheck — bun runs this; compiles the shipped CacheManager.swift against SQLite (macOS).
/**
 * Task 1722 round 4 (review round 2, minor 6): the File Provider cache keeps the folders the system
 * has materialized, so the working set can carry their children (iOS never lists such a folder
 * again). Stored as `sync_state` keys `materialized.container.<id>`: folder ids only, written under
 * the same purge rules as every other cache write, and cleared by the sign-out reset
 * (`DELETE FROM sync_state`).
 *
 * This harness compiles the REAL CacheManager.swift (one SQLite connection, as in the extension)
 * with doubles only for the App Group path and the purge marker, and uses a second connection the
 * way the app's purge does (PRAGMA user_version bump, DELETE FROM sync_state).
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const CACHE_MANAGER = join(ROOT, 'targets', 'file-provider', 'CacheManager.swift');
const CACHE_MANAGER_SOURCE = readFileSync(CACHE_MANAGER, 'utf8');
const MODULE = readFileSync(join(ROOT, 'modules', 'beebeeb-crypto', 'ios', 'BeebeebCryptoModule.swift'), 'utf8');
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

test('the sign-out reset deletes every sync_state key, the materialized folders included', () => {
  const start = MODULE.indexOf('private func resetFileProviderCacheDatabase(at url: URL) -> Bool {');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = MODULE.slice(start, MODULE.indexOf('\n}\n', start));
  expect(body).toContain('DELETE FROM sync_state');
});

test('alias repair uses a lightweight sibling projection without thumbnail blobs', () => {
  const start = CACHE_MANAGER_SOURCE.indexOf('private let aliasRowSelectSql');
  expect(start).toBeGreaterThanOrEqual(0);
  const select = CACHE_MANAGER_SOURCE.slice(start, CACHE_MANAGER_SOURCE.indexOf('\n  """', start) + 6);
  for (const column of ['id', 'parent_id', 'name_decrypted', 'name_encrypted', 'display_name', 'display_name_source_name', 'display_name_source_parent', 'created_at']) {
    expect(select).toContain(column);
  }
  expect(select).not.toContain('thumbnail_data');
  expect(select).not.toContain('thumbnail_nonce');
});

const driver = String.raw`
import Foundation
import SQLite3

enum AppGroupContainer {
  static var cacheDatabaseUrl: URL { URL(fileURLWithPath: CommandLine.arguments[1]) }
}
enum PlaintextStorageProtection {
  static var pending = false
  static func isPurgePending() -> Bool { pending }
  @discardableResult static func protect(_ url: URL) -> Bool { true }
  static func protectSQLiteSidecars(_ url: URL) {}
}

var passed = 0, failed = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  if condition() { passed += 1 } else { failed += 1; print("FAIL: \(label)") }
}
/// A second connection, as the app's purge uses.
func otherConnection(_ sql: String) {
  var db: OpaquePointer?
  guard sqlite3_open(CommandLine.arguments[1], &db) == SQLITE_OK else { print("FAIL: open"); return }
  sqlite3_busy_timeout(db, 2000)
  if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK { print("FAIL: \(sql)") }
  sqlite3_close(db)
}
func lockedLegacyCache() -> OpaquePointer? {
  var db: OpaquePointer?
  guard sqlite3_open(CommandLine.arguments[1], &db) == SQLITE_OK, let db else { return nil }
  let schema = """
  CREATE TABLE file_cache (
    id TEXT PRIMARY KEY, parent_id TEXT, name_encrypted TEXT, name_decrypted TEXT,
    mime_type TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, is_folder INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0, has_thumbnail INTEGER NOT NULL DEFAULT 0,
    thumbnail_data BLOB, thumbnail_nonce BLOB, created_at TEXT, updated_at TEXT,
    sync_anchor INTEGER NOT NULL DEFAULT 0, is_materialized INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE upload_queue (id TEXT PRIMARY KEY, parent_id TEXT, local_path TEXT, file_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
  INSERT INTO file_cache(id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
    is_folder, is_pinned, has_thumbnail, created_at, sync_anchor, is_materialized)
    VALUES('legacy', 'legacy-parent', 'legacy.txt', 'legacy.txt', 'text/plain', 3, 0, 0, 0, '1', 1, 0);
  """
  guard sqlite3_exec(db, schema, nil, nil, nil) == SQLITE_OK,
        sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else {
    sqlite3_close(db)
    return nil
  }
  return db
}
func hasColumn(_ name: String) -> Bool {
  var db: OpaquePointer?
  guard sqlite3_open(CommandLine.arguments[1], &db) == SQLITE_OK, let db else { return false }
  defer { sqlite3_close(db) }
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, "PRAGMA table_info(file_cache)", -1, &stmt, nil) == SQLITE_OK else { return false }
  defer { sqlite3_finalize(stmt) }
  while sqlite3_step(stmt) == SQLITE_ROW {
    if let value = sqlite3_column_text(stmt, 1), String(cString: value) == name { return true }
  }
  return false
}
func row(_ id: String, parent: String, name: String, displayName: String? = nil,
         sourceName: String? = nil, sourceParent: String? = nil, thumbnail: Data? = nil) -> CachedItem {
  CachedItem(
    id: id, parentId: parent, nameEncrypted: name, nameDecrypted: name,
    mimeType: "image/jpeg", sizeBytes: thumbnail?.count ?? 0, isFolder: false,
    isPinned: false, hasThumbnail: thumbnail != nil, thumbnailData: thumbnail,
    thumbnailNonce: nil, createdAt: id, updatedAt: nil, syncAnchor: 1,
    isMaterialized: false, displayName: displayName,
    displayNameSourceName: sourceName, displayNameSourceParent: sourceParent
  )
}

@main
struct Driver {
  static func main() {
    let blocker = lockedLegacyCache()
    check(blocker != nil, "the migration contention fixture is locked")
    let cache = CacheManager.shared
    check(cache.children(parent: "legacy-parent").map(\.id) == ["legacy"],
          "a blocked alias migration never serves a false empty folder")
    sqlite3_exec(blocker, "COMMIT", nil, nil, nil)
    sqlite3_close(blocker)
    check(cache.children(parent: "legacy-parent").map(\.id) == ["legacy"] && hasColumn("display_name_source_parent"),
          "the next open retries and completes the missing-column migration")
    let ids = { cache.materializedContainerIds() }
    check(ids().isEmpty, "a new cache lists no materialized folder")
    check(cache.noteContainerMaterialized("F"), "a listed folder is written")
    check(cache.noteContainerMaterialized("F"), "noting it again is harmless")
    check(ids() == ["F"], "one folder, got \(ids())")

    let epoch = cache.currentPurgeEpoch()
    check(cache.replaceMaterializedContainers(["F", "G"], expectedEpoch: epoch) == true, "the system's set replaces the stored one")
    check(ids() == ["F", "G"], "two folders, got \(ids())")
    check(cache.replaceMaterializedContainers(["F", "G"], expectedEpoch: epoch) == false, "the same set: no change reported")
    check(cache.replaceMaterializedContainers(["G"], expectedEpoch: epoch) == true && ids() == ["G"], "a folder made dataless leaves, got \(ids())")

    cache.setSyncState(key: "container.G.anchor", value: "1760000000")
    _ = cache.replaceMaterializedContainers([], expectedEpoch: epoch)
    check(ids().isEmpty, "an empty system set empties the stored one, got \(ids())")
    check(cache.syncState(key: "container.G.anchor") == "1760000000", "other sync_state keys are untouched")

    check(cache.replaceMaterializedContainers(["a%b_c"], expectedEpoch: epoch) == true && ids() == ["a%b_c"], "ids are stored literally (no LIKE patterns), got \(ids())")

    // A sign-out purge bumps PRAGMA user_version (the purge epoch) on its own connection.
    otherConnection("PRAGMA user_version = \(epoch + 1)")
    check(cache.replaceMaterializedContainers(["X"], expectedEpoch: epoch) == nil, "a purge since the epoch was read refuses the write")
    check(ids() == ["a%b_c"], "and nothing is written, got \(ids())")

    PlaintextStorageProtection.pending = true
    check(!cache.noteContainerMaterialized("Y"), "a pending purge refuses a note")
    check(cache.replaceMaterializedContainers(["Y"], expectedEpoch: cache.currentPurgeEpoch()) == nil, "and a replace")
    PlaintextStorageProtection.pending = false
    check(ids() == ["a%b_c"], "nothing written while the purge was pending, got \(ids())")

    let thumbnail = Data(repeating: 7, count: 1024 * 1024)
    cache.upsert(row("stable", parent: "photos", name: "photo.jpg", displayName: "photo.jpg",
                     sourceName: "photo.jpg", sourceParent: "photos", thumbnail: thumbnail))
    cache.upsert(row("other", parent: "photos", name: "other.jpg", displayName: "other.jpg",
                     sourceName: "other.jpg", sourceParent: "photos", thumbnail: thumbnail))
    cache.resetAliasSiblingQueryCountForTesting()
    check(cache.item(id: "stable")?.displayName == "photo.jpg", "a valid alias is returned")
    check(cache.aliasSiblingQueryCountForTesting == 0, "a valid item lookup does not query siblings")

    cache.upsert(row("new", parent: "photos", name: "photo.jpg"))
    cache.resetAliasSiblingQueryCountForTesting()
    let repaired = cache.item(id: "new")
    check(repaired?.displayName == "photo (2).jpg", "item(id:) repairs an app-written duplicate, got \(repaired?.displayName ?? "nil")")
    check(cache.aliasSiblingQueryCountForTesting > 0, "an invalid item lookup uses the sibling alias query")
    let names = cache.children(parent: "photos").compactMap(\.displayName)
    check(names.count == 3 && Set(names).count == 3, "children keeps app-written duplicates unique, got \(names)")

    // The purge's reset deletes every sync_state row.
    otherConnection("DELETE FROM sync_state")
    check(ids().isEmpty, "after the sign-out reset no folder is listed, got \(ids())")
    print("materialized-cache-harness: \(passed) checks passed, \(failed) failed")
  }
}
`;

nativeSwiftHarnessTest('the real CacheManager stores the materialized folders under the purge rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-materialized-cache-'));
  try {
  const driverPath = join(dir, 'Driver.swift');
  const binary = join(dir, 'driver');
  const output = join(dir, 'output.log');
  writeFileSync(driverPath, driver);
  try {
    execFileSync('xcrun', ['swiftc', '-D', 'DEBUG', '-parse-as-library', CACHE_MANAGER, driverPath, '-o', binary, '-lsqlite3'], { stdio: 'pipe', timeout: 180_000 });
  } catch (error) {
    throw new Error(`materialized-cache harness did not compile:\n${String(error?.stderr ?? error)}`);
  }
  try {
    execFileSync('/bin/sh', ['-c', '"$1" "$2" > "$3" 2>&1', 'materialized-cache', binary, join(dir, 'cache.sqlite'), output], { timeout: 60_000 });
  } catch {
    // asserted below
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  console.log(text);
  expect(text).not.toContain('FAIL:');
  expect(text).toContain('materialized-cache-harness: 25 checks passed, 0 failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
