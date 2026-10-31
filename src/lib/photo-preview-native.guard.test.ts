// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..', '..', 'modules', 'beebeeb-crypto', 'ios');
const swift = readFileSync(join(root, 'BeebeebCryptoModule.swift'), 'utf8');
const encoderSwift = readFileSync(join(root, 'PhotoPreviewEncoder.swift'), 'utf8');

function body(name: string): string {
  const start = swift.indexOf(`AsyncFunction("${name}")`);
  expect(start).toBeGreaterThan(-1);
  const next = swift.indexOf('\n    AsyncFunction(', start + 10);
  return swift.slice(start, next === -1 ? undefined : next);
}

function helperBody(name: string): string {
  const start = swift.indexOf(`func ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = swift.indexOf('\n}\n', start);
  return swift.slice(start, end);
}

describe('photo preview native upload/download', () => {
  const up = () => body('uploadPhotoPreviewNative') + helperBody('photoPreviewEncryptAndPut');
  const down = () => body('downloadPhotoPreviewNative');

  test('upload derives the file key, encrypts, applies provenance headers and caps at 8 MiB', () => {
    const b = up();
    expect(b).toContain('deriveFileKey');
    expect(b).toContain('encryptChunk');
    expect(b).toContain('ProvenanceHeaders.apply');
    expect(b).toContain('Bearer');
    expect(b).toContain('/thumbnail/preview?format=');
    expect(swift).toContain('photoPreviewMaxEncryptedBytes = 8 * 1024 * 1024');
    expect(b).toContain('wire.count <= photoPreviewMaxEncryptedBytes');
    expect(b).toContain('PhotoPreviewEncoder.encodeFittingCap');
    expect(b).toContain('validatePhotoPreviewPx');
  });

  test('download derives the file key, decrypts and reports typed errors', () => {
    const b = down();
    expect(b).toContain('deriveFileKey');
    expect(b).toContain('decryptChunk');
    expect(b).toContain('ProvenanceHeaders.apply');
    expect(b).toContain('preview_missing');
    expect(b).toContain('preview_corrupt');
    expect(b).toContain('X-Preview-Format');
    expect(b).toContain('X-Preview-Px');
  });

  test('download rejects an oversized body before decrypting', () => {
    const b = down();
    const cap = b.indexOf('photoPreviewMaxEncryptedBytes + 28');
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(b.indexOf('decryptChunk'));
  });

  test('download only writes under beebeeb-previews-v1', () => {
    expect(down()).toContain('photoPreviewCachePath(destPath)');
    const at = swift.indexOf('func photoPreviewCachePath');
    expect(at).toBeGreaterThan(-1);
    expect(swift.slice(at, at + 1500)).toContain('beebeeb-previews-v1');
    // the only plaintext write in the download is to the validated destination
    expect(down()).toContain('plaintext.write(to: dest');
  });

  test('neither function touches system temp directories', () => {
    for (const b of [up(), down()]) {
      expect(b).not.toContain('NSTemporaryDirectory');
      expect(b).not.toContain('temporaryDirectory');
    }
    const helper = swift.slice(swift.indexOf('func photoPreviewCachePath'), swift.indexOf('func photoPreviewCachePath') + 1500);
    expect(helper).not.toContain('NSTemporaryDirectory');
    expect(helper).not.toContain('temporaryDirectory');
  });
});

describe('photo preview engine hook', () => {
  const engine = readFileSync(join(root, 'NativeBackupEngine.swift'), 'utf8');
  const hookAt = engine.indexOf('PhotoPreviewAfterUpload.run');
  const thumbFn = engine.slice(engine.indexOf('private func generateAndUploadThumbnail('));

  test('the hook runs after the thumbnail work, for images, only when the setting is enabled', () => {
    expect(hookAt).toBeGreaterThan(-1);
    expect(engine.split('PhotoPreviewAfterUpload.run').length).toBe(2);
    const before = engine.slice(Math.max(0, hookAt - 900), hookAt);
    expect(before).toContain('PhotoPreviewSettingStore.current(forAccount: accountId) != nil');
    expect(before).toContain('!isVideoAsset');
    expect(hookAt).toBeGreaterThan(engine.indexOf('Thumbnail generation failed'));
  });

  test('a preview failure cannot fail the upload: detached task, do/catch, nothing thrown or retried', () => {
    expect(thumbFn.indexOf('Task.detached')).toBeGreaterThan(-1);
    expect(thumbFn.indexOf('Task.detached')).toBeLessThan(thumbFn.indexOf('PhotoPreviewAfterUpload.run'));
    const near = thumbFn.slice(thumbFn.indexOf('PhotoPreviewSettingStore.current(forAccount:'), thumbFn.indexOf('PhotoPreviewAfterUpload.run') + 700);
    expect(near).toContain('do {');
    expect(near).toContain('} catch {');
    const helper = swift.slice(swift.indexOf('enum PhotoPreviewAfterUpload'));
    const run = helper.slice(0, helper.indexOf('\n}\n'));
    expect(run).toContain('} catch {');
    expect(run).not.toContain('throw ');
    expect(run).toContain(') async {');
  });

  test('the hook touches neither the manifest nor engine locks', () => {
    const hook = thumbFn.slice(thumbFn.indexOf('PhotoPreviewSettingStore.current(forAccount:'), thumbFn.indexOf('PhotoPreviewAfterUpload.run') + 500);
    for (const forbidden of ['dbQueue', 'markUploadComplete', 'admitsWrite', 'ticket', '.lock(', 'withLock']) {
      expect(hook).not.toContain(forbidden);
    }
    const helper = swift.slice(swift.indexOf('enum PhotoPreviewAfterUpload'), swift.indexOf('func photoPreviewCachePath'));
    for (const forbidden of ['dbQueue', 'exsqlite3', 'sqlite3_', 'NativeBackupEngine']) {
      expect(helper).not.toContain(forbidden);
    }
  });

  test('the setting is mirrored into the app UserDefaults, not the App Group', () => {
    const store = encoderSwift.slice(encoderSwift.indexOf('enum PhotoPreviewSettingStore'));
    expect(store).toContain('UserDefaults = .standard');
    expect(store).not.toContain('suiteName');
    expect(swift).toContain('Function("setPhotoPreviewSetting")');
  });
});

describe('photo preview setting is account-scoped', () => {
  const engine = readFileSync(join(root, 'NativeBackupEngine.swift'), 'utf8');
  const cleanup = readFileSync(join(import.meta.dir, 'account-cleanup.ts'), 'utf8');
  const bridge = readFileSync(join(import.meta.dir, '..', '..', 'modules', 'beebeeb-crypto', 'src', 'BeebeebCrypto.ts'), 'utf8');

  test('the store keeps the owning account and only answers for it', () => {
    const store = encoderSwift.slice(encoderSwift.indexOf('enum PhotoPreviewSettingStore'));
    expect(store).toContain('static let accountKey = "io.beebeeb.photoPreview.accountId"');
    expect(store).toContain('func current(forAccount accountId: String');
    expect(store).toContain('defaults.string(forKey: accountKey) == accountId');
    expect(store).toContain('!accountId.isEmpty');
    // No unscoped reader is left anywhere.
    for (const src of [swift, engine, encoderSwift]) expect(src).not.toContain('PhotoPreviewSettingStore.current()');
  });

  test('the engine hook and the after-upload helper check the batch account', () => {
    const helper = swift.slice(swift.indexOf('enum PhotoPreviewAfterUpload'), swift.indexOf('func photoPreviewCachePath'));
    expect(helper).toContain('PhotoPreviewSettingStore.current(forAccount: accountId)');
    const hookAt = engine.indexOf('PhotoPreviewAfterUpload.run');
    expect(engine.slice(hookAt, hookAt + 400)).toContain('accountId: accountId');
  });

  test('the native sign-out purge and the JS purge both clear the mirrored setting', () => {
    const purge = swift.slice(swift.indexOf('AsyncFunction("purgePlaintextStorage")'));
    expect(purge.slice(0, 4000)).toContain('PhotoPreviewSettingStore.clear()');
    expect(encoderSwift).toContain('for key in [enabledKey, formatKey, pxKey, accountKey] { defaults.removeObject(forKey: key) }');
    expect(swift).toContain('Function("clearPhotoPreviewSetting")');
    const sweep = cleanup.slice(cleanup.indexOf('async function sweepDecryptedCaches'));
    expect(sweep.slice(0, 600)).toContain('clearPhotoPreviewSetting?.()');
    expect(bridge).toContain("BeebeebCryptoModule.setPhotoPreviewSetting(enabled, format, px, accountId ?? '')");
  });

  test('preview PUTs name the expected user and retry once at a lower quality', () => {
    const put = helperBody('photoPreviewEncryptAndPut');
    expect(put).toContain('X-Beebeeb-Expected-User');
    expect(swift.slice(swift.indexOf('enum PhotoPreviewAfterUpload'))).toContain('expectedUser: accountId');
    expect(body('uploadPhotoPreviewNative')).toContain('expectedUser: expectedUser');
    expect(body('uploadPhotoPreviewNative')).toContain('PhotoPreviewEncoder.encodeFittingCap');
    expect(swift.slice(swift.indexOf('enum PhotoPreviewAfterUpload'))).toContain('PhotoPreviewEncoder.encodeFittingCap');
  });
});

// Task 260 (P2-1) — the compare view's samples are plaintext copies of a library
// photo, written under Caches/beebeeb-previews-v1/samples/ after a PhotoKit fetch
// that may wait on an iCloud download. Without a plaintext lease such an encode can
// land its write AFTER sign-out's purge swept that directory, and nothing waits for
// it. Both native calls therefore have exactly one entry point — the gated wrapper —
// and this guard fails if a sample write becomes reachable outside a lease.
describe('compare samples are written under a plaintext lease', () => {
  const SRC = join(import.meta.dir, '..');
  const GATED_WRAPPER = 'lib/photo-compare-samples.ts';
  // The generated bridge module (the pass-through the wrapper calls) is not a writer.
  const BRIDGE = join('..', 'modules', 'beebeeb-crypto', 'src', 'BeebeebCrypto.ts');
  const NATIVE_CALL_RE = /\b(?:encodePhotoPreviewSample|originalPhotoForCompare)\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
    });
  }

  function nativeSampleCallSites(): string[] {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (NATIVE_CALL_RE.test(line)) found.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    const bridgePath = join(SRC, BRIDGE);
    readFileSync(bridgePath, 'utf8').split('\n').forEach((line, i) => {
      if (NATIVE_CALL_RE.test(line)) found.push(`${BRIDGE}:${i + 1}`);
    });
    return found;
  }

  test('the scan finds the native calls through the gated wrapper (a scan that matches nothing proves nothing)', () => {
    const sites = nativeSampleCallSites();
    expect(sites.some((s) => s.startsWith(`${GATED_WRAPPER}:`))).toBe(true);
  });

  test('every call site is the gated wrapper or the bridge definition — no screen calls the native encode', () => {
    const offenders = nativeSampleCallSites()
      .filter((s) => !s.startsWith(`${GATED_WRAPPER}:`) && !s.startsWith(`${BRIDGE}:`));
    expect(offenders).toEqual([]);
  });

  test('the wrapper leases the whole async span and discards a sample that lands after the purge', () => {
    const src = readFileSync(join(SRC, GATED_WRAPPER), 'utf8');
    expect(src).toMatch(/from '\.\/plaintext-gate'/);
    // Both entries, each under its own lease.
    expect((src.match(/withPlaintextLease\(/g) ?? []).length).toBe(2);
    for (const fn of ['encodePreviewSample', 'originalForCompare']) {
      const start = src.indexOf(`export function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}', start));
      expect(body).toMatch(/withPlaintextLease\(/);
      expect(body).toMatch(/encodeUnderLease\(/);
    }
    // Validity checked BEFORE and AFTER the native call, and a late write deleted.
    const helper = src.slice(src.indexOf('async function encodeUnderLease'));
    const helperBody = helper.slice(0, helper.indexOf('\n}\n'));
    expect(helperBody.indexOf('lease.assertValid()')).toBeGreaterThan(-1);
    expect(helperBody.indexOf('lease.assertValid()')).toBeLessThan(helperBody.indexOf('await encode()'));
    expect(helperBody).toContain('!lease.valid');
    expect(helperBody).toContain('discardSample(result.path)');
    expect(helperBody).toContain('throw new PlaintextGateClosedError');
    // The discard only ever touches the samples folder.
    const discard = src.slice(src.indexOf('async function discardSample'), src.indexOf('async function encodeUnderLease'));
    expect(discard).toContain('SAMPLES_DIR_MARK');
    expect(discard).toContain('idempotent: true');
  });

  test('both native sample writers still write only inside the Caches samples folder', () => {
    for (const name of ['encodePhotoPreviewSample', 'originalPhotoForCompare']) {
      const b = body(name);
      expect(b).toContain('photoPreviewSamplesDirectory()');
      expect(b).toContain('options: .atomic');
      expect(b).not.toContain('NSTemporaryDirectory');
    }
  });
});
