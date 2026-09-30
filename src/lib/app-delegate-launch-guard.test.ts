// @ts-nocheck
/**
 * Task 1669 Issue 2 — background-launch watchdog guard.
 *
 * Build 227 was SIGKILLed by the 10s scene-create watchdog because
 * `BeebeebAppDelegate.application(_:didFinishLaunchingWithOptions:)` (a
 * `ExpoAppDelegateSubscriber`, called synchronously from `AppDelegate` ->
 * `super.application(...)` on the main thread) touched
 * `NativeBackupEngine.shared` for the first time via
 * `registerBackgroundTask()`. Merely REFERENCING `.shared` forced Swift's
 * lazy singleton to run `NativeBackupEngine`'s full `init()` — which built a
 * background `URLSession` (an ObjC one-time `+initialize` / XPC handshake
 * with nsurlsessiond that stalled for the full 10s budget on a locked,
 * backgrounded relaunch), reconciled orphaned background tasks, set up a
 * metadata session, and opened the on-disk SQLite database — ALL
 * synchronously, ALL on the same main thread, before `didFinishLaunching`
 * could return. Full symbolicated evidence + fix rationale:
 * `modules/beebeeb-crypto/ios/NativeBackupEngine.swift`'s
 * `registerBackgroundTaskEarly()` doc comment.
 *
 * This file reads the Swift source directly off disk (no native module, no
 * mock.module needed — same pattern as plaintext-storage.test.ts) and fails
 * if blocking/singleton-constructing work is reintroduced onto the launch
 * path it guards.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NATIVE_DIR = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const APP_DELEGATE_SWIFT = join(NATIVE_DIR, 'BeebeebAppDelegate.swift');
const BACKUP_ENGINE_SWIFT = join(NATIVE_DIR, 'NativeBackupEngine.swift');

/**
 * Extracts a Swift function/initializer body (the text between its opening
 * and matching closing brace) by counting braces from the first `{` after
 * `signature`. Good enough for this file's functions: none of them contain
 * an unbalanced `{`/`}` inside a string literal or comment.
 */
function extractBody(source: string, signature: RegExp): string {
  const sigMatch = signature.exec(source);
  if (!sigMatch) {
    throw new Error(`signature not found: ${signature}`);
  }
  const openBraceIndex = source.indexOf('{', sigMatch.index + sigMatch[0].length);
  if (openBraceIndex === -1) {
    throw new Error(`no opening brace found after signature: ${signature}`);
  }
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error(`unbalanced braces after signature: ${signature}`);
}

/** Strips line comments (two slashes) so assertions check live code, not doc
 *  comments that (legitimately) mention the very symbol the test forbids.
 *  None of the functions this file inspects put a two-slash sequence inside
 *  a string literal or a block comment, so a per-line strip is exact enough
 *  here. */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const appDelegateSource = readFileSync(APP_DELEGATE_SWIFT, 'utf8');
const backupEngineSource = readFileSync(BACKUP_ENGINE_SWIFT, 'utf8');

describe('BeebeebAppDelegate.application(_:didFinishLaunchingWithOptions:) never touches the NativeBackupEngine singleton', () => {
  const didFinishLaunchingBody = extractBody(
    appDelegateSource,
    /func\s+application\(\s*_\s+application:\s*UIApplication,\s*didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool/,
  );

  test('the launch handler exists and does real work (sanity: the extractor found the right function)', () => {
    expect(didFinishLaunchingBody).toContain('PlaintextStorageProtection.hardenAll()');
    expect(didFinishLaunchingBody).toContain('return true');
  });

  test('it does not reference NativeBackupEngine.shared', () => {
    // Referencing `.shared` here is exactly what forced the singleton's
    // full, blocking `init()` onto the main thread during launch (build 227).
    // Doc comments are stripped first — they legitimately name the symbol
    // this test forbids in LIVE code.
    expect(stripLineComments(didFinishLaunchingBody)).not.toContain('NativeBackupEngine.shared');
  });

  test('it registers the BG task through the static, singleton-free entry point', () => {
    expect(didFinishLaunchingBody).toContain('NativeBackupEngine.registerBackgroundTaskEarly()');
  });
});

describe('NativeBackupEngine.registerBackgroundTaskEarly is static and does not construct the singleton', () => {
  test('it is declared static', () => {
    expect(backupEngineSource).toMatch(/static func registerBackgroundTaskEarly\(\)/);
  });

  const body = extractBody(backupEngineSource, /static func registerBackgroundTaskEarly\(\)/);

  test('its synchronous body (before any BGTaskScheduler callback closure runs) does not touch .shared', () => {
    // The closure passed to `BGTaskScheduler.shared.register` only runs
    // later, when iOS actually invokes the background task — well off the
    // launch path this guard protects, so `.shared` inside THAT closure is
    // fine. Assert only the synchronous setup a `register` call needs.
    const closureStart = body.indexOf('{ task in');
    const registrationSetup = closureStart === -1 ? body : body.slice(0, closureStart);
    // `BGTaskScheduler.shared` is Apple's own, unrelated singleton (cheap,
    // no I/O) — only `NativeBackupEngine.shared` is the forbidden one.
    expect(registrationSetup).not.toContain('NativeBackupEngine.shared');
  });
});

describe('NativeBackupEngine.init() keeps the proven-slow / non-essential work off whatever thread first constructs .shared', () => {
  const initBody = extractBody(backupEngineSource, /private override init\(\)/);
  const live = stripLineComments(initBody);

  test('opening the database is enqueued (dbQueue.async), never a blocking dbQueue.sync inside init()', () => {
    // `dbQueue.sync { openDatabase() }` directly in `init()` is what part of
    // the 10s block was spent in whenever `.shared` got constructed on the
    // main thread. The ORDERING half of this invariant (the enqueue must be a
    // direct statement of init(), not hidden inside another queue's closure)
    // lives in native-backup-engine-db-queue.test.ts, which drives the
    // structural audit.
    expect(live).not.toMatch(/dbQueue\s*\.\s*sync/);
    expect(live).toMatch(/dbQueue\s*\.\s*async\s*\{[^}]*openDatabase\(\)/);
  });

  test('init() introduces no second queue: no DispatchQueue(...) / Task { } hop before openDatabase is enqueued', () => {
    // The WIP that preceded this hopped through a `deferred-init` queue and
    // enqueued openDatabase from INSIDE it, so a caller's first
    // `dbQueue.sync` could run before openDatabase was even enqueued.
    expect(live).not.toMatch(/DispatchQueue\s*\(/);
    expect(live).not.toMatch(/\bTask\s*(\.detached)?\s*\{/);
  });

  test('setupBackgroundSession() still runs synchronously (iOS must be able to deliver background-session events as soon as it is reattached)', () => {
    expect(live).toContain('setupBackgroundSession()');
    // ...and it must come before the dbQueue enqueue, at init's top level.
    expect(live.indexOf('setupBackgroundSession()')).toBeLessThan(live.search(/dbQueue\s*\.\s*async/));
  });
});
