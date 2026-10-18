import Darwin
import Foundation

// Task 1667 round 13 (review of mobile#182 at a19037f9, item 6) — standalone
// swiftc test for `BackupSurfaceState` and `ServerCheckPause.surface`,
// compiled with the REAL shipped sources by scripts/swift-ci/run-swift-tests.sh.
//
// The bug: while camera-roll uploads were held on the server check (no
// `backed_up` on the server, a failing /check, no device id), the pause
// reached the status surfaces ONCE, as an explicit reason. Every later plain
// update (`updateBackupStatusSurfaces()` with no reason) decided the state
// from scratch without it: "preparing" / "Preparing backup", heartbeat
// "syncing". The widget, the Live Activity and the heartbeat said backup was
// running while nothing uploaded.
//
// `payload(...)` is `NativeBackupEngine.makeBackupStatusPayload` minus the
// counters: the state comes from `BackupSurfaceState.decide` with the
// engine's stored pause (`ServerCheckPause.surface`), the line is the
// explicit reason when one is given, else the decided one.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

/// A running engine with 12 rows waiting to encrypt, nothing uploading.
func inputs(pause: ServerCheckPause) -> BackupSurfaceState.Inputs {
  BackupSurfaceState.Inputs(
    manifestUnavailableReason: nil,
    serverCheckPause: pause.surface,
    isPaused: false,
    pending: 12,
    canExecuteNow: true,
    isRunning: true,
    failed: 0,
    inProgress: 0,
    networkAvailable: true,
    total: 40,
    uploading: { 0 }
  )
}

func payload(_ i: BackupSurfaceState.Inputs, reason explicitReason: String? = nil) -> (state: String, reason: String, heartbeat: String) {
  let d = BackupSurfaceState.decide(i)
  return (d.state, explicitReason ?? d.reason,
          BackupSurfaceState.heartbeatStatus(state: d.state, isRunning: i.isRunning, failed: i.failed, pending: i.pending))
}

// MARK: - (s1, s2) server without backed_up: paused on every update

do {
  var pause = ServerCheckPause()
  pause.record(.serverLacksBackedUp)
  // The publish (once per change) carries the message explicitly ...
  let published = payload(inputs(pause: pause), reason: pause.stopReason)
  expect(published.state == "paused", "s1: the published update is 'paused' (got \(published.state))")
  // ... and the plain updates after it (no reason) keep saying so.
  for n in 1...3 {
    let plain = payload(inputs(pause: pause))
    expect(plain.state == "paused", "s2.\(n): a plain update stays 'paused', not 'preparing' (got \(plain.state))")
    expect(plain.reason == ServerCheckPause.serverLacksBackedUpMessage, "s2.\(n): with the pause line, not 'Preparing backup' (got \(plain.reason))")
    expect(plain.heartbeat == "paused", "s2.\(n): the heartbeat says 'paused', not 'syncing' (got \(plain.heartbeat))")
  }
}

// MARK: - (s3) a failed /check; (s4) no device id

do {
  var pause = ServerCheckPause()
  pause.record(.checkFailed)
  let p = payload(inputs(pause: pause))
  expect(p.state == "paused" && p.reason == ServerCheckPause.checkFailedMessage && p.heartbeat == "paused",
         "s3: a failed check is paused with its line (got \(p))")
  var noId = ServerCheckPause()
  noId.record(.noDeviceId)
  let q = payload(inputs(pause: noId))
  expect(q.state == "waitingForAppOpen" && q.reason == ServerCheckPause.noDeviceIdMessage && q.heartbeat == "paused",
         "s4: no device id asks for the app to be opened (got \(q))")
}

// MARK: - (s5-s8) the other rules are unchanged

do {
  var pause = ServerCheckPause()
  pause.record(.serverLacksBackedUp)
  var i = inputs(pause: pause)
  i.manifestUnavailableReason = "Backup paused: the backup list could not be opened."
  expect(payload(i).state == "needsAttention", "s5: an unopenable manifest still wins")
  i.manifestUnavailableReason = nil
  i.isPaused = true
  expect(payload(i).state == "pausedByUser", "s6: the user's pause still wins")
  // Cleared (a check answered): back to the ordinary state.
  pause.clear()
  let cleared = payload(inputs(pause: pause))
  expect(cleared.state == "preparing" && cleared.heartbeat == "syncing", "s7: once cleared, preparing again (got \(cleared))")
  // Nothing left to upload: complete, whatever a stale pause says.
  var done = inputs(pause: { var p = ServerCheckPause(); p.record(.checkFailed); return p }())
  done.pending = 0
  expect(payload(done).state == "complete", "s8: a finished backup is complete, not paused")
}

// MARK: - (s9) honest copy, no emoji

do {
  for message in [ServerCheckPause.serverLacksBackedUpMessage, ServerCheckPause.checkFailedMessage, ServerCheckPause.noDeviceIdMessage] {
    let emoji = message.unicodeScalars.filter { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x2000) }
    expect(emoji.isEmpty, "s9: no emoji in '\(message)'")
    expect(message.hasPrefix("Backup paused"), "s9: the line says it is paused")
  }
}

if failures.isEmpty {
  print("BackupSurfaceStateTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("BackupSurfaceStateTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
