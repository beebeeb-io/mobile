// Config plugin for beebeeb-crypto.
//
// Phase 1 (current): registers the module; xcframework not yet linked.
// Phase 2: once repos/core/build-ios.sh produces BeebeebCore.xcframework,
//   this plugin will use withXcodeProject to embed it in the iOS target and
//   set SWIFT_VERSION = 5.0.
//
// Android: the .so files are bundled via the standard jniLibs mechanism;
//   no config-plugin changes needed there.

const { createRunOncePlugin } = require('@expo/config-plugins')

const withBeebeebCrypto = (config) => {
  // TODO (phase 2): withXcodeProject → embed BeebeebCore.xcframework
  return config
}

module.exports = createRunOncePlugin(withBeebeebCrypto, 'beebeeb-crypto', '1.0.0')
