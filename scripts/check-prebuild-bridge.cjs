#!/usr/bin/env node
// Exercise the prebuild plugin's real copy mod in a disposable project. This
// runs on Linux and in pre-commit without generating or modifying ios/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE = 'modules/beebeeb-crypto/ios/BeebeebCryptoBridge.swift';
const TEMPLATE = 'plugins/uniffi-bridge/BeebeebCryptoBridge.swift';

async function checkPrebuildBridge(root) {
  const before = fs.readFileSync(path.join(root, BRIDGE));
  if (before.length === 0) throw new Error(`${BRIDGE} is empty`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuild-bridge-'));
  try {
    // ../../core must also resolve INSIDE the scratch tree, never to a real core checkout.
    const projectRoot = path.join(scratch, 'projects/mobile');
    const iosDir = path.join(projectRoot, 'ios');
    const bridge = path.join(projectRoot, BRIDGE);
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.mkdirSync(iosDir, { recursive: true });
    fs.writeFileSync(bridge, before);
    if (fs.existsSync(path.join(root, TEMPLATE))) {
      fs.mkdirSync(path.dirname(path.join(projectRoot, TEMPLATE)), { recursive: true });
      fs.copyFileSync(path.join(root, TEMPLATE), path.join(projectRoot, TEMPLATE));
    }
    const plugin = require(path.join(root, 'plugins/uniffi-bridge/withUniffiBridge.js'));
    const config = plugin({ name: 'bridge-guard', slug: 'bridge-guard' });
    if (typeof config.mods?.ios?.dangerous !== 'function') {
      throw new Error('UniFFI prebuild copy mod was not registered');
    }
    await config.mods.ios.dangerous({
      ...config,
      modRequest: { projectRoot, platformProjectRoot: iosDir, platform: 'ios' },
      modResults: {},
    });
    if (!before.equals(fs.readFileSync(bridge))) {
      throw new Error(`${BRIDGE} differs from the module copy after the prebuild copy mod`);
    }
    console.log('prebuild bridge: 1 compared, 0 changed');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { checkPrebuildBridge };
if (require.main === module) {
  checkPrebuildBridge(path.resolve(__dirname, '..')).catch((error) => {
    console.error(`prebuild bridge: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
