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

// ---------------------------------------------------------------------------
// Round 2 (ruling 6): the OTHER launch entry point. `handleEventsForBackgroundURLSession` also
// runs on the main thread in the launch window, and used to call `NativeBackupEngine.shared`
// synchronously (whose init() builds the background URLSession: the build-227 10 s stall).
// ---------------------------------------------------------------------------

/** Removes every `DispatchQueue.global(...).async { ... }` closure (brace-balanced) from `body`,
 *  leaving only what runs synchronously on the caller's (main) thread. A hop to
 *  `DispatchQueue.main`, a `Task { }` or `Task.detached { }` is NOT removed: those may run on
 *  (or inherit) the main actor, so they do not count as off-main. */
function stripBackgroundQueueClosures(body: string): string {
  const re = /DispatchQueue\s*\.\s*global\s*\([^)]*\)\s*\.\s*async(?:\s*\([^)]*\))?\s*\{/;
  let out = body;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < out.length; i += 1) {
      if (out[i] === '{') depth += 1;
      else if (out[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) throw new Error('unbalanced background closure');
    out = out.slice(0, m.index) + '/*bg*/' + out.slice(end + 1);
  }
  return out;
}

/** Violations of the launch rule for one delegate entry-point body. Empty = compliant. */
function launchViolations(body: string): string[] {
  const live = stripLineComments(body);
  const sync = stripBackgroundQueueClosures(live);
  const problems: string[] = [];
  if (/NativeBackupEngine\s*\.\s*shared\b/.test(sync)) problems.push('synchronous NativeBackupEngine.shared on the delegate thread');
  if (/reattachBackgroundSessionForPendingEvents\s*\(/.test(sync)) problems.push('engine construction helper called synchronously (not inside DispatchQueue.global(...).async)');
  return problems;
}

describe('BeebeebAppDelegate.application(_:handleEventsForBackgroundURLSession:) never constructs the engine on the main thread', () => {
  const handleBody = extractBody(
    appDelegateSource,
    /func\s+application\(\s*_\s+application:\s*UIApplication,\s*handleEventsForBackgroundURLSession[^)]*\)/,
  );
  const live = stripLineComments(handleBody);

  test('the extractor found the right function (sanity)', () => {
    expect(live).toContain('bgSessionIdentifier');
    expect(live).toContain('completionHandler');
  });

  test('no synchronous NativeBackupEngine.shared / engine construction in it', () => {
    expect(launchViolations(handleBody)).toEqual([]);
  });

  test('the engine IS constructed (off-main) and the completion handler is stashed FIRST, on the calling thread', () => {
    const stash = live.search(/NativeBackupEngine\s*\.\s*stashBackgroundSessionCompletionHandler\s*\(\s*completionHandler\s*\)/);
    const hop = live.search(/DispatchQueue\s*\.\s*global\s*\(/);
    const construct = live.search(/reattachBackgroundSessionForPendingEvents\s*\(/);
    expect(stash).toBeGreaterThanOrEqual(0);
    expect(hop).toBeGreaterThan(stash); // stash strictly before the background hop
    expect(construct).toBeGreaterThan(hop); // construction only after (inside) the hop
    // and the stash itself is not inside the background closure
    expect(stripBackgroundQueueClosures(live)).toContain('stashBackgroundSessionCompletionHandler');
  });

  test('the old instance-method call (handleBackgroundSessionEvents on .shared) is gone', () => {
    expect(live).not.toMatch(/handleBackgroundSessionEvents/);
  });

  // In-test mutations: every way of putting the construction back on the main thread must be red.
  const mutations: Array<[string, (b: string) => string]> = [
    ['restore the original synchronous .shared call', (b) => b.replace(/NativeBackupEngine\s*\.\s*stashBackgroundSessionCompletionHandler\s*\(\s*completionHandler\s*\)/, 'NativeBackupEngine.shared.handleBackgroundSessionEvents(identifier: identifier, completionHandler: completionHandler)')],
    ['call the construction helper synchronously, before the hop', (b) => b.replace(/(NativeBackupEngine\s*\.\s*stashBackgroundSessionCompletionHandler[^\n]*\n)/, '$1    NativeBackupEngine.reattachBackgroundSessionForPendingEvents()\n')],
    ['touch .shared synchronously after the hop', (b) => b.replace(/(DispatchQueue\s*\.\s*global[\s\S]*?\n    \}\n)/, '$1    _ = NativeBackupEngine.shared\n')],
    ['hop to the MAIN queue instead of a background one', (b) => b.replace(/DispatchQueue\s*\.\s*global\s*\([^)]*\)\s*\.\s*async/, 'DispatchQueue.main.async')],
  ];
  for (const [name, mutate] of mutations) {
    test(`RED under mutation: ${name}`, () => {
      const mutated = mutate(handleBody);
      expect(mutated).not.toBe(handleBody); // the mutation really changed something
      expect(launchViolations(mutated).length).toBeGreaterThan(0);
    });
  }
});

describe('the launch entry points compose correctly with the engine (both entry points, same rule)', () => {
  test('didFinishLaunching obeys the same launchViolations rule', () => {
    const body = extractBody(
      appDelegateSource,
      /func\s+application\(\s*_\s+application:\s*UIApplication,\s*didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool/,
    );
    expect(launchViolations(body)).toEqual([]);
    // the rule is live: adding a synchronous `.shared` makes it red
    expect(launchViolations(body + '\n    NativeBackupEngine.shared.registerBackgroundTask()\n').length).toBeGreaterThan(0);
  });

  test('stashBackgroundSessionCompletionHandler builds no engine (static, lock + assignment only)', () => {
    const body = stripLineComments(extractBody(backupEngineSource, /static func stashBackgroundSessionCompletionHandler\(/));
    expect(body).not.toMatch(/\bshared\b|\bself\b/);
    expect(body).toMatch(/pendingBackgroundSessionCompletionHandler\s*=\s*completionHandler/);
  });

  test('the stashed handler is completed from urlSessionDidFinishEvents on the MAIN queue', () => {
    const body = stripLineComments(extractBody(backupEngineSource, /func urlSessionDidFinishEvents\(forBackgroundURLSession session: URLSession\)/));
    expect(body).toMatch(/DispatchQueue\s*\.\s*main\s*\.\s*async[\s\S]*takeBackgroundSessionCompletionHandler\(\)\?\(\)/);
  });

  test('the background session is recreated by init() with the SAME identifier the delegate gates on (no event can be lost)', () => {
    const setup = stripLineComments(extractBody(backupEngineSource, /private func setupBackgroundSession\(\)/));
    expect(setup).toContain('URLSessionConfiguration.background(withIdentifier: Self.bgSessionIdentifier)');
    expect(setup).toMatch(/delegate:\s*self/);
    const init = stripLineComments(extractBody(backupEngineSource, /private override init\(\)/));
    expect(init).toContain('setupBackgroundSession()');
  });
});
