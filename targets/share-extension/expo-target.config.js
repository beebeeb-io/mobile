/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'share',
  name: 'ShareExtension',
  bundleIdentifier: '.ShareExtension',
  deploymentTarget: '16.0',
  frameworks: [
    'UniformTypeIdentifiers',
  ],
  entitlements: {
    'com.apple.security.application-groups': ['group.io.beebeeb.shared'],
    'keychain-access-groups': ['$(AppIdentifierPrefix)io.beebeeb.shared'],
  },
  // BeebeebCore.xcframework linked here in Phase 2 once repos/core/build-ios.sh
  // produces the framework bundle.
})
