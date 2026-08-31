// Generic "ensure an app-extension target exists" helper for config plugins.
//
// Extracted from plugins/file-provider/withFileProvider.js (task 1305) so that
// every extension target in this project is reproducible from `expo prebuild
// --clean`. The Share extension target used to live only in the committed
// project.pbxproj (added by hand in Xcode) and vanished on the first clean
// prebuild of the SDK 57 upgrade. Everything here mutates the raw pbxproj
// object graph (`project.hash.project.objects`) rather than going through the
// xcode lib's higher-level helpers, which changed shape between SDK 52 and 57.
//
// Spec shape (all paths are project-relative to ios/):
//   {
//     name: 'BeebeebShare',
//     bundleId: 'io.beebeeb.app.share',
//     teamId: 'R8352WDJJR',
//     sources: [{ path: 'BeebeebShare/ShareViewController.swift', name: '…' }, …],
//     includeUniffiBindings: true,          // compiles Beebeeb/beebeeb_uniffi.swift too
//     linkRustFramework: true,              // BeebeebCore.xcframework in Frameworks
//     deploymentTarget: '16.0',
//     extraBuildSettings: {},               // merged last, both configs
//   }

function section(project, name) {
  if (!project.hash.project.objects[name]) {
    project.hash.project.objects[name] = {};
  }
  return project.hash.project.objects[name];
}

function addCommented(sectionObject, uuid, object, comment) {
  sectionObject[uuid] = object;
  sectionObject[`${uuid}_comment`] = comment;
}

function findObject(sectionObject, predicate) {
  return Object.entries(sectionObject).find(([key, value]) => {
    return !key.endsWith('_comment') && predicate(value, key);
  });
}

function getProjectObject(project) {
  const projectSection = project.pbxProjectSection();
  return findObject(projectSection, (value) => value.isa === 'PBXProject')?.[1];
}

function getMainGroup(project) {
  const projectObject = getProjectObject(project);
  if (!projectObject?.mainGroup) return null;
  return project.getPBXGroupByKey(projectObject.mainGroup);
}

function getAppTarget(project) {
  // xcode lib returns { uuid, firstTarget } — normalize to { uuid, target }.
  const first = project.getFirstTarget();
  return { uuid: first.uuid, target: first.firstTarget || first.target };
}

function ensureFileReference(project, file) {
  const fileReferences = section(project, 'PBXFileReference');
  const existing = findObject(fileReferences, (value) => value.path === file.path);
  if (existing) return existing[0];

  const uuid = project.generateUuid();
  addCommented(
    fileReferences,
    uuid,
    {
      isa: 'PBXFileReference',
      fileEncoding: 4,
      lastKnownFileType: file.fileType,
      name: file.name,
      path: file.path,
      sourceTree: '"<group>"',
    },
    file.name,
  );
  return uuid;
}

function ensureBuildFile(project, fileRef, comment, settings) {
  const buildFiles = section(project, 'PBXBuildFile');
  const existing = findObject(
    buildFiles,
    (value) => value.fileRef === fileRef && (!settings || JSON.stringify(value.settings) === JSON.stringify(settings)),
  );
  if (existing) return existing[0];

  const uuid = project.generateUuid();
  const buildFile = { isa: 'PBXBuildFile', fileRef };
  if (settings) buildFile.settings = settings;
  addCommented(buildFiles, uuid, buildFile, comment);
  return uuid;
}

function ensureGroup(project, spec, files) {
  const groups = section(project, 'PBXGroup');
  const existing = findObject(groups, (value) => value.name === spec.name);
  const children = files.map((file) => ({
    value: ensureFileReference(project, file),
    comment: file.name,
  }));

  if (existing) {
    const group = existing[1];
    const existingChildren = new Set((group.children || []).map((child) => child.value));
    group.children = [...(group.children || [])];
    for (const child of children) {
      if (!existingChildren.has(child.value)) group.children.push(child);
    }
    return existing[0];
  }

  const uuid = project.generateUuid();
  addCommented(
    groups,
    uuid,
    { isa: 'PBXGroup', children, name: spec.name, sourceTree: '"<group>"' },
    spec.name,
  );

  const mainGroup = getMainGroup(project);
  if (mainGroup && !mainGroup.children?.some((child) => child.value === uuid)) {
    mainGroup.children = mainGroup.children || [];
    mainGroup.children.push({ value: uuid, comment: spec.name });
  }
  return uuid;
}

function ensureProductReference(project, spec) {
  const fileReferences = section(project, 'PBXFileReference');
  const productPath = `${spec.name}.appex`;
  const existing = findObject(fileReferences, (value) => value.path === productPath);
  if (existing) return existing[0];

  const uuid = project.generateUuid();
  addCommented(
    fileReferences,
    uuid,
    {
      isa: 'PBXFileReference',
      explicitFileType: '"wrapper.app-extension"',
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

function ensureBuildPhase(project, target, phaseType, phaseName, files = []) {
  const phases = section(project, phaseType);
  const existingPhaseRef = target.buildPhases?.find((phase) => phase.comment === phaseName);
  const existingPhase = existingPhaseRef ? phases[existingPhaseRef.value] : null;
  const phaseUuid = existingPhaseRef?.value || project.generateUuid();
  const phase = existingPhase || {
    isa: phaseType,
    buildActionMask: 2147483647,
    files: [],
    runOnlyForDeploymentPostprocessing: 0,
  };

  const existingFiles = new Set((phase.files || []).map((file) => file.value));
  phase.files = phase.files || [];
  for (const file of files) {
    if (!existingFiles.has(file.value)) phase.files.push(file);
  }

  if (!existingPhase) {
    addCommented(phases, phaseUuid, phase, phaseName);
    target.buildPhases = target.buildPhases || [];
    target.buildPhases.push({ value: phaseUuid, comment: phaseName });
  }
  return phaseUuid;
}

function ensureBuildConfigurations(project, spec) {
  const buildConfigurations = section(project, 'XCBuildConfiguration');
  const configListSection = section(project, 'XCConfigurationList');
  const listComment = `Build configuration list for PBXNativeTarget "${spec.name}"`;
  const existing = findObject(
    configListSection,
    (_value, key) => configListSection[`${key}_comment`] === listComment,
  );
  if (existing) return existing[0];

  const createConfig = (name, debug) => {
    const uuid = project.generateUuid();
    // Targets that compile beebeeb_uniffi.swift need the xcframework's per-slice
    // Headers on HEADER_SEARCH_PATHS and its module.modulemap fed to Clang,
    // otherwise `import beebeeb_uniffiFFI` does not resolve.
    const expoDefine = debug ? 'EXPO_CONFIGURATION_DEBUG' : 'EXPO_CONFIGURATION_RELEASE';
    const moduleMapDevice = '$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64/Headers/module.modulemap';
    const moduleMapSim = '$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers/module.modulemap';
    const buildSettings = {
      ALWAYS_SEARCH_USER_PATHS: 'NO',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CLANG_ENABLE_MODULES: 'YES',
      CODE_SIGN_ENTITLEMENTS: `${spec.name}/${spec.name}.entitlements`,
      CURRENT_PROJECT_VERSION: 1,
      DEVELOPMENT_TEAM: spec.teamId,
      FRAMEWORK_SEARCH_PATHS: ['"$(inherited)"', '"$(PROJECT_DIR)"'],
      '"HEADER_SEARCH_PATHS[sdk=iphoneos*]"': [
        '"$(inherited)"',
        '"\\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64/Headers\\""',
      ],
      '"HEADER_SEARCH_PATHS[sdk=iphonesimulator*]"': [
        '"$(inherited)"',
        '"\\"$(PROJECT_DIR)/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers\\""',
      ],
      INFOPLIST_FILE: `${spec.name}/Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: spec.deploymentTarget || '16.0',
      LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
      MARKETING_VERSION: '1.0.0',
      OTHER_SWIFT_FLAGS: `"$(inherited) -D ${expoDefine}"`,
      '"OTHER_SWIFT_FLAGS[sdk=iphoneos*]"': `"$(inherited) -D ${expoDefine} -Xcc -fmodule-map-file=\\"${moduleMapDevice}\\""`,
      '"OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]"': `"$(inherited) -D ${expoDefine} -Xcc -fmodule-map-file=\\"${moduleMapSim}\\""`,
      PRODUCT_BUNDLE_IDENTIFIER: spec.bundleId,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SKIP_INSTALL: 'YES',
      SWIFT_VERSION: 5.0,
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(spec.extraBuildSettings || {}),
    };
    if (debug) {
      buildSettings.GCC_PREPROCESSOR_DEFINITIONS = ['"DEBUG=1"', '"$(inherited)"'];
      buildSettings.SWIFT_OPTIMIZATION_LEVEL = '"-Onone"';
    }
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

function ensureNativeTarget(project, spec) {
  const nativeTargets = section(project, 'PBXNativeTarget');
  const productReference = ensureProductReference(project, spec);
  const buildConfigurationList = ensureBuildConfigurations(project, spec);
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
    productType: '"com.apple.product-type.app-extension"',
  };
  addCommented(nativeTargets, uuid, target, spec.name);

  const projectObject = getProjectObject(project);
  if (projectObject && !projectObject.targets?.some((item) => item.value === uuid)) {
    projectObject.targets = projectObject.targets || [];
    projectObject.targets.push({ value: uuid, comment: spec.name });
  }
  return { uuid, target };
}

function ensureTargetDependency(project, appTarget, extensionTarget, spec) {
  if (appTarget.target.dependencies?.some((dependency) => dependency.comment === spec.name)) return;

  const containerProxies = section(project, 'PBXContainerItemProxy');
  const targetDependencies = section(project, 'PBXTargetDependency');
  const proxyUuid = project.generateUuid();
  addCommented(
    containerProxies,
    proxyUuid,
    {
      isa: 'PBXContainerItemProxy',
      containerPortal: project.getFirstProject().uuid,
      proxyType: 1,
      remoteGlobalIDString: extensionTarget.uuid,
      remoteInfo: spec.name,
    },
    'PBXContainerItemProxy',
  );

  const dependencyUuid = project.generateUuid();
  addCommented(
    targetDependencies,
    dependencyUuid,
    { isa: 'PBXTargetDependency', target: extensionTarget.uuid, targetProxy: proxyUuid },
    spec.name,
  );

  appTarget.target.dependencies = appTarget.target.dependencies || [];
  appTarget.target.dependencies.push({ value: dependencyUuid, comment: spec.name });
}

/**
 * Ensure the extension target described by `spec` exists in `project`, with its
 * sources, (optional) uniffi bindings + Rust framework link, an "Embed App
 * Extensions" copy phase on the app target, and the app→extension dependency.
 * Idempotent: safe on both a clean and an already-wired project.
 */
function ensureExtensionTarget(project, spec) {
  const sourceFiles = spec.sources.map((s) => ({ ...s, fileType: 'sourcecode.swift', buildPhase: 'PBXSourcesBuildPhase' }));
  const groupFiles = [
    ...sourceFiles,
    ...(spec.includeUniffiBindings
      ? [{ path: 'Beebeeb/beebeeb_uniffi.swift', name: 'beebeeb_uniffi.swift', fileType: 'sourcecode.swift' }]
      : []),
    { path: `${spec.name}/Info.plist`, name: 'Info.plist', fileType: 'text.plist.xml' },
    { path: `${spec.name}/${spec.name}.entitlements`, name: `${spec.name}.entitlements`, fileType: 'text.plist.entitlements' },
  ];
  ensureGroup(project, spec, groupFiles);

  const extensionTarget = ensureNativeTarget(project, spec);
  const appTarget = getAppTarget(project);

  const sourceBuildFiles = sourceFiles.map((file) => {
    const fileRef = ensureFileReference(project, file);
    return { value: ensureBuildFile(project, fileRef, `${file.name} in Sources`), comment: `${file.name} in Sources` };
  });
  if (spec.includeUniffiBindings) {
    const uniffiRef = ensureFileReference(project, {
      path: 'Beebeeb/beebeeb_uniffi.swift',
      name: 'beebeeb_uniffi.swift',
      fileType: 'sourcecode.swift',
    });
    sourceBuildFiles.push({
      value: ensureBuildFile(project, uniffiRef, 'beebeeb_uniffi.swift in Sources'),
      comment: 'beebeeb_uniffi.swift in Sources',
    });
  }

  const frameworkBuildFiles = [];
  if (spec.linkRustFramework) {
    const frameworkRef =
      findObject(section(project, 'PBXFileReference'), (value) => value.path === 'BeebeebCore.xcframework')?.[0] ||
      ensureFileReference(project, {
        path: 'BeebeebCore.xcframework',
        name: 'BeebeebCore.xcframework',
        fileType: 'wrapper.xcframework',
      });
    frameworkBuildFiles.push({
      value: ensureBuildFile(project, frameworkRef, 'BeebeebCore.xcframework in Frameworks'),
      comment: 'BeebeebCore.xcframework in Frameworks',
    });
  }

  ensureBuildPhase(project, extensionTarget.target, 'PBXSourcesBuildPhase', 'Sources', sourceBuildFiles);
  ensureBuildPhase(project, extensionTarget.target, 'PBXFrameworksBuildPhase', 'Frameworks', frameworkBuildFiles);
  ensureBuildPhase(project, extensionTarget.target, 'PBXResourcesBuildPhase', 'Resources', []);

  const productBuildFile = {
    value: ensureBuildFile(project, extensionTarget.target.productReference, `${spec.name}.appex in Embed App Extensions`, {
      ATTRIBUTES: ['RemoveHeadersOnCopy'],
    }),
    comment: `${spec.name}.appex in Embed App Extensions`,
  };
  const embedPhaseUuid = ensureBuildPhase(
    project,
    appTarget.target,
    'PBXCopyFilesBuildPhase',
    'Embed App Extensions',
    [productBuildFile],
  );
  const embedPhase = section(project, 'PBXCopyFilesBuildPhase')[embedPhaseUuid];
  embedPhase.dstPath = '""';
  embedPhase.dstSubfolderSpec = 13;
  embedPhase.name = '"Embed App Extensions"';

  ensureTargetDependency(project, appTarget, extensionTarget, spec);
  return extensionTarget;
}

module.exports = { ensureExtensionTarget };
