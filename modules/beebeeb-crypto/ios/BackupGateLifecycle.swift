import Foundation

/// Task LD-0002 round 3: what feeds `BackupExecutionGate.shared` the app's
/// foreground/background state when the backup engine has not been built.
///
/// The gate is only as true as its feed. `NativeBackupEngine` drives it (grace
/// assertions, expiry quiesce, the foreground flag) once it exists, but the engine is
/// deliberately NOT built at launch (task 1669, the build-227 watchdog), and the File
/// Provider cache is used without it. So this small observer, started from
/// `BeebeebAppDelegate.application(_:didFinishLaunchingWithOptions:)`:
///
///   - SEEDS the gate from the real application state at launch (a cold launch in the
///     foreground opens it; one in the background closes it), so no cache call has to
///     build the engine or wait for one;
///   - reopens the gate on `willEnterForeground` / `didBecomeActive`;
///   - on `didEnterBackground`, acts ONLY when the engine is not built: it closes the
///     gate and quiesces what the engine does not own (`interrupt` / `waitForQuiet`:
///     the cache and the thumbnail queue). When the engine is built it keeps the whole
///     background sequence (grace assertion first, then the surface reads, then the
///     close): a second actor closing the gate earlier would interrupt the backup
///     batch on every app switch and re-sequence #262's tested path.
///
/// UIKit-free (notifications by name) so the Swift harness drives it.
public final class BackupGateLifecycle {
  public static let didEnterBackground = Notification.Name("UIApplicationDidEnterBackgroundNotification")
  public static let willEnterForeground = Notification.Name("UIApplicationWillEnterForegroundNotification")
  public static let didBecomeActive = Notification.Name("UIApplicationDidBecomeActiveNotification")
  // A scene-based app (this one) activates through its scene; the scene notifications reopen the gate too.
  public static let sceneWillEnterForeground = Notification.Name("UISceneWillEnterForegroundNotification")
  public static let sceneDidActivate = Notification.Name("UISceneDidActivateNotification")

  // MARK: The "engine built" flag

  private static let builtLock = NSLock()
  private static var built = false

  /// Set by `NativeBackupEngine.init`; never reset. A plain flag: this observer asks it, and
  /// never constructs the engine to find out.
  public static func noteEngineBuilt() {
    builtLock.lock()
    built = true
    builtLock.unlock()
  }

  public static var engineIsBuilt: Bool {
    builtLock.lock()
    defer { builtLock.unlock() }
    return built
  }

  // MARK: Instance

  private let gate: BackupExecutionGate
  private let center: NotificationCenter
  private let engineIsBuilt: () -> Bool
  private let interrupt: () -> Void
  private let waitForQuiet: (_ timeout: TimeInterval) -> Bool
  private let payOwedReset: () -> Void
  private var tokens: [NSObjectProtocol] = []
  private let lock = NSLock()

  public init(
    gate: BackupExecutionGate,
    center: NotificationCenter = .default,
    engineIsBuilt: @escaping () -> Bool = { BackupGateLifecycle.engineIsBuilt },
    interrupt: @escaping () -> Void,
    waitForQuiet: @escaping (_ timeout: TimeInterval) -> Bool,
    payOwedReset: @escaping () -> Void = {}
  ) {
    self.gate = gate
    self.center = center
    self.engineIsBuilt = engineIsBuilt
    self.interrupt = interrupt
    self.waitForQuiet = waitForQuiet
    self.payOwedReset = payOwedReset
  }

  /// Seeds the gate from the real state and starts following it. Call once, on the main
  /// thread, from `didFinishLaunching` (where `applicationState` is `.background` for a
  /// background launch). Idempotent.
  public func start(isBackground: Bool) {
    lock.lock()
    defer { lock.unlock() }
    gate.setForeground(!isBackground)
    // For the device check: a scene-based app can report `.background` at launch even for a user launch (it
    // then reopens on the scene's activation); this records what it reported.
    RuntimeTrace.event("gate.lifecycle_seed", ["background": isBackground])
    guard tokens.isEmpty else {
      if !isBackground { payOwedReset() }
      return
    }
    // Foreground: reopen the gate, then pay a cache reset the gate refused earlier (a sign-out in
    // the background, possibly in a previous launch) even when no cache writer runs. `payOwedReset`
    // moves off the main thread itself.
    let opened: (Notification) -> Void = { [gate, payOwedReset] _ in
      gate.setForeground(true)
      payOwedReset()
    }
    for name in [Self.willEnterForeground, Self.didBecomeActive, Self.sceneWillEnterForeground, Self.sceneDidActivate] {
      tokens.append(center.addObserver(forName: name, object: nil, queue: nil, using: opened))
    }
    if !isBackground { payOwedReset() }
    tokens.append(center.addObserver(forName: Self.didEnterBackground, object: nil, queue: nil) { [weak self] _ in
      self?.handleDidEnterBackground()
    })
  }

  /// True once `start` has registered the observers (tests: the handler under test is really attached).
  public var isFollowing: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !tokens.isEmpty
  }

  private func handleDidEnterBackground() {
    // The engine owns this sequence once it exists.
    guard !engineIsBuilt() else { return }
    gate.setForeground(false)
    // No engine, so no assertion can keep the gate open: it is closed. Quiesce before the app suspends.
    if !gate.canStartSQLiteWork {
      BackupSQLiteQuiesce.run(gate: gate, interrupt: interrupt, waitForQuiet: waitForQuiet)
    }
  }
}
