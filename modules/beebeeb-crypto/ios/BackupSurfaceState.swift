import Foundation

/// Task 1667 round 13 (review of mobile#182 at a19037f9, item 6, honest
/// status surfaces).
///
/// The camera-roll state every status surface shows (the widget's
/// `backupStatus`, the Live Activity, the backup heartbeat), decided from the
/// engine's state. Moved here unchanged from
/// `NativeBackupEngine.backupState(pending:)` / `heartbeatStatus(for:)`, plus
/// one rule: while uploads are held on the server check
/// (`ServerCheckPause`), the state is that pause, not "Preparing backup".
/// Before, the pause reached the surfaces once, as an explicit reason; the
/// next plain update (no reason) fell back to "preparing" / "Preparing
/// backup" / heartbeat "syncing", so every surface but Settings said backup
/// was running while nothing uploaded.
///
/// Pure, so `scripts/swift-tests/backup-surface-state-test.swift` drives it.
enum BackupSurfaceState {
  /// One surface state: the machine state string the widget and the Live
  /// Activity switch on, and the line they show.
  struct State: Equatable {
    let state: String
    let reason: String
  }

  struct Inputs {
    /// `manifestUnavailableStopReason` (round 6).
    var manifestUnavailableReason: String?
    /// `ServerCheckPause.surface` (round 13): nil while uploads are not
    /// held on the server check.
    var serverCheckPause: State?
    var isPaused: Bool
    var pending: Int
    var canExecuteNow: Bool
    var isRunning: Bool
    var failed: Int
    var inProgress: Int
    var networkAvailable: Bool
    var total: Int
    /// Rows in 'uploading' (read only when it decides between "uploading"
    /// and "preparing").
    var uploading: () -> Int
  }

  static func decide(_ i: Inputs) -> State {
    // Task 1667 round 6: an engine that could not open its manifest is not
    // "ready" or "complete"; say what is.
    if let manifestReason = i.manifestUnavailableReason {
      return State(state: "needsAttention", reason: manifestReason)
    }
    if i.isPaused {
      return State(state: "pausedByUser", reason: "Backup paused")
    }
    // Round 13 (item 6): uploads held on the server check, on every update
    // (the pause lives in the engine's state, not in a one-shot reason).
    if let paused = i.serverCheckPause, i.pending > 0 || i.inProgress > 0 {
      return paused
    }
    if i.pending > 0, !i.canExecuteNow {
      return State(state: "waitingForAppOpen", reason: "Open Beebeeb to continue")
    }
    if !i.isRunning && i.pending > 0 {
      return State(state: "idle", reason: "Backup ready")
    }
    if i.failed > 0 && i.pending == 0 && i.inProgress == 0 {
      return State(state: "needsAttention", reason: "Some items need attention")
    }
    // (The engine passes `networkAvailable: true` off iOS, as its old
    // `#if os(iOS)` block did.)
    if !i.networkAvailable && i.pending > 0 {
      return State(state: "waitingForWifi", reason: "Waiting for connection")
    }
    if i.isRunning && (i.pending > 0 || i.inProgress > 0) {
      if i.inProgress > 0 || i.uploading() > 0 {
        return State(state: "uploading", reason: "Uploading")
      }
      return State(state: "preparing", reason: "Preparing backup")
    }
    if i.total > 0 && i.pending == 0 && i.inProgress == 0 {
      return State(state: "complete", reason: "Backup complete")
    }
    return State(state: "idle", reason: "Nothing to back up")
  }

  /// Collapse the engine's internal state to the 4-state shape the JS
  /// `BackupRunState` (src/lib/backup-bridge.ts) defines. Fine-grained
  /// reasons like `waitingForWifi` map to `paused` because the user-visible
  /// behaviour ("not making progress, will resume") is identical. Moved here
  /// from `NativeBackupEngine.mapBridgeState` (task 1667 round 14, review of
  /// mobile#182 at 18312919): "paused" (the server-check pause, round 13) is
  /// a pause, and every state `decide` returns has its own case.
  static func bridgeRunState(_ internalState: String) -> String {
    switch internalState {
    case "uploading", "preparing":
      return "running"
    case "pausedByUser", "paused", "waitingForAppOpen", "waitingForWifi":
      return "paused"
    case "needsAttention":
      return "error"
    case "idle", "complete":
      return "idle"
    default:
      return "idle"
    }
  }

  /// The heartbeat's status for a surface state. Round 13: "paused" (the
  /// server-check pause) is a pause, never "syncing" or "idle".
  static func heartbeatStatus(state: String, isRunning: Bool, failed: Int, pending: Int) -> String {
    switch state {
    case "uploading", "preparing":
      return "syncing"
    case "pausedByUser", "paused", "waitingForAppOpen", "waitingForWifi":
      return "paused"
    case "needsAttention":
      return "error"
    case "complete", "idle":
      return isRunning ? "watching" : "idle"
    default:
      return failed > 0 && pending == 0 ? "error" : "idle"
    }
  }
}

extension ServerCheckPause {
  /// Round 13 (review of mobile#182 at a19037f9, item 6): what the widget,
  /// the Live Activity and the heartbeat show while paused, on EVERY status
  /// update (`BackupSurfaceState.decide`). A server without `backed_up` and a
  /// failed check are "paused" (the widget and Live Activity say "Paused",
  /// the heartbeat "paused"); a missing device id needs the app opened, so it
  /// is "waitingForAppOpen" with its own line. nil while not paused.
  var surface: BackupSurfaceState.State? {
    switch cause {
    case .serverLacksBackedUp?: return BackupSurfaceState.State(state: "paused", reason: Self.serverLacksBackedUpMessage)
    case .checkFailed?: return BackupSurfaceState.State(state: "paused", reason: Self.checkFailedMessage)
    case .noDeviceId?: return BackupSurfaceState.State(state: "waitingForAppOpen", reason: Self.noDeviceIdMessage)
    case nil: return nil
    }
  }
}
