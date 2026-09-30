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
    // Pre-mortem 12 / task 0300 — exclude every plaintext + metadata path from
    // iCloud and Finder backups before any other subsystem can write to them.
    // Idempotent: repairs existing installs on their first launch of this build.
    PlaintextStorageProtection.hardenAll()

    // NativeBackupEngine is the active backup pipeline.
    // BGTaskScheduler.register must be called before didFinishLaunching returns.
    //
    // Task 1669 Issue 2 (watchdog on background launch, build 227): this
    // MUST stay a call that never touches `NativeBackupEngine.shared` —
    // doing so used to force the singleton's full `init()` (background
    // URLSession + SQLite setup) synchronously onto this exact call site,
    // which blocked the main thread past the 10s scene-create watchdog on
    // a locked, backgrounded relaunch and got the app SIGKILLed. See
    // `NativeBackupEngine.registerBackgroundTaskEarly()`'s doc comment for
    // the full symbolicated evidence. A guard test
    // (`app-delegate-launch-guard.test.ts`) fails if `.shared` is
    // reintroduced into this function.
    NativeBackupEngine.registerBackgroundTaskEarly()
    return true
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if identifier == NativeBackupEngine.bgSessionIdentifier {
      NativeBackupEngine.shared.handleBackgroundSessionEvents(
        identifier: identifier,
        completionHandler: completionHandler
      )
    }
  }
}
#endif
