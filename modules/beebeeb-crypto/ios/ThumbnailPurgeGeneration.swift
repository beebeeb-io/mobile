import Foundation

/// Task 1962 round 5 (P2.6) — the purge generation.
///
/// `cancelAll()` cannot stop a worker that is already awaiting PhotoKit or the
/// upload. When that worker finishes it used to `markSucceeded`/`recordFailure`
/// and `pump()`, i.e. write for the previous account and start new work after
/// the purge. This gate gives every purge a new generation:
/// - `purge()` advances it (sign-out);
/// - `pump()` is idle until `bind()` (the next account enqueue);
/// - an operation captures `generation` when it starts and discards its result
///   unless `isCurrent(_:)` still holds.
///
/// Guarded by `ThumbnailWorkerPool.stateLock`; a value type so the pool owns
/// the synchronization in one place.
struct PurgeGenerationGate {
    private(set) var generation: UInt64 = 0
    private var boundGeneration: UInt64 = 0

    mutating func purge() {
        generation &+= 1
    }

    mutating func bind() {
        boundGeneration = generation
    }

    /// `pump()` may start work only while the pool is bound to the current
    /// generation (false from a purge until the next account bind).
    var allowsPump: Bool {
        boundGeneration == generation
    }

    func isCurrent(_ captured: UInt64) -> Bool {
        captured == generation && boundGeneration == generation
    }
}
