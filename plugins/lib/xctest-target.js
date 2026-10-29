// Generic "ensure a host-less XCTest bundle target exists" helper for config
// plugins (task 1562).
//
// `ProvenanceHeadersTests` (task 1439) and `CoreVectorsKATTests` (task 1382)
// were hand-added to `ios/Beebeeb.xcodeproj/project.pbxproj` in Xcode, like
// the extension targets were before `plugins/lib/extension-target.js` (task
// 1305) started reproducing those from `expo prebuild --clean`. Unlike an
// extension target, a standalone XCTest bundle has no test host, no Pods, no
// entitlements, no Info.plist file (Xcode synthesizes one via
// GENERATE_INFOPLIST_FILE), is never embedded into the app, and the app
// target never declares a dependency on it — so `ensureExtensionTarget`'s
// shape (APPLICATION_EXTENSION_API_ONLY, CODE_SIGN_ENTITLEMENTS,
// INFOPLIST_FILE, "Embed App Extensions", PBXTargetDependency) does not
// apply. This helper reuses the low-level pbxproj primitives
// extension-target.js exports (section/addCommented/findObject/
// ensureFileReference/ensureBuildFile/ensureBuildPhase/getMainGroup) rather
// than re-deriving that plumbing.
//
// Every build-setting key/value below was read back from the pbxproj tasks
// 1382/1439 hand-committed (git history prior to task 1562) for
// ProvenanceHeadersTests / CoreVectorsKATTests, so a fresh `--clean` prebuild
// reproduces byte-for-byte EQUIVALENT settings (UUIDs are freshly generated
// on every `--clean` run — that is true of every plugin-owned target in this
// project, not specific to this helper — so an exact pbxproj text diff is
// never the bar; target presence + a working `xcodebuild -list` + `kat-ios.sh`
// passing is).
//
// Spec shape (all paths are project-relative to ios/, i.e. `../x` escapes
// the ios/ directory):
//   {
//     name: 'CoreVectorsKATTests',
//     bundleId: 'io.beebeeb.app.CoreVectorsKATTests',
//     groupChildren: [
//       { path: 'BeebeebNativeTests/CoreVectorsKATTests.swift', name: '...' },
//       { name: 'Vectors', files: [{ path: '...core-vectors.v4.json', name: '...', fileType: 'text.json' }] },
//     ],
//     sources: [{ path: 'BeebeebNativeTests/CoreVectorsKATTests.swift', name: '...' }, …],
//     resources: [{ path: '...core-vectors.v4.json', name: '...' }],
//     linkRustFramework: true,   // links BeebeebCore.xcframework + per-SDK header/ldflags, like extension-target.js
//     deploymentTarget: '16.0',
//   }

const {
  section,
  addCommented,
  findObject,
  getProjectObject,
  getMainGroup,
  ensureFileReference,
  ensureBuildFile,
  ensureBuildPhase,
  ownedBuildFileUuids,
} = require('./extension-target');

/**
 * Build (or reuse) a PBXGroup tree. `children` is a mix of file specs
 * ({ path, name, fileType }) and nested-group specs ({ name, files }),
 * mirroring the tree shape already committed for CoreVectorsKATTests
 * (a top-level group containing the .swift file plus a "Vectors" subgroup).
 */
function ensureFilesGroup(project, name, children) {
  const groups = section(project, 'PBXGroup');
  const childRefs = children.map((child) => {
    if (child.files) {
      const nestedUuid = ensureFilesGroup(project, child.name, child.files);
      return { value: nestedUuid, comment: child.name };
    }
    const fileUuid = ensureFileReference(project, { fileType: 'sourcecode.swift', ...child });
    return { value: fileUuid, comment: child.name };
  });

  const existing = findObject(groups, (value) => value.name === name);
  if (existing) {
    const group = existing[1];
    const existingChildren = new Set((group.children || []).map((child) => child.value));
    group.children = [...(group.children || [])];
    for (const ref of childRefs) {
      if (!existingChildren.has(ref.value)) group.children.push(ref);
    }
    return existing[0];
  }

  const uuid = project.generateUuid();
  addCommented(groups, uuid, { isa: 'PBXGroup', children: childRefs, name, sourceTree: '"<group>"' }, name);
  return uuid;
}

function ensureTestProductReference(project, spec) {
  const fileReferences = section(project, 'PBXFileReference');
  const productPath = `${spec.name}.xctest`;
  const existing = findObject(fileReferences, (value) => value.path === productPath);
  if (existing) return existing[0];

  const uuid = project.generateUuid();
  addCommented(
    fileReferences,
    uuid,
    {
      isa: 'PBXFileReference',
      explicitFileType: 'wrapper.cfbundle',
      includeInIndex: 0,
      path: productPath,
      sourceTree: 'BUILT_PRODUCTS_DIR',
    },
    productPath,
  );

  const productsGroup = project.pbxGroupByName('Products');
  if (productsGroup && !productsGroup.children?.some((child) => child.value === uuid)) {
    productsGroup.children = productsGroup.children || [];
    productsGroup.children.push({ value: uuid, comment: productPath });
  }
  return uuid;
}

/** The system XCTest.framework, referenced from DEVELOPER_DIR (not the app-relative "<group>" tree ensureFileReference assumes). */
function ensureXCTestFrameworkReference(project) {
  const fileReferences = section(project, 'PBXFileReference');
  const frameworkPath = 'Platforms/iPhoneOS.platform/Developer/Library/Frameworks/XCTest.framework';
  const existing = findObject(fileReferences, (value) => value.path === frameworkPath);
  if (existing) return existing[0];

  const uuid = project.generateUuid();
  addCommented(
    fileReferences,
    uuid,
    {
      isa: 'PBXFileReference',
      lastKnownFileType: 'wrapper.framework',
      name: 'XCTest.framework',
      path: frameworkPath,
      sourceTree: 'DEVELOPER_DIR',
    },
    'XCTest.framework',
  );
  return uuid;
}

function ensureTestBuildConfigurations(project, spec) {
  const buildConfigurations = section(project, 'XCBuildConfiguration');
  const configListSection = section(project, 'XCConfigurationList');
  const listComment = `Build configuration list for PBXNativeTarget "${spec.name}"`;
  const existing = findObject(
    configListSection,
    (_value, key) => configListSection[`${key}_comment`] === listComment,
  );
  if (existing) return existing[0];

  const moduleMapDevice = '$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64/Headers/module.modulemap';
  const moduleMapSim = '$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers/module.modulemap';

  const createConfig = (name, debug) => {
    const uuid = project.generateUuid();
    const expoDefine = debug ? 'EXPO_CONFIGURATION_DEBUG' : 'EXPO_CONFIGURATION_RELEASE';
    const buildSettings = {
      ALWAYS_SEARCH_USER_PATHS: 'NO',
      CLANG_ENABLE_MODULES: 'YES',
      // Host-less XCTest bundles never run in App Review / TestFlight or on
      // a device outside this Mac — never signed, matching the pbxproj tasks
      // 1382/1439 hand-committed.
      CODE_SIGNING_ALLOWED: 'NO',
      CODE_SIGNING_REQUIRED: 'NO',
      CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: 1,
      GENERATE_INFOPLIST_FILE: 'YES',
      IPHONEOS_DEPLOYMENT_TARGET: spec.deploymentTarget || '16.0',
      MARKETING_VERSION: '1.0.0',
      OTHER_SWIFT_FLAGS: `"$(inherited) -D ${expoDefine}"`,
      PRODUCT_BUNDLE_IDENTIFIER: spec.bundleId,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SWIFT_VERSION: 5.0,
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(spec.linkRustFramework
        ? {
            FRAMEWORK_SEARCH_PATHS: ['"$(inherited)"', '"$(PROJECT_DIR)"'],
            '"HEADER_SEARCH_PATHS[sdk=iphoneos*]"': [
              '"$(inherited)"',
              '"\\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64/Headers\\""',
            ],
            '"HEADER_SEARCH_PATHS[sdk=iphonesimulator*]"': [
              '"$(inherited)"',
              '"\\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers\\""',
            ],
            '"OTHER_LDFLAGS[sdk=iphonesimulator*]"':
              '"$(inherited) \\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/libbeebeeb_uniffi_sim_fat.a\\""',
            '"OTHER_LDFLAGS[sdk=iphoneos*]"':
              '"$(inherited) \\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64/libbeebeeb_uniffi.a\\""',
            '"OTHER_SWIFT_FLAGS[sdk=iphoneos*]"': `"$(inherited) -D ${expoDefine} -Xcc -fmodule-map-file=\\"${moduleMapDevice}\\""`,
            '"OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]"': `"$(inherited) -D ${expoDefine} -Xcc -fmodule-map-file=\\"${moduleMapSim}\\""`,
          }
        : {}),
      ...(spec.extraBuildSettings || {}),
    };
    if (debug) buildSettings.SWIFT_OPTIMIZATION_LEVEL = '"-Onone"';
    addCommented(buildConfigurations, uuid, { isa: 'XCBuildConfiguration', buildSettings, name }, name);
    return uuid;
  };

  const debugUuid = createConfig('Debug', true);
  const releaseUuid = createConfig('Release', false);
  const configListUuid = project.generateUuid();
  addCommented(
    configListSection,
    configListUuid,
    {
      isa: 'XCConfigurationList',
      buildConfigurations: [
        { value: debugUuid, comment: 'Debug' },
        { value: releaseUuid, comment: 'Release' },
      ],
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: 'Release',
    },
    listComment,
  );
  return configListUuid;
}

function ensureTestNativeTarget(project, spec) {
  const nativeTargets = section(project, 'PBXNativeTarget');
  const productReference = ensureTestProductReference(project, spec);
  const buildConfigurationList = ensureTestBuildConfigurations(project, spec);
  const existing = findObject(nativeTargets, (value) => value.name === spec.name);
  if (existing) {
    const target = existing[1];
    target.buildConfigurationList = buildConfigurationList;
    target.buildConfigurationList_comment = `Build configuration list for PBXNativeTarget "${spec.name}"`;
    return { uuid: existing[0], target };
  }

  const uuid = project.generateUuid();
  const target = {
    isa: 'PBXNativeTarget',
    buildConfigurationList,
    buildPhases: [],
    buildRules: [],
    dependencies: [],
    name: spec.name,
    productName: spec.name,
    productReference,
    productType: '"com.apple.product-type.bundle.unit-test"',
  };
  addCommented(nativeTargets, uuid, target, spec.name);

  const projectObject = getProjectObject(project);
  if (projectObject && !projectObject.targets?.some((item) => item.value === uuid)) {
    projectObject.targets = projectObject.targets || [];
    projectObject.targets.push({ value: uuid, comment: spec.name });
  }
  return { uuid, target };
}

/**
 * Ensure the host-less XCTest bundle target described by `spec` exists in
 * `project`, with its group tree, sources, XCTest.framework link, and
 * (optionally) the Rust framework link. Idempotent: safe on both a clean and
 * an already-wired project. Never touches the app target — these targets
 * have no dependency relationship with it and are not embedded anywhere.
 */
function ensureXCTestTarget(project, spec) {
  const topGroupUuid = ensureFilesGroup(project, spec.name, spec.groupChildren);
  const mainGroup = getMainGroup(project);
  if (mainGroup && !mainGroup.children?.some((child) => child.value === topGroupUuid)) {
    mainGroup.children = mainGroup.children || [];
    mainGroup.children.push({ value: topGroupUuid, comment: spec.name });
  }

  const target = ensureTestNativeTarget(project, spec);
  const owned = ownedBuildFileUuids(project, target.target);

  const sourceBuildFiles = spec.sources.map((file) => {
    const fileRef = ensureFileReference(project, { fileType: 'sourcecode.swift', ...file });
    return { value: ensureBuildFile(project, fileRef, `${file.name} in Sources`, undefined, owned), comment: `${file.name} in Sources` };
  });

  const resourceBuildFiles = (spec.resources || []).map((file) => {
    const fileRef = ensureFileReference(project, { fileType: 'text.json', ...file });
    return { value: ensureBuildFile(project, fileRef, `${file.name} in Resources`, undefined, owned), comment: `${file.name} in Resources` };
  });

  const frameworkBuildFiles = [
    {
      value: ensureBuildFile(project, ensureXCTestFrameworkReference(project), 'XCTest.framework in Frameworks', undefined, owned),
      comment: 'XCTest.framework in Frameworks',
    },
  ];
  if (spec.linkRustFramework) {
    const frameworkRef =
      findObject(section(project, 'PBXFileReference'), (value) => value.path === 'BeebeebCore.xcframework')?.[0] ||
      ensureFileReference(project, { path: 'BeebeebCore.xcframework', name: 'BeebeebCore.xcframework', fileType: 'wrapper.xcframework' });
    frameworkBuildFiles.push({
      value: ensureBuildFile(project, frameworkRef, 'BeebeebCore.xcframework in Frameworks', undefined, owned),
      comment: 'BeebeebCore.xcframework in Frameworks',
    });
  }

  ensureBuildPhase(project, target.target, 'PBXSourcesBuildPhase', 'Sources', sourceBuildFiles);
  ensureBuildPhase(project, target.target, 'PBXFrameworksBuildPhase', 'Frameworks', frameworkBuildFiles);
  ensureBuildPhase(project, target.target, 'PBXResourcesBuildPhase', 'Resources', resourceBuildFiles);

  return target;
}

module.exports = { ensureXCTestTarget };
