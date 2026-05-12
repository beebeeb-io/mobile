const { withXcodeProject, withEntitlementsPlist } = require('@expo/config-plugins')
const path = require('path')
const fs = require('fs')

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
    if (!xcodeProject.pbxGroupByName('BeebeebWidget')) {
      xcodeProject.addTarget('BeebeebWidget', 'app_extension', 'BeebeebWidget', 'io.beebeeb.app.widget')
      const group = xcodeProject.addPbxGroup(
        ['BeebeebWidget.swift'],
        'BeebeebWidget',
        'BeebeebWidget'
      )
      xcodeProject.addBuildPhase(['BeebeebWidget.swift'], 'PBXSourcesBuildPhase', 'Sources', xcodeProject.getTarget('BeebeebWidget').uuid)
    }
    return cfg
  })
  return config
}

module.exports = withWidget
