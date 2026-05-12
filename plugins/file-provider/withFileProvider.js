const { withXcodeProject, withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const EXTENSION_NAME = 'BeebeebFileProvider';
const EXTENSION_BUNDLE_ID = 'io.beebeeb.app.file-provider';
const APP_GROUP = 'group.io.beebeeb.shared';
const TEAM_ID = 'R8352WDJJR';
const SOURCE_FILES = [
  'BeebeebFileProvider.swift',
  'FileProviderItem.swift',
  'FileProviderEnumerator.swift',
  'FileProviderCrypto.swift',
  'FileProviderAPIClient.swift',
];
const EXTENSION_FILES = [
  ...SOURCE_FILES.map((file) => ({
    path: `../plugins/file-provider/${file}`,
    name: file,
    fileType: 'sourcecode.swift',
    buildPhase: 'PBXSourcesBuildPhase',
  })),
  {
    path: 'Beebeeb/beebeeb_uniffi.swift',
    name: 'beebeeb_uniffi.swift',
    fileType: 'sourcecode.swift',
    buildPhase: 'PBXSourcesBuildPhase',
  },
  {
    path: `${EXTENSION_NAME}/Info.plist`,
    name: 'Info.plist',
    fileType: 'text.plist.xml',
  },
  {
    path: `${EXTENSION_NAME}/${EXTENSION_NAME}.entitlements`,
    name: `${EXTENSION_NAME}.entitlements`,
    fileType: 'text.plist.entitlements',
  },
];

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

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
  const buildFile = {
    isa: 'PBXBuildFile',
    fileRef,
  };
  if (settings) buildFile.settings = settings;
  addCommented(buildFiles, uuid, buildFile, comment);
  return uuid;
}

function ensureGroup(project) {
  const groups = section(project, 'PBXGroup');
  const existing = findObject(groups, (value) => value.name === EXTENSION_NAME);
  const children = EXTENSION_FILES.map((file) => ({
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
    {
      isa: 'PBXGroup',
      children,
      name: EXTENSION_NAME,
      sourceTree: '"<group>"',
    },
    EXTENSION_NAME,
  );

  const mainGroup = getMainGroup(project);
  if (mainGroup && !mainGroup.children?.some((child) => child.value === uuid)) {
    mainGroup.children = mainGroup.children || [];
    mainGroup.children.push({ value: uuid, comment: EXTENSION_NAME });
  }

  return uuid;
}

function ensureProductReference(project) {
  const fileReferences = section(project, 'PBXFileReference');
  const productPath = `${EXTENSION_NAME}.appex`;
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

function ensureExtensionBuildConfigurations(project) {
  const buildConfigurations = section(project, 'XCBuildConfiguration');
  const configListSection = section(project, 'XCConfigurationList');
  const existing = findObject(
    configListSection,
    (_value, key) => configListSection[`${key}_comment`] === `Build configuration list for PBXNativeTarget "${EXTENSION_NAME}"`,
  );
  if (existing) return existing[0];

  const createConfig = (name, debug) => {
    const uuid = project.generateUuid();
    const buildSettings = {
      ALWAYS_SEARCH_USER_PATHS: 'NO',
      APPLICATION_EXTENSION_API_ONLY: 'YES',
      CLANG_ENABLE_MODULES: 'YES',
      CODE_SIGN_ENTITLEMENTS: `${EXTENSION_NAME}/${EXTENSION_NAME}.entitlements`,
      CURRENT_PROJECT_VERSION: 1,
      DEVELOPMENT_TEAM: TEAM_ID,
      FRAMEWORK_SEARCH_PATHS: ['"$(inherited)"', '"$(PROJECT_DIR)"'],
      INFOPLIST_FILE: `${EXTENSION_NAME}/Info.plist`,
      IPHONEOS_DEPLOYMENT_TARGET: 16.0,
      LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
      MARKETING_VERSION: '1.0.0',
      PRODUCT_BUNDLE_IDENTIFIER: EXTENSION_BUNDLE_ID,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SKIP_INSTALL: 'YES',
      SWIFT_VERSION: 5.0,
      TARGETED_DEVICE_FAMILY: '"1,2"',
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
    `Build configuration list for PBXNativeTarget "${EXTENSION_NAME}"`,
  );
  return configListUuid;
}

function ensureTarget(project) {
  const nativeTargets = section(project, 'PBXNativeTarget');
  const productReference = ensureProductReference(project);
  const buildConfigurationList = ensureExtensionBuildConfigurations(project);
  const existing = findObject(nativeTargets, (value) => value.name === EXTENSION_NAME);
  if (existing) {
    const target = existing[1];
    target.buildConfigurationList = buildConfigurationList;
    target.buildConfigurationList_comment = `Build configuration list for PBXNativeTarget "${EXTENSION_NAME}"`;
    return { uuid: existing[0], target };
  }

  const uuid = project.generateUuid();
  const target = {
    isa: 'PBXNativeTarget',
    buildConfigurationList,
    buildPhases: [],
    buildRules: [],
    dependencies: [],
    name: EXTENSION_NAME,
    productName: EXTENSION_NAME,
    productReference,
    productType: '"com.apple.product-type.app-extension"',
  };
  addCommented(nativeTargets, uuid, target, EXTENSION_NAME);

  const projectObject = getProjectObject(project);
  if (projectObject && !projectObject.targets?.some((item) => item.value === uuid)) {
    projectObject.targets = projectObject.targets || [];
    projectObject.targets.push({ value: uuid, comment: EXTENSION_NAME });
  }

  return { uuid, target };
}

function ensureTargetDependency(project, appTarget, extensionTarget) {
  if (appTarget.target.dependencies?.some((dependency) => dependency.comment === EXTENSION_NAME)) return;

  const containerProxies = section(project, 'PBXContainerItemProxy');
  const targetDependencies = section(project, 'PBXTargetDependency');
  const projectObject = getProjectObject(project);
  const proxyUuid = project.generateUuid();
  addCommented(
    containerProxies,
    proxyUuid,
    {
      isa: 'PBXContainerItemProxy',
      containerPortal: project.getFirstProject().uuid,
      proxyType: 1,
      remoteGlobalIDString: extensionTarget.uuid,
      remoteInfo: EXTENSION_NAME,
    },
    `PBXContainerItemProxy`,
  );

  const dependencyUuid = project.generateUuid();
  addCommented(
    targetDependencies,
    dependencyUuid,
    {
      isa: 'PBXTargetDependency',
      target: extensionTarget.uuid,
      targetProxy: proxyUuid,
    },
    EXTENSION_NAME,
  );

  appTarget.target.dependencies = appTarget.target.dependencies || [];
  appTarget.target.dependencies.push({ value: dependencyUuid, comment: EXTENSION_NAME });
}

function ensureExtensionWiring(project) {
  ensureGroup(project);
  const extensionTarget = ensureTarget(project);
  const appTarget = project.getFirstTarget();
  if (!appTarget) return;

  const sourceBuildFiles = SOURCE_FILES.map((file) => {
    const fileRef = ensureFileReference(project, {
      path: `../plugins/file-provider/${file}`,
      name: file,
      fileType: 'sourcecode.swift',
    });
    return {
      value: ensureBuildFile(project, fileRef, `${file} in Sources`),
      comment: `${file} in Sources`,
    };
  });

  const uniffiRef = ensureFileReference(project, {
    path: 'Beebeeb/beebeeb_uniffi.swift',
    name: 'beebeeb_uniffi.swift',
    fileType: 'sourcecode.swift',
  });
  sourceBuildFiles.push({
    value: ensureBuildFile(project, uniffiRef, 'beebeeb_uniffi.swift in Sources'),
    comment: 'beebeeb_uniffi.swift in Sources',
  });

  const frameworkRef =
    findObject(section(project, 'PBXFileReference'), (value) => value.path === 'BeebeebCore.xcframework')?.[0] ||
    ensureFileReference(project, {
      path: 'BeebeebCore.xcframework',
      name: 'BeebeebCore.xcframework',
      fileType: 'wrapper.xcframework',
    });
  const frameworkBuildFile = {
    value: ensureBuildFile(project, frameworkRef, 'BeebeebCore.xcframework in Frameworks'),
    comment: 'BeebeebCore.xcframework in Frameworks',
  };

  ensureBuildPhase(project, extensionTarget.target, 'PBXSourcesBuildPhase', 'Sources', sourceBuildFiles);
  ensureBuildPhase(project, extensionTarget.target, 'PBXFrameworksBuildPhase', 'Frameworks', [frameworkBuildFile]);
  ensureBuildPhase(project, extensionTarget.target, 'PBXResourcesBuildPhase', 'Resources', []);

  const productBuildFile = {
    value: ensureBuildFile(project, extensionTarget.target.productReference, `${EXTENSION_NAME}.appex in Embed App Extensions`, {
      ATTRIBUTES: ['RemoveHeadersOnCopy'],
    }),
    comment: `${EXTENSION_NAME}.appex in Embed App Extensions`,
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

  ensureTargetDependency(project, appTarget, extensionTarget);
}

function withFileProvider(config) {
  // Step 1: Add extension entitlements
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['com.apple.security.application-groups'] = unique([
      ...(config.modResults['com.apple.security.application-groups'] || []),
      APP_GROUP,
    ]);
    config.modResults['keychain-access-groups'] = unique([
      ...(config.modResults['keychain-access-groups'] || []),
      '$(AppIdentifierPrefix)io.beebeeb.shared',
    ]);
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
    const iosDir = config.modRequest.platformProjectRoot;
    const extDir = path.join(iosDir, EXTENSION_NAME);

    // Create extension directory
    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
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
    fs.writeFileSync(path.join(extDir, `${EXTENSION_NAME}.entitlements`), entitlements);

    ensureExtensionWiring(project);
    console.log(`[FileProvider] Wired '${EXTENSION_NAME}' target and refreshed ${extDir}`);

    return config;
  });

  return config;
}

module.exports = withFileProvider;
