import Foundation

// Task 1962 round 5 (P2.6) — purge generation semantics. A worker that is
// already running when the purge happens must be unable to commit its result,
// and pump() must stay idle until the next account bind.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}

var gate = PurgeGenerationGate()
check(gate.allowsPump, "case1: a fresh pool may pump")
let capturedBeforePurge = gate.generation
check(gate.isCurrent(capturedBeforePurge), "case1: a fresh generation is current")

gate.purge()
check(!gate.allowsPump, "case2: a purge stops pump() until the next account bind")
check(!gate.isCurrent(capturedBeforePurge), "case2: a worker that started before the purge discards its result")

let capturedAfterPurge = gate.generation
check(!gate.isCurrent(capturedAfterPurge), "case2: even a post-purge generation is not commit-able while unbound")

gate.bind()
check(gate.allowsPump, "case3: the next account bind re-enables pump()")
check(gate.isCurrent(capturedAfterPurge), "case3: the new account's workers may commit")
check(!gate.isCurrent(capturedBeforePurge), "case3: the old account's in-flight worker still discards")

gate.purge()
check(!gate.isCurrent(capturedAfterPurge), "case4: a second purge invalidates the previous account too")

print("thumbnail-purge-generation: \(assertions) assertions, 0 failed")
