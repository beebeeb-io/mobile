const { withInfoPlist, withAppDelegate, withXcodeProject, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

// Adopts the UIScene lifecycle (task: iOS 27 build 213 crash — EXC_BREAKPOINT in
// UIKitCore `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`,
// terminated at launch because the app links against the iOS 27 SDK without a
// scene delegate). See `SceneDelegate.swift` in this directory for the full
// rationale and what moved where.
//
// Three mods:
//  1. Info.plist — declare the one `UIWindowSceneSessionRoleApplication` scene.
//  2. Copy SceneDelegate.swift into ios/Beebeeb/ and register it as a build
//     file on the main app target (same pattern as uniffi-bridge's
//     beebeeb_uniffi.swift / BeebeebCryptoBridge.swift).
//  3. AppDelegate.swift — remove the window creation + `factory.startReactNative`
//     call (now owned by SceneDelegate) and the app-level open-URL /
//     continue-userActivity overrides (now dead code once SceneDelegate
//     implements the scene equivalents — UIKit stops calling the app-delegate
//     versions for the app's running scene).

const TARGET_NAME = 'Beebeeb';
const SCENE_DELEGATE_NAME = 'SceneDelegate.swift';
const MARKER = '@beebeeb-uiscene-lifecycle';

const withSceneManifest = (config) =>
  withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return config;
  });

const withCopySceneDelegate = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosDir = config.modRequest.platformProjectRoot;
      const src = path.join(__dirname, SCENE_DELEGATE_NAME);
      const dst = path.join(iosDir, TARGET_NAME, SCENE_DELEGATE_NAME);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      console.log(`[scene-lifecycle] Copied ${SCENE_DELEGATE_NAME} → ios/${TARGET_NAME}/`);
      return config;
    },
  ]);

const withRegisterSceneDelegate = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    // pbxTargetByName() returns the PBXNativeTarget OBJECT (no uuid) under
    // SDK 57's xcode lib — resolve { uuid, ...target } from the section
    // instead (same workaround as uniffi-bridge).
    const findTarget = (name) => {
      const section = project.pbxNativeTargetSection();
      for (const [uuid, value] of Object.entries(section)) {
        if (value && typeof value === 'object' && value.name === name) return { uuid, ...value };
      }
      return null;
    };
    const target = findTarget(TARGET_NAME);
    if (!target) {
      console.warn(`[scene-lifecycle] Target "${TARGET_NAME}" not found in Xcode project`);
      return config;
    }

    const beebeebGroupKey =
      project.findPBXGroupKey({ name: TARGET_NAME, path: TARGET_NAME }) ||
      project.findPBXGroupKey({ name: TARGET_NAME }) ||
      project.findPBXGroupKey({ path: TARGET_NAME });

    const sceneDelegateRel = `${TARGET_NAME}/${SCENE_DELEGATE_NAME}`;
    if (!project.hasFile(sceneDelegateRel)) {
      project.addSourceFile(sceneDelegateRel, { target: target.uuid }, beebeebGroupKey);
      console.log(`[scene-lifecycle] Added ${SCENE_DELEGATE_NAME} to ${TARGET_NAME} sources`);
    }

    return config;
  });

// Exact text of Expo's stock bare-template AppDelegate.swift for SDK 57 (no
// beebeeb plugin owns this region — verified against the committed,
// fully-prebuilt ios/Beebeeb/AppDelegate.swift). Matched verbatim so a clean
// prebuild reproduces the removal; a mismatch (e.g. an Expo SDK bump changed
// the template) warns instead of silently no-opping.
const DIDFINISH_WINDOW_OLD = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const DIDFINISH_WINDOW_NEW = `    // ${MARKER}: window creation + factory.startReactNative now happen in
    // SceneDelegate.scene(_:willConnectTo:options:) once UIKit connects the
    // scene. Creating a bare UIWindow here (no windowScene) is exactly what
    // iOS 27 kills the app for — see UIApplicationSceneManifest in Info.plist.`;

const LINKING_OVERRIDES_OLD = `  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }`;

const LINKING_OVERRIDES_NEW = `  // ${MARKER}: Linking API (beebeeb://, exp+beebeeb://) and Universal Links
  // moved to SceneDelegate.scene(_:openURLContexts:) / scene(_:continue:).
  // Once a UIWindowSceneSessionRoleApplication scene delegate implements
  // these, UIKit stops calling the app-delegate versions above for the app's
  // running scene, so leaving them here would be unreachable.`;

function applyReplacement(contents, oldText, newText, label) {
  // Idempotency check is per-replacement (this exact new text), not a shared
  // MARKER — two DIFFERENT replacements in the same pass both carry MARKER in
  // their comment text, so gating on the marker alone would make the second
  // replacement look "already applied" and skip it silently on a fresh template.
  if (contents.includes(newText)) return contents;
  if (!contents.includes(oldText)) {
    console.warn(
      `[scene-lifecycle] WARNING: could not find expected "${label}" text in AppDelegate — leaving untouched. ` +
        'The Expo bare-template AppDelegate.swift may have changed; adopt manually.',
    );
    return contents;
  }
  return contents.replace(oldText, newText);
}

const withAppDelegateSceneAdoption = (config) =>
  withAppDelegate(config, (config) => {
    const { language, contents } = config.modResults;

    if (language !== 'swift') {
      console.warn(`[scene-lifecycle] WARNING: unexpected AppDelegate language "${language}" — expected swift`);
      return config;
    }

    let next = contents;
    next = applyReplacement(next, DIDFINISH_WINDOW_OLD, DIDFINISH_WINDOW_NEW, 'window creation block');
    next = applyReplacement(next, LINKING_OVERRIDES_OLD, LINKING_OVERRIDES_NEW, 'Linking API / Universal Links overrides');

    config.modResults.contents = next;
    return config;
  });

module.exports = function withSceneLifecycle(config) {
  config = withSceneManifest(config);
  config = withCopySceneDelegate(config);
  config = withRegisterSceneDelegate(config);
  config = withAppDelegateSceneAdoption(config);
  return config;
};
