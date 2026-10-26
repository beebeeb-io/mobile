// @ts-nocheck -- native SQLite harness; isolated bun test on macOS.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ios = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const nativeTest = process.platform === 'darwin' ? test : test.skip;

nativeTest('object-budget failures exhaust automatic retries immediately without changing transient failures', () => {
  const source = readFileSync(join(ios, 'NativeBackupEngine.swift'), 'utf8');
  const start = source.indexOf('  private func markFailed(');
  const end = source.indexOf('\n  private func markLocalMissing', start);
  const method = source.slice(start, end).replaceAll('exsqlite3_', 'sqlite3_');
  const terminalArgument = method.includes('retryLimitReached: Bool') ? ', retryLimitReached: true' : '';
  const dir = mkdtempSync(join(tmpdir(), 'bb-object-budget-'));
  writeFileSync(join(dir, 'main.swift'), String.raw`
import Foundation
import SQLite3
enum BackupManifestStore {
  static func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
    value.withCString { _ = sqlite3_bind_text(stmt, index, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
  }
}
final class Fixture {
  var db: OpaquePointer?
${method}
  func run() {
    precondition(sqlite3_open(":memory:", &db) == SQLITE_OK)
    defer { sqlite3_close(db) }
    precondition(sqlite3_exec(db, "CREATE TABLE backup_assets(local_asset_id TEXT, staged_file_id TEXT, status TEXT, retry_count INTEGER, error_message TEXT, last_attempt_at INTEGER); INSERT INTO backup_assets VALUES ('budget','remote','uploading',0,NULL,NULL),('transient',NULL,'uploading',3,NULL,NULL)", nil, nil, nil) == SQLITE_OK)
    markFailed(assetId: "budget", error: "File limit reached"${terminalArgument})
    markFailed(assetId: "transient", error: "Network unavailable")
    var stmt: OpaquePointer?
    precondition(sqlite3_prepare_v2(db, "SELECT retry_count,status,error_message FROM backup_assets WHERE local_asset_id='budget'", -1, &stmt, nil) == SQLITE_OK)
    precondition(sqlite3_step(stmt) == SQLITE_ROW)
    precondition(sqlite3_column_int(stmt, 0) == 10, "permanent refusal still retries")
    precondition(String(cString: sqlite3_column_text(stmt, 1)) == "staged_upload", "lost resumable staging")
    precondition(String(cString: sqlite3_column_text(stmt, 2)) == "File limit reached")
    sqlite3_finalize(stmt)
    precondition(sqlite3_prepare_v2(db, "SELECT retry_count,status FROM backup_assets WHERE local_asset_id='transient'", -1, &stmt, nil) == SQLITE_OK)
    precondition(sqlite3_step(stmt) == SQLITE_ROW)
    precondition(sqlite3_column_int(stmt, 0) == 4, "changed transient retry")
    precondition(String(cString: sqlite3_column_text(stmt, 1)) == "pending_upload")
    sqlite3_finalize(stmt)
    print("object budget SQLite: 5 assertions passed, 0 failed")
  }
}
Fixture().run()
`);
  execFileSync('swiftc', ['-module-cache-path', join(dir,'modules'), join(dir,'main.swift'), '-o', join(dir,'budget')], {timeout:60000});
  expect(execFileSync(join(dir,'budget'), [], {encoding:'utf8'})).toContain('5 assertions passed, 0 failed');
}, 90000);

nativeTest('only typed 403 object-budget refusals use the file-limit message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-budget-classifier-'));
  writeFileSync(join(dir, 'main.swift'), `import Foundation
let body = Data(#"{"error":"object_budget_exceeded"}"#.utf8)
precondition(AccountRefusalDetection.isObjectBudgetExceeded(statusCode: 403, body: body))
precondition(!AccountRefusalDetection.isObjectBudgetExceeded(statusCode: 500, body: body))
precondition(!AccountRefusalDetection.isObjectBudgetExceeded(statusCode: 403, body: Data(#"{"error":"forbidden","message":"object_budget_exceeded"}"#.utf8)))
precondition(!AccountRefusalDetection.isObjectBudgetExceeded(statusCode: 403, body: Data()))
print("budget classifier: 4 assertions passed, 0 failed")`);
  execFileSync('swiftc', ['-module-cache-path',join(dir,'modules'),join(ios,'AccountRefusalDetection.swift'),join(dir,'main.swift'),'-o',join(dir,'classifier')], {timeout:60000});
  expect(execFileSync(join(dir,'classifier'), [], {encoding:'utf8'})).toContain('4 assertions passed, 0 failed');
}, 90000);
