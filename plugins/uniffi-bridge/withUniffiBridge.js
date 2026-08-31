const { withXcodeProject, withDangerousMod } = require('@expo/config-plugins');
const { linkRustFramework } = require('../lib/extension-target');
const path = require('path');
const fs = require('fs');

const FRAMEWORK_NAME = 'BeebeebCore.xcframework';
const BINDINGS_NAME = 'beebeeb_uniffi.swift';
const BRIDGE_NAME = 'BeebeebCryptoBridge.swift';
const TARGET_NAME = 'Beebeeb';
const POD_TAG = '@beebeeb-uniffi-bridge';

function copyDirRecursive(src, dst) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true });
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

function copyFileIfChanged(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const withCopyArtifacts = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const iosDir = config.modRequest.platformProjectRoot;

      const coreDir = path.resolve(projectRoot, '../../core');
      const xcframeworkSrc = path.join(coreDir, FRAMEWORK_NAME);
      const bindingsSrc = path.join(coreDir, 'beebeeb-uniffi/bindings', BINDINGS_NAME);
      const bridgeSrc = path.resolve(projectRoot, 'plugins/uniffi-bridge', BRIDGE_NAME);

      const xcframeworkDst = path.join(iosDir, FRAMEWORK_NAME);
      const mainAppSwiftDir = path.join(iosDir, TARGET_NAME);
      const cryptoModuleIosDir = path.join(projectRoot, 'modules/beebeeb-crypto/ios');

      if (!fs.existsSync(xcframeworkSrc)) {
        console.warn(
          `[uniffi-bridge] WARNING: ${xcframeworkSrc} not found — run repos/core/build-ios.sh to produce it`,
        );
      } else {
        if (fs.existsSync(xcframeworkDst)) {
          fs.rmSync(xcframeworkDst, { recursive: true, force: true });
        }
        copyDirRecursive(xcframeworkSrc, xcframeworkDst);
        console.log(`[uniffi-bridge] Copied ${FRAMEWORK_NAME} → ios/`);
      }

      if (fs.existsSync(bindingsSrc)) {
        copyFileIfChanged(bindingsSrc, path.join(mainAppSwiftDir, BINDINGS_NAME));
        console.log(`[uniffi-bridge] Copied ${BINDINGS_NAME} → ios/${TARGET_NAME}/`);

        if (fs.existsSync(cryptoModuleIosDir)) {
          copyFileIfChanged(bindingsSrc, path.join(cryptoModuleIosDir, BINDINGS_NAME));
          console.log(`[uniffi-bridge] Copied ${BINDINGS_NAME} → modules/beebeeb-crypto/ios/`);
        }
      } else {
        console.warn(`[uniffi-bridge] WARNING: ${bindingsSrc} not found`);
      }

      if (fs.existsSync(bridgeSrc) && fs.existsSync(cryptoModuleIosDir)) {
        copyFileIfChanged(bridgeSrc, path.join(cryptoModuleIosDir, BRIDGE_NAME));
        console.log(`[uniffi-bridge] Copied ${BRIDGE_NAME} → modules/beebeeb-crypto/ios/`);
      }

      return config;
    },
  ]);

const withXcodeProjectWiring = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    // pbxTargetByName() returns the PBXNativeTarget OBJECT (no uuid) under
    // SDK 57's xcode lib — resolve { uuid, ...target } from the section instead.
    const findTarget = (name) => {
      const section = project.pbxNativeTargetSection();
      for (const [uuid, value] of Object.entries(section)) {
        if (value && typeof value === 'object' && value.name === name) return { uuid, ...value };
      }
      return null;
    };
    const target = findTarget(TARGET_NAME);
    if (!target) {
      console.warn(`[uniffi-bridge] Target "${TARGET_NAME}" not found in Xcode project`);
      return config;
    }

    // Link the Rust xcframework into the APP target with a build file owned by
    // the app target (plugins/lib/extension-target.js). xcode-lib's
    // addFramework() reused one PBXBuildFile across targets under SDK 57, which
    // Xcodeproj rejects at pod install ("Consistency issue: no parent for
    // object BeebeebCore.xcframework: FrameworksBuildPhase, FrameworksBuildPhase").
    // The Share and FileProvider extensions link it via their own plugins.
    // Pass the LIVE PBXNativeTarget object (findTarget() returns a spread copy;
    // mutations to a copy never reach the project).
    linkRustFramework(project, { uuid: target.uuid, target: project.pbxNativeTargetSection()[target.uuid] });
    console.log(`[uniffi-bridge] Linked ${FRAMEWORK_NAME} to ${TARGET_NAME}`);
    // Link the Rust static library EXPLICITLY per SDK slice. Neither CocoaPods
    // (the podspec's vendored_frameworks — slice libs have different names, so
    // no -l flag is emitted) nor the xcframework file ref in the Frameworks
    // phase resolves it under SDK 57 / RN 0.86's debug-dylib app layout:
    // every uniffi FFI symbol was undefined at link time.
    const rustLinkFlags = {
      '"OTHER_LDFLAGS[sdk=iphonesimulator*]"':
        '"$(inherited) \\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/libbeebeeb_uniffi_sim_fat.a\\""',
      '"OTHER_LDFLAGS[sdk=iphoneos*]"':
        '"$(inherited) \\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64/libbeebeeb_uniffi.a\\""',
    };
    const applyRustLinkFlags = (nativeTarget) => {
      const listUuid = nativeTarget && nativeTarget.buildConfigurationList;
      const list = listUuid && project.pbxXCConfigurationList()[listUuid];
      const configs = project.pbxXCBuildConfigurationSection();
      for (const ref of (list && list.buildConfigurations) || []) {
        const cfg = configs[ref.value];
        if (cfg && cfg.buildSettings) Object.assign(cfg.buildSettings, rustLinkFlags);
      }
    };
    // App target only — the extension targets set these flags themselves in
    // plugins/lib/extension-target.js (this mod runs BEFORE they exist).
    applyRustLinkFlags(target);

    let beebeebGroupKey =
      project.findPBXGroupKey({ name: TARGET_NAME, path: TARGET_NAME }) ||
      project.findPBXGroupKey({ name: TARGET_NAME }) ||
      project.findPBXGroupKey({ path: TARGET_NAME });

    const bindingsRel = `${TARGET_NAME}/${BINDINGS_NAME}`;
    if (!project.hasFile(bindingsRel)) {
      project.addSourceFile(bindingsRel, { target: target.uuid }, beebeebGroupKey);
      console.log(`[uniffi-bridge] Added ${BINDINGS_NAME} to ${TARGET_NAME} sources`);
    }

    return config;
  });

const withPodfileSearchPaths = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return config;

      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(POD_TAG)) return config;

      const hook = `
    # ${POD_TAG} — give the BeebeebCrypto pod target compile-time access to the
    # BeebeebCore xcframework's modulemap so \`import beebeeb_uniffiFFI\` resolves.
    installer.pods_project.targets.each do |t|
      next unless ['BeebeebCrypto', 'beebeeb-crypto'].include?(t.name)
      t.build_configurations.each do |c|
        c.build_settings['FRAMEWORK_SEARCH_PATHS'] ||= ['$(inherited)']
        ['$(PODS_ROOT)/..', '$(PROJECT_DIR)/..'].each do |sp|
          c.build_settings['FRAMEWORK_SEARCH_PATHS'] << sp unless c.build_settings['FRAMEWORK_SEARCH_PATHS'].include?(sp)
        end
      end
    end
`;

      const anchor = /post_install do \|installer\|/;
      if (anchor.test(contents)) {
        contents = contents.replace(anchor, (m) => `${m}${hook}`);
        fs.writeFileSync(podfilePath, contents);
        console.log('[uniffi-bridge] Injected post_install hook into Podfile');
      } else {
        console.warn('[uniffi-bridge] WARNING: could not find post_install block in Podfile');
      }

      return config;
    },
  ]);

const withUniffiBridge = (config) => {
  config = withCopyArtifacts(config);
  config = withXcodeProjectWiring(config);
  config = withPodfileSearchPaths(config);
  return config;
};

module.exports = withUniffiBridge;
