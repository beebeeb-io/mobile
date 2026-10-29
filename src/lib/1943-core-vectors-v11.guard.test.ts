// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1943 mobile M1 — the vendored core vector bundle is v11 everywhere (spec §2, plan M1).
 *
 * The native KATs cannot run in this lane (the iOS one needs a simulator, the Android one an
 * emulator), so this is the runnable half of the vendoring: it pins the exact bytes of core
 * `c08defc7`'s `test-vectors/vectors.json` in both bundles, checks the version and every family's
 * row count, and proves no stale v10/v4 copy and no stale project reference survives.
 *
 * Refresh procedure (same contract as the KAT headers): copy core's file over both v11 copies,
 * re-pin `EXPECTED_SHA256`, update `EXPECTED_FAMILIES` if core added or changed a family.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

const IOS_VECTORS = 'targets/native-tests/Vectors/core-vectors.v11.json';
const ANDROID_VECTORS = 'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v11.json';
const STALE = [
  'targets/native-tests/Vectors/core-vectors.v10.json',
  'targets/native-tests/Vectors/core-vectors.v4.json',
  'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v10.json',
  'modules/beebeeb-crypto/android/src/androidTest/assets/core-vectors.v4.json',
];

/** `shasum -a 256` of core `c08defc7:test-vectors/vectors.json`. */
const EXPECTED_SHA256 = '11f7522056d0c12eff92d2f37a5fa6975ce460cf36899e3a6a92f3455a4d754a';
const EXPECTED_VERSION = 11;

/** Every family core ships at this revision, with the number of rows it carries. 31 rows in total. */
const EXPECTED_FAMILIES: Record<string, number> = {
  master_key_from_password: 1,
  file_key_derivation: 1,
  chunk_encrypt_decrypt: 1,
  x25519_identity_keypair: 1,
  x25519_share_key_exchange: 1,
  recovery_check: 1,
  envelope_serialization: 1,
  recovery_phrase_roundtrip: 1,
  metadata_encrypt_decrypt: 1,
  file_request_seal_open: 1,
  share_key_wrap: 1,
  thumbnail_encrypt: 1,
  chunk_v2_stream: 1,
  chunk_v2_single_frame: 1,
  metadata_v2_name: 1,
  metadata_v2_name_filekey: 1,
  metadata_v1_name_filekey: 1,
  folder_key_id: 1,
  shared_folder_index_key: 1,
  combine_folder_link_key: 1,
  key_wrap_v1: 1,
  folder_link_passphrase: 1,
  folder_link_passphrase_nfd: 1,
  folder_custody_v1: 1,
  link_owner_key_v1: 1,
  link_owner_token_v1: 1,
  folder_child_file_v1: 1,
  folder_child_folder_v1: 1,
  owner_wrapped_file_key: 1,
  owner_wrapped_folder_key: 1,
  folder_wrapped_file_key: 1,
};

describe('vendored core vectors are v11 (task 1943 M1)', () => {
  test('bothBundlesCarryTheV11VectorsByteForByte', () => {
    const ios = readFileSync(join(ROOT, IOS_VECTORS));
    const android = readFileSync(join(ROOT, ANDROID_VECTORS));
    expect(android.equals(ios)).toBe(true);
    expect(createHash('sha256').update(ios).digest('hex')).toBe(EXPECTED_SHA256);
    expect(createHash('sha256').update(android).digest('hex')).toBe(EXPECTED_SHA256);
  });

  test('theVendoredFileIsVersion11', () => {
    const root = JSON.parse(readFileSync(join(ROOT, IOS_VECTORS), 'utf8')) as {
      version: number;
      vectors: { name: string }[];
    };
    expect(root.version).toBe(EXPECTED_VERSION);
  });

  test('everyFamilyIsPresentWithItsRowCount', () => {
    const root = JSON.parse(readFileSync(join(ROOT, IOS_VECTORS), 'utf8')) as {
      vectors: { name: string }[];
    };
    const counts: Record<string, number> = {};
    for (const vector of root.vectors) counts[vector.name] = (counts[vector.name] ?? 0) + 1;
    expect(Object.keys(counts).sort()).toEqual(Object.keys(EXPECTED_FAMILIES).sort());
    for (const [family, rows] of Object.entries(EXPECTED_FAMILIES)) {
      expect({ family, rows: counts[family] }).toEqual({ family, rows });
    }
    expect(root.vectors.length).toBe(31);
  });

  test('noStaleVectorCopySurvives', () => {
    for (const path of STALE) expect({ path, exists: existsSync(join(ROOT, path)) }).toEqual({ path, exists: false });
  });

  test('theProjectAndThePrebuildPluginPointAtV11', () => {
    const pbxproj = readFileSync(join(ROOT, 'ios/Beebeeb.xcodeproj/project.pbxproj'), 'utf8');
    const plugin = readFileSync(join(ROOT, 'plugins/native-tests/withNativeTestTargets.js'), 'utf8');
    const prebuildGate = readFileSync(join(ROOT, 'scripts/check-prebuild-test-targets.sh'), 'utf8');
    for (const text of [pbxproj, plugin, prebuildGate]) {
      expect(text).toContain('core-vectors.v11.json');
      expect(text).not.toContain('core-vectors.v10.json');
      expect(text).not.toContain('core-vectors.v4.json');
    }
  });

  test('bothNativeKatsLoadTheV11FileAndPinItsSha', () => {
    for (const path of [
      'targets/native-tests/CoreVectorsKATTests.swift',
      'modules/beebeeb-crypto/android/src/androidTest/java/expo/modules/beebeebcrypto/CoreVectorsKATTest.kt',
    ]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source).toContain('core-vectors.v11');
      expect(source).toContain(EXPECTED_SHA256);
      expect(source).toContain('11');
      expect(source).not.toContain('core-vectors.v10');
      expect(source).not.toContain('core-vectors.v4');
    }
  });
});
