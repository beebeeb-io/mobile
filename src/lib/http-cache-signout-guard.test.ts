// @ts-nocheck
/**
 * Task 1962 round 4 — Bug 6 guards (matrix 5, 7, 8).
 *
 * Bug 6: RN networking builds its session from `defaultSessionConfiguration`
 * on the first request, so it stores authenticated API responses in
 * `URLCache.shared` (the on-disk `Cache.db` a sim rung found holding the
 * previous account's ids). Native sessions on `.default` / `.shared` /
 * a background configuration do the same. The File Provider and Share
 * extensions are separate processes with their own `URLCache.shared` and
 * their own containers, unreachable from an app sign-out.
 *
 * This file reads the shipped sources off disk (no native module) and fails
 * if any of those rules is undone:
 *   6a  the app assigns a zero-capacity `URLCache.shared` at launch, before
 *       anything can read it, and clears the legacy default store OFF main.
 *   6b  `purgePlaintextStorage` clears `URLCache.shared` (belt).
 *   6c  both extension principal classes do the same, with their own dirs,
 *       and every extension `URLSessionConfiguration` sets `urlCache = nil`.
 *   6d  every `URLSessionConfiguration` the app builds sets `urlCache = nil`;
 *       no `configuration: .default` session remains.
 *   7b  `PlaintextStorageProtection.swift` does not reference
 *       `ThumbnailQueueDB` (it is also compiled into the File Provider).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const NATIVE_DIR = join(ROOT, 'modules/beebeeb-crypto/ios');
const FILE_PROVIDER_DIR = join(ROOT, 'targets/file-provider');
const SHARE_DIR = join(ROOT, 'targets/share-extension');
const SHARE_COPY_DIR = join(ROOT, 'ios/BeebeebShare');

const APP_DELEGATE = join(NATIVE_DIR, 'BeebeebAppDelegate.swift');
const CRYPTO_MODULE = join(NATIVE_DIR, 'BeebeebCryptoModule.swift');
const PLAINTEXT_PROTECTION = join(NATIVE_DIR, 'PlaintextStorageProtection.swift');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

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

describe('6a + matrix 5: the app launch assigns a zero-capacity URLCache.shared and clears the legacy store off-main', () => {
  test('the launch handler assigns URLCache.shared a 0/0 cache in an explicit Caches directory', () => {
    expect(didFinishLaunchingLive).toMatch(
      /URLCache\s*\.\s*shared\s*=\s*Self\s*\.\s*zeroCapacityURLCache\s*\(\s*directoryName:\s*"[^"]+"\s*\)/,
    );
    const helper = extractBody(appDelegateSource, /static func zeroCapacityURLCache\(directoryName: String\) -> URLCache/);
    expect(stripLineComments(helper)).toContain('URLCache(memoryCapacity: 0, diskCapacity: 0, directory: directory)');
    expect(stripLineComments(helper)).toContain('cachesDirectory');
  });

  test('it never reads the URLCache.shared getter before the assignment', () => {
    // First non-comment mention of `URLCache` must be the assignment itself.
    const firstMention = didFinishLaunchingLive.search(/\bURLCache\b/);
    expect(firstMention).toBeGreaterThanOrEqual(0);
    const assignment = didFinishLaunchingLive.search(/URLCache\s*\.\s*shared\s*=/);
    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(firstMention).toBeGreaterThanOrEqual(assignment);
  });

  test('the legacy default store is cleared on a utility background queue, never on the main thread', () => {
    const synchronous = stripBackgroundQueueClosures(didFinishLaunchingLive);
    expect(synchronous).not.toContain('removeAllCachedResponses');
    expect(didFinishLaunchingLive).toMatch(
      /DispatchQueue\s*\.\s*global\s*\(\s*qos:\s*\.\s*utility\s*\)\s*\.\s*async\s*\{[\s\S]*?URLCache\(memoryCapacity: 0, diskCapacity: 0, directory: nil\)\s*\.\s*removeAllCachedResponses\(\)/,
    );
  });
});

describe('6b: purgePlaintextStorage clears the shared cache (belt)', () => {
  const purgeBody = extractBody(read(CRYPTO_MODULE), /AsyncFunction\("purgePlaintextStorage"\)/);
  const live = stripLineComments(purgeBody);

  test('the purge calls URLCache.shared.removeAllCachedResponses()', () => {
    expect(live).toMatch(/URLCache\s*\.\s*shared\s*\.\s*removeAllCachedResponses\(\)/);
  });

  test('the call is synchronous (no queue hop wrapping it)', () => {
    // The reminder survives while the surrounding `DispatchQueue...async`
    // closures (none should contain it) are stripped.
    expect(stripBackgroundQueueClosures(live)).toContain('URLCache.shared.removeAllCachedResponses()');
  });
});

describe('6c: both extension principal classes assign their own zero-capacity URLCache.shared', () => {
  const cases: Array<[string, string]> = [
    ['File Provider', join(FILE_PROVIDER_DIR, 'FileProviderExtension.swift')],
    ['Share extension', join(SHARE_DIR, 'ShareViewController.swift')],
  ];

  for (const [label, path] of cases) {
    test(`${label} assigns URLCache.shared before its first request and clears the default store off-main`, () => {
      const source = read(path);
      expect(source).toMatch(
        /URLCache\s*\.\s*shared\s*=\s*Self\s*\.\s*zeroCapacityURLCache\(\)/,
      );
      const helper = extractBody(source, /private static func zeroCapacityURLCache\(\) -> URLCache/);
      const liveHelper = stripLineComments(helper);
      expect(liveHelper).toContain('URLCache(memoryCapacity: 0, diskCapacity: 0, directory: directory)');
      expect(liveHelper).toMatch(/bb-no-http-cache-/);
      const liveSource = stripLineComments(source);
      expect(liveSource).toMatch(
        /DispatchQueue\s*\.\s*global\s*\(\s*qos:\s*\.\s*utility\s*\)\s*\.\s*async\s*\{[\s\S]*?URLCache\(memoryCapacity: 0, diskCapacity: 0, directory: nil\)\s*\.\s*removeAllCachedResponses\(\)/,
      );
    });
  }

  test('the Share extension keeps its prebuild copy byte-identical', () => {
    const canonical = read(join(SHARE_DIR, 'ShareViewController.swift'));
    const copy = read(join(SHARE_COPY_DIR, 'ShareViewController.swift'));
    expect(copy).toBe(canonical);
  });
});

describe('6c + 6d: every URLSessionConfiguration in the app and both extensions sets urlCache = nil', () => {
  const sources: Array<[string, string]> = [
    ['BeebeebCryptoModule.swift', join(NATIVE_DIR, 'BeebeebCryptoModule.swift')],
    ['NativeBackupEngine.swift', join(NATIVE_DIR, 'NativeBackupEngine.swift')],
    ['NativeManualUploader.swift', join(NATIVE_DIR, 'NativeManualUploader.swift')],
    ['ApiClient.swift', join(FILE_PROVIDER_DIR, 'ApiClient.swift')],
  ];

  for (const [name, path] of sources) {
    test(`${name} has no configuration without urlCache = nil`, () => {
      expect(configurationsWithoutNilCache(read(path))).toEqual([]);
    });
  }

  test('no `URLSession(configuration: .default, ...)` remains in the app or the extensions', () => {
    const offenders: string[] = [];
    for (const [name, path] of sources) {
      if (/configuration:\s*\.\s*default\b/.test(stripLineComments(read(path)))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test('every extension source file is scanned (guard is not blind)', () => {
    // The share extension builds no configuration of its own today; its two
    // URLSession.shared call sites are covered by the zero-capacity shared
    // cache above. If one is ever added, the scan list above must grow.
    const shareSources = ['ShareUploader.swift', 'FolderFetcher.swift', 'ShareViewController.swift'];
    for (const name of shareSources) {
      const source = stripLineComments(read(join(SHARE_DIR, name)));
      expect(source).not.toMatch(/(?:let|var)\s+\w+\s*=\s*URLSessionConfiguration\s*\./);
    }
  });
});

describe('matrix 8 / 7b: PlaintextStorageProtection never references the thumbnail queue DB', () => {
  test('the extension-compiled file is free of ThumbnailQueueDB', () => {
    expect(read(PLAINTEXT_PROTECTION)).not.toContain('ThumbnailQueueDB');
  });
});
