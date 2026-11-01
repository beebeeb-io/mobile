import Foundation

// Task SF-0001 (contract 2275 L13, mobile#259 review M1) — the Contacts/Calendar
// backup create, `modules/beebeeb-crypto/ios/BackupCreateUploadFlow.swift`, the
// REAL shipped file (with UploadItemIdEcho.swift) compiled in by
// scripts/swift-ci/run-swift-tests.sh. `NativeEncryptedBackupUploader` runs
// exactly this flow; the network and the encryption are injected here.
//
//   f1  an init answer naming another id: zero PUTs, no complete, the
//       requested id abandoned, a typed Mismatch (so the caller records no
//       success and the backup retries)
//   f2  an init answer naming no id: the same
//   f3  every PUT and the complete go to the minted id, never to the answer's
//   f4  a completion answer naming another id: the completion Mismatch (no
//       success recorded)

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let minted = "0e6f2b9a-1c3d-4e5f-8a7b-6c5d4e3f2a1b"

final class Wire {
  var puts: [(Int, String)] = []
  var completes: [String] = []
  var abandons: [String] = []
  var beforeCompleteRuns = 0
}

func flow(_ wire: Wire, initAnswer: [String: Any], completeAnswer: [String: Any]? = nil, chunks: Int = 3) -> BackupCreateUploadFlow {
  BackupCreateUploadFlow(
    fileId: minted,
    chunkCount: chunks,
    initUpload: { initAnswer },
    putChunk: { index, destination in wire.puts.append((index, destination)) },
    beforeComplete: { wire.beforeCompleteRuns += 1 },
    complete: { destination in
      wire.completes.append(destination)
      return completeAnswer ?? ["id": destination]
    },
    abandon: { requested in wire.abandons.append(requested) }
  )
}

// f1
do {
  let wire = Wire()
  do {
    _ = try flow(wire, initAnswer: ["file_id": "server-chosen-id"]).run()
    expect(false, "f1: a mismatched init must throw")
  } catch let mismatch as UploadItemIdEcho.Mismatch {
    expect(mismatch.stage == .create, "f1: the create-stage mismatch")
  } catch {
    expect(false, "f1: unexpected error \(error)")
  }
  expect(wire.puts.isEmpty, "f1 (M1): zero chunk PUTs after a mismatched init (got \(wire.puts.count))")
  expect(wire.completes.isEmpty && wire.beforeCompleteRuns == 0, "f1 (M1): no complete")
  expect(wire.abandons == [minted], "f1 (M5): the REQUESTED id's session is abandoned (got \(wire.abandons))")
}

// f2
do {
  let wire = Wire()
  let ran = (try? flow(wire, initAnswer: ["upload": "ok"]).run()) != nil
  expect(!ran && wire.puts.isEmpty && wire.completes.isEmpty, "f2: an init naming no id sends nothing")
}

// f3
do {
  let wire = Wire()
  let landed = try? flow(wire, initAnswer: ["file_id": minted]).run()
  expect(landed == minted, "f3: lands under the minted id")
  expect(wire.puts.map(\.0) == [0, 1, 2], "f3: every chunk PUT, in order")
  expect(wire.puts.allSatisfy { $0.1 == minted }, "f3 (M1): every PUT goes to the minted id")
  expect(wire.completes == [minted] && wire.beforeCompleteRuns == 1, "f3: complete under the minted id, after the integrity guard")
  expect(wire.abandons.isEmpty, "f3: nothing abandoned")
}

// f4
do {
  let wire = Wire()
  do {
    _ = try flow(wire, initAnswer: ["file_id": minted], completeAnswer: ["id": "server-chosen-id"]).run()
    expect(false, "f4: a mismatched completion must throw")
  } catch let mismatch as UploadItemIdEcho.Mismatch {
    expect(mismatch.stage == .completion, "f4 (M1): the completion-stage mismatch, so no success is recorded")
  } catch {
    expect(false, "f4: unexpected error \(error)")
  }
}

if failures.isEmpty {
  print("backup-create-upload-flow: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("backup-create-upload-flow: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
