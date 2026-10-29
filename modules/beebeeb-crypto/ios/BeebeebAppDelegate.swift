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
    // Task 1962 round 4 (Bug 6a) — RN's networking session is built from
    // `defaultSessionConfiguration` on the first request and therefore uses
    // `URLCache.shared`, which by default persists API responses (with the
    // previous account's ids) in Library/Caches. Give the process a
    // zero-capacity shared cache backed by an explicit app-specific
    // directory. Main thread does exactly ONE thing here: the assignment.
    // Never read the `URLCache.shared` getter first, and do no file I/O.
    URLCache.shared = Self.zeroCapacityURLCache(directoryName: "bb-no-http-cache")
    // OFF the main thread (task 1669 launch-watchdog lesson): drop what older
    // builds stored in the DEFAULT cache directory by opening a separate
    // instance on it and removing its responses. After the assignment above,
    // nothing new is ever written there.
    DispatchQueue.global(qos: .utility).async {
      URLCache(memoryCapacity: 0, diskCapacity: 0, directory: nil).removeAllCachedResponses()
    }

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

  /// Task 1962 round 4 (Bug 6a/6c): a `URLCache` that stores nothing in memory
  /// or on disk, rooted at an explicit per-caller directory under `Caches/`
  /// (never the shared default directory, and never created on the caller's
  /// thread: with a zero disk capacity there is nothing to write). Extensions
  /// call this with their own directory name.
  static func zeroCapacityURLCache(directoryName: String) -> URLCache {
    let cachesDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    let directory = cachesDirectory?.appendingPathComponent(directoryName, isDirectory: true)
    return URLCache(memoryCapacity: 0, diskCapacity: 0, directory: directory)
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard identifier == NativeBackupEngine.bgSessionIdentifier else { return }
    // Task 1669 round 2: this callback runs on the MAIN thread inside the launch window the
    // scene-create watchdog polices, so it must not construct `NativeBackupEngine.shared` (its
    // init() builds the background URLSession: the proven 10 s XPC stall of build 227).
    //
    // 1. Main thread, cheap, FIRST: stash the completion handler. Nothing is lost by doing it
    //    before the engine exists: iOS holds the pending delegate events until a session with
    //    this identifier is recreated, and the handler is what tells iOS we are done with them.
    NativeBackupEngine.stashBackgroundSessionCompletionHandler(completionHandler)
    // 2. Background queue: construct the engine. init() recreates the background session with
    //    the same identifier (delegate = the engine); iOS then delivers the events, and
    //    `urlSessionDidFinishEvents(forBackgroundURLSession:)` calls the stashed handler on the
    //    main queue. A guard test (`app-delegate-launch-guard.test.ts`) fails if `.shared` is
    //    touched synchronously here or the stash moves behind the hop.
    DispatchQueue.global(qos: .userInitiated).async {
      NativeBackupEngine.reattachBackgroundSessionForPendingEvents()
    }
  }
}
#endif
