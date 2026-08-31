const { withXcodeProject, withEntitlementsPlist } = require('@expo/config-plugins')
const path = require('path')
const fs = require('fs')
const { ensureExtensionTarget } = require('./lib/extension-target')

const withWidget = (config) => {
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.security.application-groups'] = [
      ...(cfg.modResults['com.apple.security.application-groups'] || []),
      'group.io.beebeeb.shared',
    ].filter((v, i, a) => a.indexOf(v) === i)
    return cfg
  })
  config = withXcodeProject(config, async (cfg) => {
    const xcodeProject = cfg.modResults
    const widgetDir = path.join(cfg.modRequest.projectRoot, 'ios', 'BeebeebWidget')
    if (!fs.existsSync(widgetDir)) {
      fs.mkdirSync(widgetDir, { recursive: true })
    }
    fs.writeFileSync(path.join(widgetDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Beebeeb</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>`)
    fs.writeFileSync(path.join(widgetDir, 'BeebeebWidget.entitlements'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>group.io.beebeeb.shared</string>
  </array>
</dict>
</plist>`)
    // Wire the target through the shared helper (task 1305): xcode-lib's
    // addTarget() only dropped the .appex into a "Copy Files" entry and never
    // created the app→widget PBXTargetDependency, so EAS's target resolver did
    // not see io.beebeeb.app.widget, assigned it no provisioning profile, and
    // the AppStore archive failed with "Embedded binary is not signed with the
    // same certificate as the parent app". ensureExtensionTarget() adds the
    // dependency + "Embed App Extensions" entry + per-target build files and
    // the same build settings the hand-wired target carried before SDK 57.
    ensureExtensionTarget(xcodeProject, {
      name: 'BeebeebWidget',
      bundleId: 'io.beebeeb.app.widget',
      teamId: 'R8352WDJJR',
      sources: [{ path: 'BeebeebWidget/BeebeebWidget.swift', name: 'BeebeebWidget.swift' }],
      includeUniffiBindings: false,
      linkRustFramework: false,
      deploymentTarget: '16.0',
    })
    return cfg
  })
  return config
}

module.exports = withWidget
