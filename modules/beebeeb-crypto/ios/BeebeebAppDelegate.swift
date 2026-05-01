import ExpoModulesCore
#if os(iOS)
import BackgroundTasks
import UIKit

// Registered in expo-module.config.json under apple.appDelegateSubscribers.
// BGTaskScheduler.register must be called before applicationDidFinishLaunching returns.
public class BeebeebAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    PhotoBackupManager.shared.registerBackgroundTask()
    // Ensure background URLSession is created early so iOS can deliver pending events.
    PhotoBackupManager.shared.setupBackgroundSession()
    return true
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if identifier == PhotoBackupManager.bgSessionIdentifier {
      PhotoBackupManager.shared.handleBackgroundSessionEvents(
        identifier: identifier,
        completionHandler: completionHandler
      )
    }
  }
}
#endif
