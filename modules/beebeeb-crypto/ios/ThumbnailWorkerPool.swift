import Foundation
import UIKit

// MARK: - ThumbnailWorkerPool

/// Concurrent thumbnail-regeneration engine backed by `NSOperationQueue`.
///
/// Six worker slots drain `ThumbnailQueueDB` items in priority order.
/// Thermal and foreground/background observers throttle or pause work
/// automatically so the device stays cool and battery-friendly.
///
/// This is a plain `NSObject` (not an actor) because `NSOperationQueue`
/// manages its own threading. All mutable state lives behind `stateLock`.
public final class ThumbnailWorkerPool: NSObject, @unchecked Sendable {
    public static let shared = ThumbnailWorkerPool()

    // MARK: - Constants

    private static let normalConcurrency = 6
    private static let seriousConcurrency = 2

    // MARK: - NSOperationQueue

    let queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "io.beebeeb.thumbnail.worker-pool"
        q.maxConcurrentOperationCount = normalConcurrency
        q.qualityOfService = .utility
        return q
    }()

    // MARK: - Worker slot tracking

    struct WorkerSlot {
        var fileId: String?
        var stage: String = "idle"
        var startedAt: Date?
    }

    private(set) var slots: [WorkerSlot] = Array(repeating: WorkerSlot(), count: normalConcurrency)
    let stateLock = NSLock()
    private(set) var paused: Bool = false
    private(set) var isThermalThrottled: Bool = false

    // MARK: - Rolling throughput window (30s)

    private struct CompletionEvent {
        let timestamp: Date
        let bytes: Int
    }

    private var completionWindow: [CompletionEvent] = []
    private let windowDuration: TimeInterval = 30.0

    // MARK: - Timer for onPoolStats emission

    private var statsTimer: DispatchSourceTimer?
    private let statsTimerQueue = DispatchQueue(label: "io.beebeeb.thumbnail.stats-timer")

    // MARK: - Callbacks (set by ThumbnailServiceModule)

    public var onWorkerStage: ((_ slot: Int, _ fileId: String, _ stage: String, _ elapsedMs: Int) -> Void)?
    public var onPoolStats: ((_ snapshot: PoolSnapshot) -> Void)?
    public var onFileCompleted: ((_ fileId: String, _ success: Bool, _ category: String?, _ totalMs: Int, _ stages: [String: Int]) -> Void)?
    public var onWorkerFailure: ((_ fileId: String, _ code: String, _ message: String, _ attempt: Int) -> Void)?
    public var onPoolStateChanged: ((_ state: String) -> Void)?

    // MARK: - PoolSnapshot

    public struct PoolSnapshot: Sendable {
        public struct Worker: Sendable {
            public let slot: Int
            public let fileId: String?
            public let stage: String
            public let elapsedMs: Int
        }
        public let workers: [Worker]
        public let completed: Int
        public let failed: Int
        public let retrying: Int
        public let queueDepth: Int
        public let filesPerSec: Double
        public let kbPerSec: Double
        public let etaSec: Double
        public let isPaused: Bool
        public let isThermalThrottled: Bool
    }

    // MARK: - Init

    private override init() {
        super.init()
    }

    // MARK: - Observers

    public func startObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(thermalStateChanged),
            name: ProcessInfo.thermalStateDidChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(willEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )

        // Apply current thermal state immediately
        thermalStateChanged()
    }

    @objc private func thermalStateChanged() {
        stateLock.lock()
        let thermal = ProcessInfo.processInfo.thermalState
        switch thermal {
        case .critical:
            paused = true
            isThermalThrottled = true
            queue.maxConcurrentOperationCount = Self.seriousConcurrency
            stateLock.unlock()
            queue.cancelAllOperations()
            onPoolStateChanged?("paused_thermal_critical")
        case .serious:
            isThermalThrottled = true
            queue.maxConcurrentOperationCount = Self.seriousConcurrency
            stateLock.unlock()
            onPoolStateChanged?("throttled_thermal_serious")
        default:
            isThermalThrottled = false
            queue.maxConcurrentOperationCount = Self.normalConcurrency
            stateLock.unlock()
        }
    }

    @objc private func didEnterBackground() {
        pause()
        onPoolStateChanged?("paused_background")
    }

    @objc private func willEnterForeground() {
        resume()
        onPoolStateChanged?("resumed_foreground")
    }

    // MARK: - Pause / Resume

    public func pause() {
        stateLock.lock()
        paused = true
        stateLock.unlock()
        queue.isSuspended = true
        stopStatsTimer()
    }

    public func resume() {
        stateLock.lock()
        paused = false
        stateLock.unlock()
        queue.isSuspended = false
        pump()
        startStatsTimerIfNeeded()
    }

    // MARK: - Enqueue

    public func enqueue(fileIds: [String], qualityPreset: String) {
        ThumbnailQueueDB.shared.enqueue(fileIds: fileIds, qualityPreset: qualityPreset)
        pump()
        startStatsTimerIfNeeded()
    }

    // MARK: - Cancel all

    public func cancelAll() {
        queue.cancelAllOperations()
        stateLock.lock()
        for i in 0..<slots.count {
            slots[i] = WorkerSlot()
        }
        stateLock.unlock()
        stopStatsTimer()
    }

    // MARK: - Snapshot

    public func snapshot() -> PoolSnapshot {
        stateLock.lock()
        let now = Date()
        let workerSnapshots = slots.enumerated().map { i, slot in
            PoolSnapshot.Worker(
                slot: i,
                fileId: slot.fileId,
                stage: slot.stage,
                elapsedMs: slot.startedAt.map { Int(now.timeIntervalSince($0) * 1000) } ?? 0
            )
        }
        let isPausedNow = paused
        let isThrottled = isThermalThrottled

        // Prune old events from throughput window
        let cutoff = now.addingTimeInterval(-windowDuration)
        completionWindow.removeAll { $0.timestamp < cutoff }

        let windowFiles = completionWindow.count
        let windowBytes = completionWindow.reduce(0) { $0 + $1.bytes }
        let windowSeconds = completionWindow.isEmpty ? 1.0 :
            max(1.0, now.timeIntervalSince(completionWindow.first!.timestamp))
        let filesPerSec = Double(windowFiles) / windowSeconds
        let kbPerSec = Double(windowBytes) / 1024.0 / windowSeconds

        stateLock.unlock()

        let stats = ThumbnailQueueDB.shared.stats()
        let remaining = stats.pending + stats.running + stats.failedRetry
        let effectiveThroughput = max(0.5, filesPerSec == 0 ? 8.0 : filesPerSec)
        let etaSec = Double(remaining) / effectiveThroughput

        return PoolSnapshot(
            workers: workerSnapshots,
            completed: stats.succeeded,
            failed: stats.failedPerm,
            retrying: stats.failedRetry,
            queueDepth: stats.pending,
            filesPerSec: filesPerSec,
            kbPerSec: kbPerSec,
            etaSec: etaSec,
            isPaused: isPausedNow,
            isThermalThrottled: isThrottled
        )
    }

    // MARK: - Slot management

    func claimSlot(fileId: String) -> Int? {
        stateLock.lock()
        defer { stateLock.unlock() }
        for i in 0..<slots.count {
            if slots[i].fileId == nil {
                slots[i] = WorkerSlot(fileId: fileId, stage: "starting", startedAt: Date())
                return i
            }
        }
        return nil
    }

    func releaseSlot(_ index: Int) {
        stateLock.lock()
        if index >= 0 && index < slots.count {
            slots[index] = WorkerSlot()
        }
        stateLock.unlock()
    }

    func updateStage(_ slotIndex: Int, _ stage: String) {
        stateLock.lock()
        let fileId: String?
        let elapsed: Int
        if slotIndex >= 0 && slotIndex < slots.count {
            slots[slotIndex].stage = stage
            fileId = slots[slotIndex].fileId
            elapsed = slots[slotIndex].startedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        } else {
            fileId = nil
            elapsed = 0
        }
        stateLock.unlock()
        if let fid = fileId {
            onWorkerStage?(slotIndex, fid, stage, elapsed)
        }
    }

    func recordCompletion(addedBytes: Int) {
        stateLock.lock()
        completionWindow.append(CompletionEvent(timestamp: Date(), bytes: addedBytes))
        stateLock.unlock()
    }

    // MARK: - Stats timer

    private func startStatsTimerIfNeeded() {
        guard statsTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: statsTimerQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let snap = self.snapshot()
            self.onPoolStats?(snap)
            // Stop timer when pool is idle
            if snap.queueDepth == 0 && snap.workers.allSatisfy({ $0.fileId == nil }) {
                self.stopStatsTimer()
            }
        }
        statsTimer = timer
        timer.resume()
    }

    private func stopStatsTimer() {
        statsTimer?.cancel()
        statsTimer = nil
    }

    // MARK: - Pump — drain SQLite queue into NSOperationQueue

    func pump() {
        stateLock.lock()
        let isPaused = paused
        stateLock.unlock()
        if isPaused { return }
        let capacity = queue.maxConcurrentOperationCount - queue.operationCount
        guard capacity > 0 else { return }
        let ready = ThumbnailQueueDB.shared.popReady(limit: capacity)
        guard !ready.isEmpty else { return }
        for item in ready {
            enqueueOperation(item: item)
        }
    }

    private func enqueueOperation(item: ThumbnailQueueDB.Item) {
        let op = AsyncOperation { [weak self] finish in
            guard let self else { finish(); return }
            await self.runOne(item: item)
            finish()
        }
        queue.addOperation(op)
    }

    /// Execute a single thumbnail regeneration pipeline with a 45-second deadline.
    private func runOne(item: ThumbnailQueueDB.Item) async {
        let slotIndex = self.claimSlot(fileId: item.fileId) ?? -1
        let startedAt = Date()
        var success = false
        var category: ThumbnailErrorCategory? = nil
        var errMsg = ""
        var bytes = 0
        var stages: [String: Int] = [:]

        do {
            self.updateStage(slotIndex, "photoKit")
            let result = try await self.runWithDeadline(seconds: 45) {
                try await ThumbnailService.shared.regenerateThumbnail(
                    fileId: item.fileId, qualityPreset: item.qualityPreset
                )
            }
            success = result.success
            bytes = result.bytesUploaded
            stages = result.stageTimings
        } catch let nsErr as NSError {
            let inferredStatus = nsErr.code >= 400 ? nsErr.code : nil
            category = ThumbnailErrorCategory.classify(error: nsErr, httpStatus: inferredStatus)
            errMsg = nsErr.localizedDescription
        } catch {
            category = .unknown
            errMsg = "\(error)"
        }

        let totalMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        if success {
            ThumbnailQueueDB.shared.markSucceeded(fileId: item.fileId)
            self.recordCompletion(addedBytes: bytes)
            self.onFileCompleted?(item.fileId, true, nil, totalMs, stages)
        } else {
            let cat = category ?? .unknown
            ThumbnailQueueDB.shared.recordFailure(fileId: item.fileId, category: cat, message: errMsg)
            self.onFileCompleted?(item.fileId, false, cat.rawValue, totalMs, stages)
            if !cat.isRetriable || item.attempts + 1 >= 3 {
                self.onWorkerFailure?(item.fileId, cat.rawValue, errMsg, item.attempts + 1)
            }
        }
        if slotIndex >= 0 { self.releaseSlot(slotIndex) }
        // Try to fill the slot we just freed
        self.pump()
    }

    /// Run an async body with a hard deadline. If the body doesn't finish in time,
    /// the deadline task throws a timeout error. Whichever completes first wins.
    private func runWithDeadline<T>(seconds: TimeInterval, _ body: @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw NSError(
                    domain: NSURLErrorDomain,
                    code: NSURLErrorTimedOut,
                    userInfo: [NSLocalizedDescriptionKey: "deadline exceeded (\(Int(seconds))s)"]
                )
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }
}

// MARK: - AsyncOperation

/// Custom `Operation` subclass that hosts Swift async work without blocking the
/// operation thread. Uses KVO-driven `isExecuting`/`isFinished` transitions so
/// `NSOperationQueue` can manage concurrency correctly.
///
/// This replaces the `BlockOperation` + `Task.detached` + `DispatchSemaphore`
/// pattern, which would block the operation thread for the full pipeline duration
/// and negate the queue's concurrency benefits.
public final class AsyncOperation: Operation, @unchecked Sendable {
    public override var isAsynchronous: Bool { true }

    private var _isExecuting = false
    private var _isFinished = false

    public override var isExecuting: Bool { _isExecuting }
    public override var isFinished: Bool { _isFinished }

    private let body: (@escaping () -> Void) async -> Void

    public init(body: @escaping (@escaping () -> Void) async -> Void) {
        self.body = body
        super.init()
    }

    public override func start() {
        if isCancelled {
            willChangeValue(forKey: "isFinished")
            _isFinished = true
            didChangeValue(forKey: "isFinished")
            return
        }
        willChangeValue(forKey: "isExecuting")
        _isExecuting = true
        didChangeValue(forKey: "isExecuting")

        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            await self.body { [weak self] in
                guard let self else { return }
                self.willChangeValue(forKey: "isFinished")
                self.willChangeValue(forKey: "isExecuting")
                self._isFinished = true
                self._isExecuting = false
                self.didChangeValue(forKey: "isFinished")
                self.didChangeValue(forKey: "isExecuting")
            }
        }
    }
}
