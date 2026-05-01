const { withXcodeProject, withEntitlementsPlist, withInfoPlist, IOSConfig } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const EXTENSION_NAME = 'BeebeebFileProvider';
const EXTENSION_BUNDLE_ID = 'io.beebeeb.app.file-provider';
const APP_GROUP = 'group.io.beebeeb.shared';

function withFileProvider(config) {
  // Step 1: Add extension entitlements
  config = withEntitlementsPlist(config, (config) => {
    // Main app entitlements — ensure App Group is set
    config.modResults['com.apple.security.application-groups'] = [APP_GROUP];
    config.modResults['keychain-access-groups'] = [
      '$(AppIdentifierPrefix)io.beebeeb.shared',
    ];
    return config;
  });

  // Step 2: Add NSExtension key to Info.plist for the main app
  config = withInfoPlist(config, (config) => {
    config.modResults.NSFileProviderPresenceAuthorized = true;
    return config;
  });

  // Step 3: Add the extension target to the Xcode project
  config = withXcodeProject(config, async (config) => {
    const project = config.modResults;
    const targetName = EXTENSION_NAME;
    const bundleId = EXTENSION_BUNDLE_ID;

    // Check if target already exists
    const existingTarget = project.pbxTargetByName(targetName);
    if (existingTarget) {
      console.log(`[FileProvider] Target '${targetName}' already exists, skipping`);
      return config;
    }

    const srcDir = path.join(__dirname);
    const iosDir = path.join(config.modRequest.platformProjectRoot);
    const extDir = path.join(iosDir, targetName);

    // Create extension directory
    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
    }

    // Copy Swift source files
    const swiftFiles = [
      'BeebeebFileProvider.swift',
      'FileProviderItem.swift',
      'FileProviderEnumerator.swift',
      'FileProviderCrypto.swift',
      'FileProviderAPIClient.swift',
    ];

    for (const file of swiftFiles) {
      const src = path.join(srcDir, file);
      const dst = path.join(extDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    // Copy the UniFFI Swift bindings into the extension
    const uniffiBindings = path.resolve(
      __dirname,
      '../../../../core/beebeeb-uniffi/bindings/beebeeb_uniffi.swift'
    );
    if (fs.existsSync(uniffiBindings)) {
      fs.copyFileSync(uniffiBindings, path.join(extDir, 'beebeeb_uniffi.swift'));
    }

    // Create Info.plist for the extension
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
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
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionFileProviderDocumentGroup</key>
    <string>${APP_GROUP}</string>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.fileprovider-nonui</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).FileProviderExtension</string>
  </dict>
</dict>
</plist>`;
    fs.writeFileSync(path.join(extDir, 'Info.plist'), infoPlist);

    // Create entitlements for the extension
    const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${APP_GROUP}</string>
  </array>
  <key>keychain-access-groups</key>
  <array>
    <string>$(AppIdentifierPrefix)io.beebeeb.shared</string>
  </array>
</dict>
</plist>`;
    fs.writeFileSync(path.join(extDir, `${targetName}.entitlements`), entitlements);

    console.log(`[FileProvider] Extension files copied to ${extDir}`);
    console.log(`[FileProvider] NOTE: You must manually add the '${targetName}' target in Xcode:`);
    console.log(`  1. File > New > Target > File Provider Extension`);
    console.log(`  2. Name: ${targetName}, Bundle ID: ${bundleId}`);
    console.log(`  3. Replace generated files with the ones in ios/${targetName}/`);
    console.log(`  4. Link BeebeebCore.xcframework to the extension target`);
    console.log(`  5. Add App Group capability: ${APP_GROUP}`);

    return config;
  });

  return config;
}

module.exports = withFileProvider;
