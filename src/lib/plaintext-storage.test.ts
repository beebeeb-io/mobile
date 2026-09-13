// @ts-nocheck
/**
 * Pre-mortem 12 / task 0300 — proves the backup-exclusion registry stays
 * complete.
 *
 * Three independent assertions:
 *  1. Every `${FileSystem.documentDirectory}<leaf>` path constructed anywhere
 *     under `src/` resolves to a leaf name that is in `PROTECTED_LEAF_NAMES`.
 *  2. Every Swift file under `modules/beebeeb-crypto/ios/` OR
 *     `targets/file-provider/` (the separate `BeebeebFileProvider.appex`
 *     target — see PlaintextStorageProtection.swift's header comment) that
 *     references `.documentDirectory`, `.applicationSupportDirectory`, or
 *     `containerURL(forSecurityApplicationGroupIdentifier:` is in
 *     `REVIEWED_NATIVE_SOURCES`.
 *  3. `PROTECTED_LEAF_NAMES` and the Swift registry agree, so the TS mirror
 *     cannot drift from the code that actually applies the exclusion.
 *
 * This file reads source text off disk and imports no native module, so it
 * needs no `mock.module` calls (see mobile/CLAUDE.md "Tests" — isolation means
 * every file mocks what it needs; this one needs nothing).
 */
import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// `./plaintext-storage` imports `react-native` (for `Platform`) and the
// generated crypto-module bridge (for `hardenPlaintextStorage` /
// `auditPlaintextStorage`). Per the isolated-runner rule (mobile/CLAUDE.md
// "Tests"), this file mocks both itself rather than relying on another test
// file's registration — `react-native`'s real `index.js` uses Flow syntax
// bun's parser rejects outright if it is ever actually loaded. A `mock.module`
// call only affects imports that resolve AFTER it runs, and static `import`
// statements are hoisted above all other statements regardless of source
// order — so `./plaintext-storage` must be loaded via a dynamic `await
// import(...)` below the mocks, not a static import (same pattern as
// `software-vault-gate.test.ts`).
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
}));

const { PROTECTED_LEAF_NAMES, REVIEWED_NATIVE_SOURCES } = await import('./plaintext-storage');

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const NATIVE_DIR = join(REPO_ROOT, 'modules', 'beebeeb-crypto', 'ios');
// The File Provider extension (`BeebeebFileProvider.appex`) is a SEPARATE
// compiled target from the one `modules/beebeeb-crypto/ios/` builds into
// (`ios/Beebeeb.xcodeproj/project.pbxproj:95`), and it writes decrypted
// content to its own App Group subdirectories (`Constants.swift:75-86`).
// It must be walked too, or a second writer target hides from this guard
// exactly the way it did before this spec.
const NATIVE_DIRS = [NATIVE_DIR, join(REPO_ROOT, 'targets', 'file-provider')];
const REGISTRY_SWIFT = join(NATIVE_DIR, 'PlaintextStorageProtection.swift');

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match.test(entry)) out.push(full);
  }
  return out;
}

/** `${FileSystem.documentDirectory}foo/` and `${FileSystem.documentDirectory ?? ''}foo.json`. */
const DOC_PATH_RE = /\$\{FileSystem\.documentDirectory(?:\s*\?\?\s*'')?\}([A-Za-z0-9_.\-]+)/g;

describe('plaintext storage registry', () => {
  test('every documentDirectory path built in src/ is registered', () => {
    const unregistered: string[] = [];
    for (const file of walk(SRC_DIR, /\.tsx?$/)) {
      if (file.endsWith('plaintext-storage.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(DOC_PATH_RE)) {
        const leaf = match[1];
        // `${documentDirectory}${THUMB_CACHE_DIR_NAME}/` interpolates a const —
        // the literal capture is empty and is covered by the Swift registry.
        if (!leaf) continue;
        if (!(PROTECTED_LEAF_NAMES as readonly string[]).includes(leaf)) {
          unregistered.push(`${file.replace(REPO_ROOT + '/', '')}: ${leaf}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  test('every native source touching a backed-up container has been reviewed', () => {
    // Matches Documents/Application Support access AND App Group container
    // access (`containerURL(forSecurityApplicationGroupIdentifier:`) — the
    // latter is how `targets/file-provider/Constants.swift` reaches its App
    // Group `pinned`/`temp` directories without ever writing the literal
    // string `.documentDirectory`, which is exactly why the narrower,
    // single-directory-word version of this regex missed it originally.
    const BACKED_UP_CONTAINER_RE =
      /\.documentDirectory|\.applicationSupportDirectory|containerURL\(forSecurityApplicationGroupIdentifier/;
    const unreviewed: string[] = [];
    for (const nativeDir of NATIVE_DIRS) {
      for (const file of walk(nativeDir, /\.swift$/)) {
        const text = readFileSync(file, 'utf8');
        if (!BACKED_UP_CONTAINER_RE.test(text)) continue;
        const name = file.split('/').pop()!;
        if (!(REVIEWED_NATIVE_SOURCES as readonly string[]).includes(name)) {
          unreviewed.push(name);
        }
      }
    }
    expect(unreviewed).toEqual([]);
  });

  test('the TS mirror matches the Swift registry entry-for-entry', () => {
    const swift = readFileSync(REGISTRY_SWIFT, 'utf8');
    const swiftLeaves = [...swift.matchAll(/appendingPathComponent\("([^"]+)"/g)]
      .map((m) => m[1])
      .filter((leaf) => leaf !== 'beebeeb-plaintext-audit.json');
    expect([...new Set(swiftLeaves)].sort()).toEqual([...PROTECTED_LEAF_NAMES].sort());
  });
});
