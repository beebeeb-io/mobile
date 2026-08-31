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
      // SDK 57's xcode lib returns null from getTarget(name) — use the target
      // object addTarget returns (it carries the uuid) instead.
      const widgetTarget = xcodeProject.addTarget('BeebeebWidget', 'app_extension', 'BeebeebWidget', 'io.beebeeb.app.widget')
      const group = xcodeProject.addPbxGroup(
        ['BeebeebWidget.swift'],
        'BeebeebWidget',
        'BeebeebWidget'
      )
      // Full project-relative path: SDK 57's xcode lib no longer resolves the
      // file through the group's path (build failed with 'ios/BeebeebWidget.swift not found').
      xcodeProject.addBuildPhase(['BeebeebWidget/BeebeebWidget.swift'], 'PBXSourcesBuildPhase', 'Sources', widgetTarget.uuid)

      // Explicit build settings: SDK 57's xcode lib no longer inherits a
      // usable SWIFT_VERSION into extension targets (build failed with
      // "SWIFT_VERSION '' is unsupported"). Mirrors the settings the widget
      // target carried in the committed project before the upgrade.
      const nativeTarget = widgetTarget.pbxNativeTarget || widgetTarget.target
      const configListUuid = nativeTarget && nativeTarget.buildConfigurationList
      const configList = configListUuid && xcodeProject.pbxXCConfigurationList()[configListUuid]
      const configSection = xcodeProject.pbxXCBuildConfigurationSection()
      for (const ref of (configList && configList.buildConfigurations) || []) {
        const cfgEntry = configSection[ref.value]
        if (!cfgEntry || !cfgEntry.buildSettings) continue
        const isDebug = /debug/i.test(cfgEntry.name || '')
        Object.assign(cfgEntry.buildSettings, {
          ALWAYS_SEARCH_USER_PATHS: 'NO',
          APPLICATION_EXTENSION_API_ONLY: 'YES',
          CLANG_ENABLE_MODULES: 'YES',
          CODE_SIGN_ENTITLEMENTS: 'BeebeebWidget/BeebeebWidget.entitlements',
          CURRENT_PROJECT_VERSION: 1,
          DEVELOPMENT_TEAM: 'R8352WDJJR',
          INFOPLIST_FILE: 'BeebeebWidget/Info.plist',
          IPHONEOS_DEPLOYMENT_TARGET: '16.0',
          LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
          MARKETING_VERSION: '1.0.0',
          OTHER_SWIFT_FLAGS: isDebug ? '"$(inherited) -D EXPO_CONFIGURATION_DEBUG"' : '"$(inherited) -D EXPO_CONFIGURATION_RELEASE"',
          PRODUCT_BUNDLE_IDENTIFIER: 'io.beebeeb.app.widget',
          PRODUCT_NAME: '"$(TARGET_NAME)"',
          SKIP_INSTALL: 'YES',
          SWIFT_OPTIMIZATION_LEVEL: isDebug ? '"-Onone"' : '"-O"',
          SWIFT_VERSION: '5.0',
          TARGETED_DEVICE_FAMILY: '"1,2"',
        })
      }
    }
    return cfg
  })
  return config
}

module.exports = withWidget
