/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'file-provider',
  name: 'BeebeebFileProvider',
  displayName: 'Beebeeb',
  bundleIdentifier: '.FileProvider',
  deploymentTarget: '16.0',
  frameworks: [
    'FileProvider',
    'UniformTypeIdentifiers',
    'LocalAuthentication',
  ],
  entitlements: {
    'com.apple.security.application-groups': ['group.io.beebeeb.shared'],
    'keychain-access-groups': ['$(AppIdentifierPrefix)io.beebeeb.shared'],
  },
})
