// @ts-nocheck
/**
 * Task 1667 round 11 (review of mobile#182 at de23774e, finding 6, memory
 * safety).
 *
 * `sqlite3_bind_text(stmt, i, (s as NSString).utf8String, -1, nil)` passes a
 * pointer into a temporary bridged NSString with a nil destructor
 * (SQLITE_STATIC): SQLite keeps the raw pointer until `sqlite3_step`, and the
 * temporary can be released or reused before that. The chunk-callback
 * predicate (`upload_session_id = ?`, NativeBackupEngine) then compared
 * against garbage and `markChunkUploaded` updated 0 rows. Every text/blob
 * bind in the beebeeb-crypto native module must let SQLite copy the bytes:
 * `BackupManifestStore.bindText` (SQLITE_TRANSIENT) or an explicit
 * SQLITE_TRANSIENT destructor. This guard fails on any bind whose destructor
 * argument is `nil`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const IOS = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');

/** Every `sqlite3_bind_text(` / `sqlite3_bind_blob(` call: its arguments. */
export function bindCalls(src: string): Array<{ line: number; args: string[]; text: string }> {
  const out: Array<{ line: number; args: string[]; text: string }> = [];
  const re = /sqlite3_bind_(?:text|blob)(?:64)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const args: string[] = [];
    let current = '';
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') depth -= 1;
      if (depth === 0) break;
      if (c === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
      } else {
        current += c;
      }
    }
    args.push(current.trim());
    out.push({ line: src.slice(0, m.index).split('\n').length, args, text: src.slice(m.index, i + 1) });
  }
  return out;
}

/** Binds whose destructor is nil (SQLITE_STATIC). */
export function staticBinds(src: string): string[] {
  return bindCalls(src)
    .filter((c) => c.args.length >= 5 && c.args[c.args.length - 1] === 'nil')
    .map((c) => `line ${c.line}: ${c.text}`);
}

const files = readdirSync(IOS).filter((f) => f.endsWith('.swift'));

describe('round 11 finding 6: no SQLITE_STATIC text/blob bind in the native module', () => {
  test('every sqlite3_bind_text / sqlite3_bind_blob in modules/beebeeb-crypto/ios copies its bytes', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(join(IOS, f), 'utf8');
      checked += bindCalls(src).length;
      for (const o of staticBinds(src)) offenders.push(`${f} ${o}`);
    }
    expect(offenders).toEqual([]);
    // The guard read real binds (it is not vacuously green).
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  test('the engine and the legacy manager bind text through BackupManifestStore.bindText', () => {
    const engine = readFileSync(join(IOS, 'NativeBackupEngine.swift'), 'utf8');
    const legacy = readFileSync(join(IOS, 'PhotoBackupManager.swift'), 'utf8');
    // Round 15: clearStagedStateForRestage's binds moved into
    // BackupManifestStore.clearStagedForRestage (38 -> 36 in the engine).
    expect((engine.match(/BackupManifestStore\.bindText\(/g) ?? []).length).toBeGreaterThanOrEqual(36);
    expect((legacy.match(/BackupManifestStore\.bindText\(/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(engine).not.toMatch(/\.utf8String, -1, nil\)/);
    expect(legacy).not.toMatch(/\.utf8String, -1, nil\)/);
    const store = readFileSync(join(IOS, 'BackupManifestStore.swift'), 'utf8');
    expect(store).toMatch(/private static let transient = unsafeBitCast\(-1, to: sqlite3_destructor_type\.self\)/);
    expect(store).toMatch(/static func bindText\(_ stmt: OpaquePointer\?, _ index: Int32, _ value: String\) \{\s*sqlite3_bind_text\(stmt, index, \(value as NSString\)\.utf8String, -1, transient\)/);
  });

  test('red-proof: the guard flags a nil-destructor bind (the de23774 shape) and passes a transient one', () => {
    const bad = 'sqlite3_bind_text(stmt, 4, (uploadSessionId as NSString).utf8String, -1, nil)\n';
    expect(staticBinds(bad).length).toBe(1);
    const blob = 'sqlite3_bind_blob(stmt, 1, (data as NSData).bytes, Int32(data.count), nil)\n';
    expect(staticBinds(blob).length).toBe(1);
    const ok = 'sqlite3_bind_text(stmt, 4, (uploadSessionId as NSString).utf8String, -1, transient)\n';
    expect(staticBinds(ok)).toEqual([]);
    const nested = 'sqlite3_bind_text(stmt, idx(of: [a, b]), f(x, y), -1, nil)\n';
    expect(staticBinds(nested).length).toBe(1);
  });
});
