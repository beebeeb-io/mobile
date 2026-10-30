// @ts-nocheck
/**
 * Task 1962 round 4/5 — Bug 6 guards (matrix 5, 7, 8).
 *
 * Bug 6: RN networking builds its session from `defaultSessionConfiguration`
 * on the first request, so it stores authenticated API responses in
 * `URLCache.shared` (the on-disk `Cache.db` a sim rung found holding the
 * previous account's ids). Native sessions on `.default` / `.shared` /
 * a background configuration do the same. The File Provider and Share
 * extensions are separate processes with their own `URLCache.shared` and
 * their own containers, unreachable from an app sign-out.
 *
 * Round 5: the legacy default store is cleared by ONE shared helper that
 * opens it with a NON-zero disk capacity (a 0-capacity instance never opens
 * the store, so `removeAllCachedResponses()` was a measured no-op). This file
 * reads the shipped sources off disk (no native module) and fails if any rule
 * is undone:
 *   6a  the app assigns a zero-capacity `URLCache.shared` at launch, before
 *       anything can read it, and clears the legacy default store OFF main.
 *   6b  `purgePlaintextStorage` clears `URLCache.shared` (belt).
 *   6c  both extension principal classes do the same through the shared
 *       helper, with their own dirs, and every extension
 *       `URLSessionConfiguration` sets `urlCache = nil`.
 *   6d  every `URLSessionConfiguration` in the FOUR scanned directories sets
 *       `urlCache = nil`; no `configuration: .default` session remains.
 *   7b  `PlaintextStorageProtection.swift` does not reference
 *       `ThumbnailQueueDB` (it is also compiled into the File Provider).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const NATIVE_DIR = join(ROOT, 'modules/beebeeb-crypto/ios');
const FILE_PROVIDER_DIR = join(ROOT, 'targets/file-provider');
const SHARE_DIR = join(ROOT, 'targets/share-extension');
const SHARE_COPY_DIR = join(ROOT, 'ios/BeebeebShare');

const SCANNED_DIRS = [NATIVE_DIR, FILE_PROVIDER_DIR, SHARE_DIR, SHARE_COPY_DIR];

const APP_DELEGATE = join(NATIVE_DIR, 'BeebeebAppDelegate.swift');
const CRYPTO_MODULE = join(NATIVE_DIR, 'BeebeebCryptoModule.swift');
const PLAINTEXT_PROTECTION = join(NATIVE_DIR, 'PlaintextStorageProtection.swift');
const SHARED_HELPER = join(NATIVE_DIR, 'LegacyURLCacheCleanup.swift');
const FILE_PROVIDER = join(FILE_PROVIDER_DIR, 'FileProviderExtension.swift');
const SHARE_VIEW = join(SHARE_DIR, 'ShareViewController.swift');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Every `.swift` file under the four shipped source trees. The row-7 guard
 *  scans directories, not a fixed file list, so a new session in a new file
 *  cannot slip past it. */
function swiftSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const dir of SCANNED_DIRS) {
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      if (!name.endsWith('.swift')) continue;
      const path = join(dir, name);
      out.push([relative(ROOT, path), read(path)]);
    }
  }
  return out;
}

const SOURCES = swiftSources();

function extractBody(source: string, signature: RegExp): string {
  const sigMatch = signature.exec(source);
  if (!sigMatch) throw new Error(`signature not found: ${signature}`);
  const openBraceIndex = source.indexOf('{', sigMatch.index + sigMatch[0].length);
  if (openBraceIndex === -1) throw new Error(`no opening brace after signature: ${signature}`);
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

function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/** Removes every `DispatchQueue.global(...).async { ... }` closure, leaving
 *  only the work that runs synchronously on the caller's thread. */
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

/** Every live `URLSessionConfiguration.<constructor>` occurrence in `source`
 *  must set `urlCache = nil` on the same variable within the following lines,
 *  before the next `URLSession(configuration:` use. Returns the violations. */
function configurationsWithoutNilCache(source: string): string[] {
  const lines = stripLineComments(source).split('\n');
  const problems: string[] = [];
  lines.forEach((line, index) => {
    const match = /(?:let|var)\s+(\w+)\s*=\s*URLSessionConfiguration\s*\.\s*(default|ephemeral|background)\b/.exec(line);
    if (!match) return;
    const variable = match[1];
    const window = lines.slice(index + 1, index + 12);
    const useIndex = window.findIndex((next) => next.includes('URLSession(configuration:'));
    const relevant = useIndex === -1 ? window : window.slice(0, useIndex + 1);
    const setsNil = relevant.some((next) =>
      new RegExp(`\\b${variable}\\s*\\.\\s*urlCache\\s*=\\s*nil\\b`).test(next),
    );
    if (!setsNil) problems.push(`${variable} (line ${index + 1})`);
  });
  return problems;
}

const appDelegateSource = read(APP_DELEGATE);
const didFinishLaunchingBody = extractBody(
  appDelegateSource,
  /func\s+application\(\s*_\s+application:\s*UIApplication,\s*didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool/,
);
const didFinishLaunchingLive = stripLineComments(didFinishLaunchingBody);
const sharedHelperLive = stripLineComments(read(SHARED_HELPER));

describe('6a + matrix 5: the app launch assigns a zero-capacity URLCache.shared and clears the legacy store off-main', () => {
  test('the launch handler assigns URLCache.shared through the shared helper', () => {
    expect(didFinishLaunchingLive).toMatch(
      /URLCache\s*\.\s*shared\s*=\s*LegacyURLCacheCleanup\s*\.\s*zeroCapacityURLCache\s*\(\s*directoryName:\s*"[^"]+"\s*\)/,
    );
    expect(didFinishLaunchingLive).toContain('LegacyURLCacheCleanup.clearLegacyDefaultStoreOffMainThread()');
  });

  test('it never reads the URLCache.shared getter before the assignment', () => {
    const firstMention = didFinishLaunchingLive.search(/\bURLCache\b/);
    expect(firstMention).toBeGreaterThanOrEqual(0);
    const assignment = didFinishLaunchingLive.search(/URLCache\s*\.\s*shared\s*=/);
    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(firstMention).toBeGreaterThanOrEqual(assignment);
  });

  test('the legacy default store is cleared off the main thread, never synchronously', () => {
    const synchronous = stripBackgroundQueueClosures(didFinishLaunchingLive);
    expect(synchronous).not.toContain('removeAllCachedResponses');
    // The helper itself does the hop; the launch body only calls it.
    expect(didFinishLaunchingLive).not.toContain('removeAllCachedResponses');
  });
});

describe('the shared helper actually opens the legacy store (non-zero disk capacity)', () => {
  test('the zero-capacity cache is 0/0 in an explicit Caches directory', () => {
    const helper = extractBody(read(SHARED_HELPER), /static func zeroCapacityURLCache\(directoryName: String\) -> URLCache/);
    const live = stripLineComments(helper);
    expect(live).toContain('URLCache(memoryCapacity: 0, diskCapacity: 0, directory: directory)');
    expect(live).toContain('cachesDirectory');
  });

  test('the legacy sweep uses a NON-zero disk capacity (a 0-capacity instance never opens the store)', () => {
    const sweep = extractBody(read(SHARED_HELPER), /static func clearLegacyDefaultStore\(directory: URL\? = nil\)/);
    const live = stripLineComments(sweep);
    expect(sharedHelperLive).toMatch(/static let legacyDiskCapacity = 50 \* 1024 \* 1024/);
    expect(live).toContain('diskCapacity: legacyDiskCapacity');
    expect(live).toContain('removeAllCachedResponses()');
    expect(live).not.toMatch(/diskCapacity:\s*0/);
  });

  test('the off-main entry point dispatches to a utility queue', () => {
    const entry = extractBody(read(SHARED_HELPER), /static func clearLegacyDefaultStoreOffMainThread\(\)/);
    expect(stripLineComments(entry)).toMatch(
      /DispatchQueue\s*\.\s*global\s*\(\s*qos:\s*\.\s*utility\s*\)\s*\.\s*async\s*\{[\s\S]*?clearLegacyDefaultStore\(\)/,
    );
  });

  test('no source defines its own zero-capacity helper (the round-4 3x copy is gone)', () => {
    const definers = SOURCES.filter(([, source]) =>
      /func\s+zeroCapacityURLCache\s*\(/.test(stripLineComments(source)),
    ).map(([name]) => name);
    expect(definers).toEqual(['modules/beebeeb-crypto/ios/LegacyURLCacheCleanup.swift']);
  });

  test('no shipped source clears the default store through a 0/0 instance', () => {
    const offenders = SOURCES.filter(([, source]) =>
      /diskCapacity:\s*0\s*,\s*directory:\s*nil/.test(stripLineComments(source)),
    ).map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

describe('6b: purgePlaintextStorage clears the shared cache (belt)', () => {
  const purgeBody = extractBody(read(CRYPTO_MODULE), /AsyncFunction\("purgePlaintextStorage"\)/);
  const live = stripLineComments(purgeBody);

  test('the purge calls URLCache.shared.removeAllCachedResponses()', () => {
    expect(live).toMatch(/URLCache\s*\.\s*shared\s*\.\s*removeAllCachedResponses\(\)/);
  });

  test('the call is synchronous (no queue hop wrapping it)', () => {
    expect(stripBackgroundQueueClosures(live)).toContain('URLCache.shared.removeAllCachedResponses()');
  });
});

describe('6c: both extension principal classes assign their own zero-capacity URLCache.shared', () => {
  const cases: Array<[string, string, string]> = [
    ['File Provider', FILE_PROVIDER, 'bb-no-http-cache-file-provider'],
    ['Share extension', SHARE_VIEW, 'bb-no-http-cache-share'],
  ];

  for (const [label, path, directory] of cases) {
    test(`${label} assigns URLCache.shared before its first request and clears the default store off-main`, () => {
      const live = stripLineComments(read(path));
      expect(live).toContain(
        `URLCache.shared = LegacyURLCacheCleanup.zeroCapacityURLCache(directoryName: "${directory}")`,
      );
      expect(live).toContain('LegacyURLCacheCleanup.clearLegacyDefaultStoreOffMainThread()');
      expect(live).not.toContain('removeAllCachedResponses');
    });
  }

  test('the Share extension keeps its prebuild copy byte-identical', () => {
    const canonical = read(join(SHARE_DIR, 'ShareViewController.swift'));
    const copy = read(join(SHARE_COPY_DIR, 'ShareViewController.swift'));
    expect(copy).toBe(canonical);
  });
});

describe('6c + 6d: every URLSessionConfiguration in the four source trees sets urlCache = nil', () => {
  test('the scan sees the shipped trees (guard is not blind)', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.some(([name]) => name.endsWith('BeebeebAppDelegate.swift'))).toBe(true);
    expect(SOURCES.some(([name]) => name.endsWith('FileProviderExtension.swift'))).toBe(true);
    expect(SOURCES.some(([name]) => name.endsWith('ShareViewController.swift'))).toBe(true);
  });

  for (const [name, source] of SOURCES) {
    test(`${name} has no configuration without urlCache = nil`, () => {
      expect(configurationsWithoutNilCache(source)).toEqual([]);
    });
  }

  test('no `URLSession(configuration: .default, ...)` remains in the four source trees', () => {
    const offenders = SOURCES.filter(([, source]) =>
      /configuration:\s*\.\s*default\b/.test(stripLineComments(source)),
    ).map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

describe('matrix 8 / 7b: PlaintextStorageProtection never references the thumbnail queue DB', () => {
  test('the extension-compiled file is free of ThumbnailQueueDB', () => {
    expect(read(PLAINTEXT_PROTECTION)).not.toContain('ThumbnailQueueDB');
  });
});
