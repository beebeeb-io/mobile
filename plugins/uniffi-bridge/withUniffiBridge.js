const { withXcodeProject, withDangerousMod } = require('@expo/config-plugins');
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

    // Gate on the APP target's Frameworks phase, not on project.hasFile(): the
    // file-provider plugin creates a file ref for the same xcframework, and
    // under SDK 57's xcode lib hasFile() then returned true → the app target
    // was never linked → every Rust FFI symbol undefined at link time.
    const appFrameworksPhase = project.pbxFrameworksBuildPhaseObj(target.uuid);
    const appAlreadyLinked = !!(appFrameworksPhase && (appFrameworksPhase.files || []).some(
      (f) => String(f.comment || '').includes(FRAMEWORK_NAME),
    ));
    if (!appAlreadyLinked) {
      project.addFramework(FRAMEWORK_NAME, {
        customFramework: true,
        embed: true,
        sign: true,
        link: true,
        target: target.uuid,
        lastKnownFileType: 'wrapper.xcframework',
      });
      console.log(`[uniffi-bridge] Added ${FRAMEWORK_NAME} to ${TARGET_NAME} (Embed & Sign)`);
    }

    // The share extension (ios/BeebeebShare/*.swift) calls into the Rust core
    // too; the committed project linked the xcframework to it, the plugins never
    // did. Link it here so a clean prebuild reproduces a linkable project.
    const shareTarget = findTarget('BeebeebShare');
    if (shareTarget) {
      const sharePhase = project.pbxFrameworksBuildPhaseObj(shareTarget.uuid);
      const shareLinked = !!(sharePhase && (sharePhase.files || []).some(
        (f) => String(f.comment || '').includes(FRAMEWORK_NAME),
      ));
      if (!shareLinked) {
        project.addFramework(FRAMEWORK_NAME, {
          customFramework: true,
          link: true,
          target: shareTarget.uuid,
          lastKnownFileType: 'wrapper.xcframework',
        });
        console.log(`[uniffi-bridge] Linked ${FRAMEWORK_NAME} to BeebeebShare`);
      }
    }

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
    applyRustLinkFlags(target);
    if (shareTarget) applyRustLinkFlags(shareTarget);

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
