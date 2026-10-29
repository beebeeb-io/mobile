// @ts-nocheck -- bun runs this; `bun:test` types are not in the Expo tsconfig.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task 1562: the native XCTest targets compile the SAME vendored UniFFI
// bindings the app does (`ios/Beebeeb/beebeeb_uniffi.swift`), so
// plugins/native-tests/withNativeTestTargets.js creates a PBXFileReference for
// that path. Expo runs config-plugin mods in REVERSE registration order, so a
// plugin listed LATER runs FIRST. If the native-tests plugin runs before
// plugins/uniffi-bridge/withUniffiBridge.js, `project.hasFile()` is already
// true when the bridge wiring runs, so the bridge skips `addSourceFile()` —
// the reference never lands in the app's "Beebeeb" navigator group and
// normalizeUniffiGroup() (plugins/lib/extension-target.js) throws
// "UniFFI app navigator group is missing", aborting `expo prebuild --clean`
// before a single target is written. Observed 2026-10-29 on this branch:
// scripts/check-prebuild-test-targets.sh exited 1 with that exact error.
const ROOT = join(import.meta.dir, '..', '..');
const BRIDGE = './plugins/uniffi-bridge/withUniffiBridge.js';
const NATIVE_TESTS = './plugins/native-tests/withNativeTestTargets.js';

describe('app.json config-plugin order', () => {
  const plugins: string[] = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo.plugins;

  it('registers both the UniFFI bridge and the native test targets', () => {
    expect(plugins).toContain(BRIDGE);
    expect(plugins).toContain(NATIVE_TESTS);
  });

  it('runs the UniFFI bridge before the native test targets (reverse registration order)', () => {
    // Later index = earlier execution. The bridge must own the shared
    // beebeeb_uniffi.swift reference and its navigator-group membership.
    expect(plugins.indexOf(NATIVE_TESTS)).toBeLessThan(plugins.indexOf(BRIDGE));
  });
});
