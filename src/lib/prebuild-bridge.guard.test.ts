// @ts-nocheck
import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPrebuildBridge } from '../../scripts/check-prebuild-bridge.cjs';

const ROOT = join(import.meta.dir, '../..');
const BRIDGE = 'modules/beebeeb-crypto/ios/BeebeebCryptoBridge.swift';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'prebuild-bridge-test-'));
  try {
    cpSync(join(ROOT, 'plugins'), join(root, 'plugins'), { recursive: true });
    mkdirSync(join(root, 'modules/beebeeb-crypto/ios'), { recursive: true });
    cpSync(join(ROOT, BRIDGE), join(root, BRIDGE));
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('prebuild copy mod preserves the canonical module bridge byte for byte', async () => {
  await checkPrebuildBridge(ROOT);
});

test('guard rejects a stale template writer without touching the real module', async () => {
  const before = readFileSync(join(ROOT, BRIDGE));
  await fixture(async (root) => {
    const pluginPath = join(root, 'plugins/uniffi-bridge/withUniffiBridge.js');
    // Reintroduce the old copy direction in a throwaway plugin only.
    writeFileSync(join(root, 'plugins/uniffi-bridge/BeebeebCryptoBridge.swift'), '// stale template\n');
    writeFileSync(pluginPath, readFileSync(pluginPath, 'utf8') + `
const originalPlugin = module.exports;
module.exports = (config) => withDangerousMod(originalPlugin(config), ['ios', async (config) => {
  const root = config.modRequest.projectRoot;
  fs.copyFileSync(path.join(root, 'plugins/uniffi-bridge/BeebeebCryptoBridge.swift'), path.join(root, '${BRIDGE}'));
  return config;
}]);
`);
    await expect(checkPrebuildBridge(root)).rejects.toThrow('differs from the module copy');
  });
  expect(readFileSync(join(ROOT, BRIDGE)).equals(before)).toBe(true);
});

test('guard fails closed when the canonical module is missing or empty', async () => {
  await fixture(async (root) => {
    writeFileSync(join(root, BRIDGE), '');
    await expect(checkPrebuildBridge(root)).rejects.toThrow('is empty');
    rmSync(join(root, BRIDGE));
    await expect(checkPrebuildBridge(root)).rejects.toThrow('ENOENT');
  });
});

test('guard refuses a plugin that no longer exercises its copy mod', async () => {
  await fixture(async (root) => {
    writeFileSync(join(root, 'plugins/uniffi-bridge/withUniffiBridge.js'), 'module.exports = config => config;\n');
    await expect(checkPrebuildBridge(root)).rejects.toThrow('copy mod was not registered');
  });
});

test('share plugin refuses a missing canonical controller instead of using a fallback', async () => {
  await fixture(async (root) => {
    cpSync(join(ROOT, 'targets/share-extension'), join(root, 'targets/share-extension'), { recursive: true });
    mkdirSync(join(root, 'ios'), { recursive: true });
    rmSync(join(root, 'targets/share-extension/ShareViewController.swift'));
    writeFileSync(join(root, 'plugins/share-extension/ShareViewController.swift'), '// stale fallback\n');
    const plugin = require(join(root, 'plugins/share-extension/withShareExtension.js'));
    const config = plugin({ name: 'share-guard', slug: 'share-guard' });
    await expect(config.mods.ios.xcodeproj({
      ...config,
      modRequest: { projectRoot: root, platformProjectRoot: join(root, 'ios'), platform: 'ios' },
      modResults: {},
    })).rejects.toThrow(/ENOENT.*ShareViewController/);
  });
});

test('pre-commit installation is isolated, idempotent and preserves earlier hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prebuild-hook-test-'));
  try {
    mkdirSync(join(root, '.githooks'));
    cpSync(join(ROOT, '.githooks/pre-commit'), join(root, '.githooks/pre-commit'));
    mkdirSync(join(root, 'scripts'));
    cpSync(join(ROOT, 'scripts/install-prebuild-guard.sh'), join(root, 'scripts/install-prebuild-guard.sh'));
    const run = (args) => {
      const result = Bun.spawnSync(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    run(['git', 'init', '-q']);
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf previous >> hook-ran\n', { mode: 0o755 });
    writeFileSync(join(root, '.git/hooks/pre-push'), '#!/bin/sh\nprintf pushed >> push-hook-ran\n', { mode: 0o755 });
    run(['bash', 'scripts/install-prebuild-guard.sh']);
    const previous = run(['git', 'config', '--get', 'prebuildguard.previousHooksPath']);
    run(['bash', 'scripts/install-prebuild-guard.sh']);
    expect(run(['git', 'config', '--get', 'prebuildguard.previousHooksPath'])).toBe(previous);
    const hooks = resolve(root, run(['git', 'config', '--worktree', '--get', 'core.hooksPath']));
    expect(existsSync(join(hooks, 'pre-push'))).toBe(true);
    run(['bash', join(hooks, 'pre-push')]);
    expect(readFileSync(join(root, 'push-hook-ran'), 'utf8')).toBe('pushed');
    // A stand-in only for the final command, so this verifies hook execution/exit propagation.
    writeFileSync(join(root, 'scripts/check-prebuild-bridge.cjs'), 'process.exit(23);\n');
    const hook = Bun.spawnSync(['bash', '.githooks/pre-commit'], { cwd: root });
    expect(hook.exitCode).toBe(23);
    expect(readFileSync(join(root, 'hook-ran'), 'utf8')).toBe('previous');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
