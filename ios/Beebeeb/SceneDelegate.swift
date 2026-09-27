import React
import UIKit

// @beebeeb-uiscene-lifecycle
//
// iOS 27 (24A437) terminates apps at launch (EXC_BREAKPOINT in
// UIKitCore `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`,
// called from `-[UIApplication workspace:didCreateScene:withTransitionContext:completion:]`)
// when the app is linked against the iOS 27 SDK but has not adopted the
// UIScene lifecycle. This is that adoption: the app declares exactly one
// `UIWindowSceneSessionRoleApplication` scene (see `UIApplicationSceneManifest`
// in Info.plist, injected by `withSceneLifecycle.js`) and this class owns the
// window + starts the RN factory that `AppDelegate` builds.
//
// Everything that previously lived on AppDelegate's app-level overrides for
// window/URL/user-activity handling moves here, because once a
// `UIWindowSceneSessionRoleApplication` scene delegate implements the scene
// equivalent, UIKit stops calling the app-delegate version for the app's
// running scene:
//   - window creation + `factory.startReactNative` -> `scene(_:willConnectTo:options:)`
//   - `application(_:open:options:)` (beebeeb://, exp+beebeeb://) -> `scene(_:openURLContexts:)`
//   - `application(_:continue:restorationHandler:)` (universal links) -> `scene(_:continue:)`
//
// Everything that stays app-level and unaffected by scene adoption (verified
// against Apple's docs + this repo's native code): BGTaskScheduler
// registration in `BeebeebAppDelegate.application(_:didFinishLaunchingWithOptions:)`
// (an `ExpoAppDelegateSubscriber`, still called from `AppDelegate`'s
// `didFinishLaunchingWithOptions` regardless of scenes), remote-notification
// registration/receipt (`didRegisterForRemoteNotificationsWithDeviceToken` /
// `didReceiveRemoteNotification`), and `AppState`-driven privacy/lock-screen
// covering in JS (`RCTAppState` observes `UIApplication`-level
// `willResignActive`/`didEnterBackground`/etc. notifications, which UIKit
// still posts for a single-scene app).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    // WindowControlsAwareWindow, not a plain UIWindow: keeps content clear of
    // the iPadOS 26+ window controls (task 1588) — see the class below.
    let window = WindowControlsAwareWindow(windowScene: windowScene)
    self.window = window
    // Kept in sync for any code that still reads `(delegate as? AppDelegate)?.window`.
    appDelegate.window = window

    // Cold launch via a deep link / universal link (beebeeb://, exp+beebeeb://,
    // https universal link, CLI-pair link, share-extension handoff). Once
    // scenes are adopted, iOS hands these to the connecting scene's
    // `connectionOptions` instead of to
    // `application(_:didFinishLaunchingWithOptions:)`'s own `launchOptions`.
    //
    // This has to become the `launchOptions` dictionary passed into
    // `factory.startReactNative`, NOT a post-hoc `RCTLinkingManager.application`
    // call: `RCTLinkingManager.getInitialURL()` (what React Navigation's linking
    // config calls on mount to resolve the app's initial route) reads
    // `self.bridge.launchOptions[.url]` / `[.userActivityDictionary]` directly —
    // it does not fire an event, so JS has to see it in launchOptions on the
    // SAME startReactNative call that boots the bridge. The `'url'` event
    // (RCTLinkingManager's `openURLContexts`/`continue` handlers below) only
    // reaches an ALREADY-RUNNING JS listener, which does not exist yet at cold
    // launch — startReactNative only kicks bridge/JS bring-up off, it does not
    // block until App.tsx has mounted and registered `Linking.addEventListener`.
    // (Found by reproducing exactly this: a cold `simctl openurl beebeeb://shared`
    // landed on the default Files tab instead of Shared until this fix.)
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let urlContext = connectionOptions.urlContexts.first {
      launchOptions[.url] = urlContext.url
    }
    if let userActivity = connectionOptions.userActivities.first {
      // Matches the exact shape RCTLinkingManager.getInitialURL() destructures:
      // an outer .userActivityDictionary keyed dict holding .userActivityType
      // plus the NSUserActivity itself under the literal (unnamed-constant)
      // key "UIApplicationLaunchOptionsUserActivityKey".
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType: userActivity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": userActivity,
      ]
    }

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions.isEmpty ? nil : launchOptions
    )
  }

  // Warm-app deep link (beebeeb://upload, exp+beebeeb://, share-extension handoff).
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }

  // Warm-app universal link (NSUserActivityTypeBrowsingWeb).
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }
}

// @beebeeb-ipad-window-controls (task 1588)
//
// On iPadOS 26+ this iPhone-only app runs in iPhone compatibility mode inside a
// system window, and the system draws the window controls (the close /
// minimise / tile "traffic lights") over the window's top-leading corner. The
// plain safe area does NOT include them: on an iPad Air 11" (M3), iPadOS 27,
// the controls sat on top of every screen title ("Drive", "Settings", the
// signup header logo). App Review tests on exactly that iPad.
//
// UIKit exposes the controls through the corner-adapted safe-area layout
// region: `.safeArea(cornerAdaptation: .vertical)` is the safe area pushed
// down past the controls. The difference between it and the plain safe area is
// how far the controls intrude, and we hand exactly that to the root view
// controller as `additionalSafeAreaInsets.top` — which every React Native
// screen already honours through react-native-safe-area-context. On an
// iPhone (no window controls) the two regions are equal, so the extra inset is
// 0 and nothing changes.
//
// Measured on the WINDOW (not on the root view), because the root view's own
// safe area already includes the additional inset we set — measuring there
// would feed back into itself and oscillate.
final class WindowControlsAwareWindow: UIWindow {
  override func layoutSubviews() {
    super.layoutSubviews()
    applyWindowControlsInset()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    applyWindowControlsInset()
  }

  private func applyWindowControlsInset() {
    guard let root = rootViewController else { return }
    let extra: CGFloat
    if #available(iOS 26.0, *) {
      extra = WindowControlsInset.extraTop(
        plainSafeAreaTop: safeAreaInsets.top,
        cornerAdaptedSafeAreaTop: edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top
      )
    } else {
      extra = 0
    }
    if root.additionalSafeAreaInsets.top != extra {
      root.additionalSafeAreaInsets.top = extra
    }
  }
}

enum WindowControlsInset {
  /// How far the window controls reach below the plain safe area (never negative).
  static func extraTop(plainSafeAreaTop: CGFloat, cornerAdaptedSafeAreaTop: CGFloat) -> CGFloat {
    return max(0, cornerAdaptedSafeAreaTop - plainSafeAreaTop)
  }
}
