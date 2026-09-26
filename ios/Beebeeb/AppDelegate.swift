internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // @beebeeb-uiscene-lifecycle: window creation + factory.startReactNative now happen in
    // SceneDelegate.scene(_:willConnectTo:options:) once UIKit connects the
    // scene. Creating a bare UIWindow here (no windowScene) is exactly what
    // iOS 27 kills the app for — see UIApplicationSceneManifest in Info.plist.

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // @beebeeb-uiscene-lifecycle: Linking API (beebeeb://, exp+beebeeb://) and Universal Links
  // moved to SceneDelegate.scene(_:openURLContexts:) / scene(_:continue:).
  // Once a UIWindowSceneSessionRoleApplication scene delegate implements
  // these, UIKit stops calling the app-delegate versions above for the app's
  // running scene, so leaving them here would be unreachable.
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

  // @beebeeb-shortcut-bridge
  func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
    if let urlString = shortcutItem.userInfo?["url"] as? String, let url = URL(string: urlString) {
      let handled = RCTLinkingManager.application(application, open: url, options: [:])
      completionHandler(handled)
      return
    }
    completionHandler(false)
  }
}
