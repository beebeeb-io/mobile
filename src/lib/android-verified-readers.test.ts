// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 D15 — the Android readers that task 1943 M7 verifies are frozen by name and by
 * content (workspace lead ruling, 2026-10-30; plan "Amendment 2026-10-30 (2)").
 *
 * `scripts/android-release-guard.sh` lets an Android build through only at the pinned
 * `ANDROID_VERIFIED_CORE_REV`. The binding at that revision already exports the pin-aware readers,
 * so a PR can change how Android decrypts content WITHOUT bumping CORE_REV. This test closes that:
 * while the pin is a real revision, every frozen file must equal its recorded sha256 in
 * `scripts/android-verified-readers.sha256`. A PR that changes one of them must set the pin to
 * `unverified` in the same commit (every Android build is then refused until the M7 PR verifies
 * the readers, records the new hashes and sets a real revision).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/android-release-guard.sh');
const MANIFEST = join(ROOT, 'scripts/android-verified-readers.sha256');

/** The Android files whose behaviour M7 verifies, frozen by name. */
const FROZEN = [
  'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt',
  'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt',
  'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/VideoChunkMath.kt',
  'modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/VideoStreamer.kt',
  'modules/beebeeb-crypto/android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt',
].sort();

function pin(): string {
  const m = readFileSync(SCRIPT, 'utf8').match(/^ANDROID_VERIFIED_CORE_REV=([0-9a-f]{40}|unverified)$/m);
  if (!m) throw new Error('scripts/android-release-guard.sh has no ANDROID_VERIFIED_CORE_REV line');
  return m[1];
}

/** `sha256  path` lines, as `shasum -a 256` writes them. */
function manifest(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-f]{64}) {2}(\S+)$/);
    if (!m) throw new Error(`malformed manifest line: ${line}`);
    entries.set(m[2], m[1]);
  }
  return entries;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');

describe('Android readers verified by task 1943 M7 (D15)', () => {
  test('the manifest lists exactly the frozen reader files', () => {
    expect([...manifest().keys()].sort()).toEqual(FROZEN);
  });

  test('while the pin is a real revision, every frozen reader equals its verified hash', () => {
    if (pin() === 'unverified') {
      console.log('android-verified-readers: pin is `unverified`; Android builds are refused until M7');
      return;
    }
    const recorded = manifest();
    const changed = FROZEN.filter((path) => sha256(path) !== recorded.get(path));
    expect({
      changed,
      fix:
        changed.length === 0
          ? 'none'
          : 'set ANDROID_VERIFIED_CORE_REV=unverified in scripts/android-release-guard.sh in this commit (task 1943 M7 re-verifies)',
    }).toEqual({ changed: [], fix: 'none' });
  });
});
