/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'share',
  name: 'ShareExtension',
  bundleIdentifier: '.ShareExtension',
  deploymentTarget: '16.0',
  frameworks: [
    'UniformTypeIdentifiers',
    // BeebeebCore.xcframework is linked at the Xcode project level (ios/Beebeeb.xcodeproj)
    // rather than through this config, since the extension target is manually wired.
    // The xcframework lives at ios/BeebeebCore.xcframework/ (copied from repos/core/).
  ],
  entitlements: {
    'com.apple.security.application-groups': ['group.io.beebeeb.shared'],
    'keychain-access-groups': ['$(AppIdentifierPrefix)io.beebeeb.shared'],
  },
})
