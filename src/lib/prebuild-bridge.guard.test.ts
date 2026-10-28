// @ts-nocheck
import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
