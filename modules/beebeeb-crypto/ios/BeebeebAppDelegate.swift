import ExpoModulesCore
#if os(iOS)
import BackgroundTasks
import MetricKit
import UIKit

extension BackupGateLifecycle {
  /// What the lifecycle quiesces when the backup engine is not built: the cache and the thumbnail queue.
  static let shared = BackupGateLifecycle(
    gate: .shared,
    interrupt: {
      ThumbnailQueueDB.shared.interruptInFlightStatement()
      FileProviderCacheDB.shared.interruptInFlightStatements()
    },
    waitForQuiet: { timeout in
      BackupSQLiteQuiesce.waitForAll(timeout: timeout, [
        { ThumbnailQueueDB.shared.waitForQuiet(timeout: $0) },
        { FileProviderCacheDB.shared.waitForQuiet(timeout: $0) },
      ])
    },
    payOwedReset: {
      DispatchQueue.global(qos: .utility).async { settleOwedFileProviderCacheReset() }
    }
  )
}

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
    URLCache.shared = LegacyURLCacheCleanup.zeroCapacityURLCache(directoryName: "bb-no-http-cache")
    // OFF the main thread (task 1669 launch-watchdog lesson): drop what older
    // builds stored in the DEFAULT cache directory by opening a separate
    // instance on it and removing its responses. After the assignment above,
    // nothing new is ever written there.
    LegacyURLCacheCleanup.clearLegacyDefaultStoreOffMainThread()

    // Pre-mortem 12 / task 0300 — exclude every plaintext + metadata path from
    // iCloud and Finder backups before any other subsystem can write to them.
    // Idempotent: repairs existing installs on their first launch of this build.
    PlaintextStorageProtection.hardenAll()

    // LD-0002 round 3: seed the background execution gate from the REAL application state
    // (a background launch starts closed) and follow it, so the File Provider cache works
    // without the backup engine, which is not built at launch. Cheap: one flag and three
    // observers; it touches no database and never `NativeBackupEngine.shared`.
    BackupGateLifecycle.shared.start(isBackground: application.applicationState == .background)

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
    // Run diagnostics: a handful of observer registrations, no I/O beyond one UserDefaults read.
    RunDiagnostics.start()
    return true
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

/// Facts about how the previous run ended, kept in UserDefaults for the JS run log. Only plain
/// numbers are stored: no file names, ids, paths or stack frames.
///
/// - `cleanExit` is set when iOS posts `willTerminate`. iOS rarely sends that for an app that
///   was suspended in the background, so a missing marker after a background run means "killed
///   while in the background", which JS infers.
/// - MetricKit delivers crash diagnostics some time after the launch that follows a crash; they
///   are kept until JS consumes them.
enum RunDiagnostics {
  private static let cleanExitKey = "io.beebeeb.runDiag.cleanExit"
  private static let crashesKey = "io.beebeeb.runDiag.crashes"
  private static let maxStoredCrashes = 5
  private static let lock = NSLock()
  private static var previousCleanExit = false
  private static var started = false
  private static var subscriber: AnyObject?

  static func start() {
    lock.lock()
    defer { lock.unlock() }
    guard !started else { return }
    started = true
    let defaults = UserDefaults.standard
    previousCleanExit = defaults.bool(forKey: cleanExitKey)
    defaults.set(false, forKey: cleanExitKey)
    NotificationCenter.default.addObserver(
      forName: UIApplication.willTerminateNotification, object: nil, queue: nil
    ) { _ in
      UserDefaults.standard.set(true, forKey: cleanExitKey)
      UserDefaults.standard.synchronize()
    }
    if #available(iOS 14.0, *) {
      let metricSubscriber = RunDiagnosticsMetricSubscriber()
      subscriber = metricSubscriber
      MXMetricManager.shared.add(metricSubscriber)
    }
  }

  /// The previous run's facts. The crash list is cleared once read.
  static func consumePreviousRun() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let defaults = UserDefaults.standard
    let crashes = defaults.array(forKey: crashesKey) as? [[String: Int]] ?? []
    defaults.removeObject(forKey: crashesKey)
    return ["cleanExit": previousCleanExit, "crashes": crashes]
  }

  static func storeCrashes(_ crashes: [[String: Int]]) {
    guard !crashes.isEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    let defaults = UserDefaults.standard
    let existing = defaults.array(forKey: crashesKey) as? [[String: Int]] ?? []
    defaults.set(Array((existing + crashes).suffix(maxStoredCrashes)), forKey: crashesKey)
  }

  /// `phys_footprint` of this process in bytes (what iOS compares with the memory limit), or 0.
  static func physFootprintBytes() -> Int64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
  }
}

@available(iOS 14.0, *)
private final class RunDiagnosticsMetricSubscriber: NSObject, MXMetricManagerSubscriber {
  func didReceive(_ payloads: [MXMetricPayload]) {}

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    var crashes: [[String: Int]] = []
    for payload in payloads {
      for crash in payload.crashDiagnostics ?? [] {
        var entry: [String: Int] = [:]
        if let exceptionType = crash.exceptionType { entry["exceptionType"] = exceptionType.intValue }
        if let signal = crash.signal { entry["signal"] = signal.intValue }
        crashes.append(entry)
      }
    }
    RunDiagnostics.storeCrashes(crashes)
  }
}
#endif
