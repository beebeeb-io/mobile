const { withXcodeProject, withInfoPlist } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const EXTENSION_NAME = 'BeebeebShare';
const EXTENSION_BUNDLE_ID = 'io.beebeeb.app.share';
const APP_GROUP = 'group.io.beebeeb.shared';
// Keychain access group shared between the main app and the Share Extension.
// `$(AppIdentifierPrefix)` is a build-time placeholder Xcode expands to the
// team ID + "." prefix. `SharedKeychain.swift` hardcodes the resolved value
// ("R8352WDJJR.io.beebeeb.shared") so the literal string here must match the
// canonical declaration in `targets/share-extension/expo-target.config.js`.
// (task 0444 — without this entry, `expo prebuild --clean` regenerated the
// entitlements file without keychain-access-groups, silently wiping the
// 0433 fix and breaking `SharedKeychain.loadMasterKey()` on every fresh build.)
const KEYCHAIN_ACCESS_GROUP = '$(AppIdentifierPrefix)io.beebeeb.shared';
const PRINCIPAL_CLASS = 'ShareViewController';

const SOURCE_FILES = [
  'ShareViewController.swift',
  'BeebeebCryptoShim.swift',
  'ShareUploader.swift',
  'SharedKeychain.swift',
  'FolderFetcher.swift',
];

function withShareExtension(config) {
  // Step 1: ensure the main-app Info.plist tells iOS the share UI looks
  // good in dark mode (the extension uses system colors).
  config = withInfoPlist(config, (config) => {
    return config;
  });

  // Step 2: drop source files + Info.plist + entitlements next to the main
  // app target, and stitch the extension target into the .xcodeproj.
  config = withXcodeProject(config, async (config) => {
    const project = config.modResults;
    const targetName = EXTENSION_NAME;

    const projectRoot = config.modRequest.projectRoot;
    const iosDir = config.modRequest.platformProjectRoot;
    const extDir = path.join(iosDir, targetName);
    // Source files live in targets/share-extension/ (source of truth)
    // with fallback to plugins/share-extension/ for ShareViewController.swift
    const srcDir = path.resolve(projectRoot, 'targets/share-extension');
    const pluginSrcDir = path.resolve(projectRoot, 'plugins/share-extension');

    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
    }

    for (const file of SOURCE_FILES) {
      // Check targets/share-extension/ first, then plugins/share-extension/
      let src = path.join(srcDir, file);
      if (!fs.existsSync(src)) {
        src = path.join(pluginSrcDir, file);
      }
      const dst = path.join(extDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    // Activation rule: accept images, movies, file URLs, web URLs, text,
    // and arbitrary data. The Info.plist below is what iOS reads to decide
    // whether to show Beebeeb in the share sheet.
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
  <string>${EXTENSION_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict>
      <key>NSExtensionActivationRule</key>
      <dict>
        <key>NSExtensionActivationSupportsImageWithMaxCount</key>
        <integer>20</integer>
        <key>NSExtensionActivationSupportsMovieWithMaxCount</key>
        <integer>5</integer>
        <key>NSExtensionActivationSupportsFileWithMaxCount</key>
        <integer>20</integer>
        <key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
        <integer>1</integer>
        <key>NSExtensionActivationSupportsText</key>
        <true/>
      </dict>
    </dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).${PRINCIPAL_CLASS}</string>
  </dict>
</dict>
</plist>`;
    fs.writeFileSync(path.join(extDir, 'Info.plist'), infoPlist);

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
    <string>${KEYCHAIN_ACCESS_GROUP}</string>
  </array>
</dict>
</plist>`;
    fs.writeFileSync(path.join(extDir, `${targetName}.entitlements`), entitlements);

    // Skip the Xcode-target stitching if it's already wired up (e.g. on a
    // subsequent prebuild). The full target wire-up below is best-effort:
    // the extension target lives in the .xcodeproj and is preserved across
    // prebuilds via the Pods/Podfile flow, so we only need to (re)copy
    // sources unless the target is missing entirely.
    if (project.pbxTargetByName(targetName)) {
      console.log(`[ShareExtension] Target '${targetName}' already exists — refreshed source files only`);
      return config;
    }

    console.log(`[ShareExtension] Files staged in ${extDir}`);
    console.log(`[ShareExtension] First-time setup: add the target in Xcode:`);
    console.log(`  1. File > New > Target > Share Extension`);
    console.log(`  2. Product Name: ${targetName}, Bundle ID: ${EXTENSION_BUNDLE_ID}`);
    console.log(`  3. Replace generated files with the ones in ios/${targetName}/`);
    console.log(`  4. Add App Group capability: ${APP_GROUP}`);
    console.log(`  5. Set the deployment target to match the main app`);

    return config;
  });

  return config;
}

module.exports = withShareExtension;
