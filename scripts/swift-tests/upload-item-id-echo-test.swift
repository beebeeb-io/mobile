import Foundation

// Task SF-0001 (contract 2275 L13) — standalone swiftc unit test for
// `modules/beebeeb-crypto/ios/UploadItemIdEcho.swift`, the check the native
// backup engine runs on every init/completion answer it receives. No Xcode
// project, no simulator: the REAL shipped file is compiled in by
// `scripts/swift-ci/run-swift-tests.sh` (MANIFEST entry), never re-typed.
//
// Covers §7 row A7: an answer naming a different id aborts with the typed
// code and the plain sentence; an answer echoing the id this client chose
// passes.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let chosen = "abcdef01-2222-4333-8444-555555555555"

// A matching echo is accepted (create: the server echoes the client's id).
do {
  try UploadItemIdEcho.assertEchoedId(chosen: chosen, echoed: chosen)
  expect(true, "matching echo accepted")
} catch {
  expect(false, "matching echo accepted (threw \(error))")
}

// A DIFFERENT id aborts, typed, with the authored sentence.
do {
  try UploadItemIdEcho.assertEchoedId(chosen: chosen, echoed: "server-chosen-id")
  expect(false, "different echo aborted")
} catch let error as UploadItemIdEcho.Mismatch {
  expect(error.code == "server_changed_item_id", "mismatch carries the typed code")
  expect(
    error.localizedDescription == "The server answered with a different item. Nothing was uploaded under it.",
    "mismatch carries the plain sentence"
  )
} catch {
  expect(false, "different echo aborted (unexpected error \(error))")
}

// A missing id never matches (an answer that names nothing is not our id).
do {
  try UploadItemIdEcho.assertEchoedId(chosen: chosen, echoed: nil)
  expect(false, "missing echo aborted")
} catch is UploadItemIdEcho.Mismatch {
  expect(true, "missing echo aborted")
} catch {
  expect(false, "missing echo aborted (unexpected error \(error))")
}

// Case matters: the canonical id is lowercase and every reader derives keys
// from the exact string it proposes, so a differently-cased echo is a
// different string and must abort rather than silently seed the wrong key.
do {
  try UploadItemIdEcho.assertEchoedId(chosen: chosen, echoed: chosen.uppercased())
  expect(false, "differently-cased echo aborted")
} catch is UploadItemIdEcho.Mismatch {
  expect(true, "differently-cased echo aborted")
} catch {
  expect(false, "differently-cased echo aborted (unexpected error \(error))")
}

// MARK: - Report

if failures.isEmpty {
  print("UploadItemIdEchoTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("UploadItemIdEchoTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
