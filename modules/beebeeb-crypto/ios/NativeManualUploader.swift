import Foundation

// MARK: - Native manual upload (task 1310)
//
// Encrypts a file straight from disk with the shared beebeeb-core
// `ChunkEncryptorHandle.fromFile` and PUTs each `nonce || ciphertext || tag`
// frame to the storage-v2 upload session — the same streaming primitive the
// backup engine uses for videos. The JS side keeps the protocol bookkeeping
// (session init, resume state, complete, encrypted-name patch); this class only
// does the work that must not go through the JS heap: reading, encrypting and
// sending bytes. Plaintext never crosses the bridge, and progress is byte-level
// (URLSession `didSendBodyData`) instead of one tick per finished chunk.

/// Failure surfaced to JS. The description is a JSON envelope so the TS side
/// can rebuild an `ApiError` (HTTP status + machine code + message) — the same
/// triple the JS chunk uploader throws — instead of pattern-matching free text.
struct NativeUploadFailure: Error, LocalizedError {
  let status: Int
  let code: String?
  let message: String

  var errorDescription: String? {
    var body: [String: Any] = ["bb_upload_error": true, "status": status, "message": message]
    if let code { body["code"] = code }
    guard
      let data = try? JSONSerialization.data(withJSONObject: body),
      let text = String(data: data, encoding: .utf8)
    else { return message }
    return text
  }

  static let cancelled = NativeUploadFailure(status: 0, code: "cancelled", message: "Upload cancelled")
}

/// Live progress for one upload request. The module keeps one per `requestId`;
/// JS polls `getUploadProgressNative(requestId)` and reads the latest snapshot.
/// Also the per-task URLSession delegate, so byte counts come straight from
/// the transport.
final class NativeUploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let requestId: String
  private let lock = NSLock()
  private var snapshot: [String: Any]
  private var cancelled = false
  private var currentTask: URLSessionTask?
  private var bytesBeforeCurrentTask: Int64 = 0

  init(requestId: String) {
    self.requestId = requestId
    self.snapshot = [
      "requestId": requestId,
      "stage": "encrypting",
      "chunksUploaded": 0,
      "chunksTotal": 0,
      "bytesUploaded": 0,
      "bytesTotal": 0,
    ]
    super.init()
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func currentSnapshot() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return snapshot
  }

  func setTotals(chunksTotal: Int, bytesTotal: Int64) {
    lock.lock()
    snapshot["chunksTotal"] = chunksTotal
    snapshot["bytesTotal"] = bytesTotal
    lock.unlock()
  }

  /// Called right before a frame is PUT: fixes the byte offset the transport
  /// progress is added to.
  func beginChunk(bytesBefore: Int64, chunksUploaded: Int, cryptoBytesPerSec: Double?) {
    lock.lock()
    bytesBeforeCurrentTask = bytesBefore
    currentTask = nil
    snapshot["stage"] = "uploading"
    snapshot["chunksUploaded"] = chunksUploaded
    snapshot["bytesUploaded"] = bytesBefore
    if let cryptoBytesPerSec { snapshot["cryptoBytesPerSec"] = cryptoBytesPerSec }
    lock.unlock()
  }

  func update(stage: String, chunksUploaded: Int, bytesUploaded: Int64, cryptoBytesPerSec: Double?) {
    lock.lock()
    snapshot["stage"] = stage
    snapshot["chunksUploaded"] = chunksUploaded
    snapshot["bytesUploaded"] = bytesUploaded
    if let cryptoBytesPerSec { snapshot["cryptoBytesPerSec"] = cryptoBytesPerSec }
    lock.unlock()
  }

  func fail(_ message: String) {
    lock.lock()
    snapshot["stage"] = "error"
    snapshot["error"] = message
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let task = currentTask
    lock.unlock()
    task?.cancel()
  }

  // MARK: URLSessionTaskDelegate

  func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
    lock.lock()
    currentTask = task
    let shouldCancel = cancelled
    lock.unlock()
    if shouldCancel { task.cancel() }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    lock.lock()
    snapshot["bytesUploaded"] = bytesBeforeCurrentTask + totalBytesSent
    lock.unlock()
  }
}

/// The one 429 pause every manual upload in the process shares (the epic's
/// Client pause rule; the numbers mirror `rate_limit_wait_ms` in beebeeb-core
/// `retry.rs`). All methods are synchronous, so the lock never spans a
/// suspension point.
private final class ManualUploadRatePause: @unchecked Sendable {
  private static let floorMs: UInt64 = 2_000
  private static let capMs: UInt64 = 60_000
  private static let jitterPercent: UInt64 = 25

  private let lock = NSLock()
  private var pausedUntil: Date = .distantPast
  /// Consecutive pauses started without a non-429 answer in between.
  private var streak: UInt32 = 0

  /// How long a request must still wait before it may be sent (<= 0: go).
  func remaining() -> TimeInterval {
    lock.lock()
    defer { lock.unlock() }
    return pausedUntil.timeIntervalSinceNow
  }

  /// A 429 came back for a request sent at `sentAt`. Starts a pause unless
  /// one already covers it: a refusal that arrives while a pause runs, or for
  /// a request that left before the last pause ended, neither starts nor
  /// doubles one.
  func rateLimited(hintSeconds: UInt64?, sentAt: Date) {
    lock.lock()
    defer { lock.unlock() }
    if sentAt < pausedUntil { return }
    let waitMs = Self.waitMs(streak: streak, hintSeconds: hintSeconds, jitterPermille: UInt64.random(in: 0...1000))
    pausedUntil = Date().addingTimeInterval(Double(waitMs) / 1000)
    streak += 1
  }

  /// Any non-429 answer ends the run of refusals.
  func answered() {
    lock.lock()
    streak = 0
    lock.unlock()
  }

  /// `base = max(min(floor << streak, cap), hint)`, plus 0-25 % jitter on top.
  private static func waitMs(streak: UInt32, hintSeconds: UInt64?, jitterPermille: UInt64) -> UInt64 {
    let ladder = min(floorMs << UInt64(min(streak, 5)), capMs)
    let hintMs = min(hintSeconds ?? 0, NativeManualUploader.policyRefusalSeconds) * 1000
    let base = max(ladder, hintMs)
    return base + base * jitterPercent * min(jitterPermille, 1000) / 100_000
  }
}

final class NativeManualUploader {
  static let shared = NativeManualUploader()

  /// Chunk-plan profile handed to `beebeeb-core`; must match what JS sends to
  /// `/api/v1/uploads/init` (the plan is deterministic in size + profile, so the
  /// encryptor rebuilt here for a resumed upload lands on the same frames).
  private static let chunkProfile = "mobile"
  private static let maxAttemptsPerChunk = 4
  /// Minimum spacing between requests — the JS `rateLimitedFetch` files bucket.
  private static let requestSpacing: TimeInterval = 0.12
  /// AES-256-GCM frame overhead per chunk: 12-byte nonce + 16-byte tag.
  private static let frameOverheadBytes = 28
  /// A 429 whose wait hint is above this is a policy refusal, not a pause.
  fileprivate static let policyRefusalSeconds: UInt64 = 60
  /// One pause for every manual upload in the process, whichever instance
  /// sends the request.
  private static let ratePause = ManualUploadRatePause()

  struct Request {
    let masterKey: MasterKeyHandle
    let fileId: String
    let inputPath: String
    let apiUrl: String
    let token: String
    let uploadSessionId: String
    let chunkSizeBytes: UInt64
    let chunkCount: UInt64
    let startChunkIndex: UInt32
  }

  private let session: URLSession
  private let spacingLock = NSLock()
  private var lastRequestAt: Date = .distantPast

  init() {
    let config = URLSessionConfiguration.default
    // Task 1962 round 4 (Bug 6d): never let the manual uploader's responses
    // reach the shared HTTP cache.
    config.urlCache = nil
    config.timeoutIntervalForRequest = 60
    config.timeoutIntervalForResource = 6 * 60 * 60
    config.httpMaximumConnectionsPerHost = 2
    session = URLSession(configuration: config)
  }

  static func plan(fileSizeBytes: UInt64) throws -> ChunkPlanResult {
    try planChunks(fileSizeBytes: fileSizeBytes, profile: chunkProfile)
  }

  func upload(_ req: Request, progress: NativeUploadProgress) async throws -> [String: Any] {
    let encryptor = try ChunkEncryptorHandle.fromFile(
      masterKey: req.masterKey,
      fileId: req.fileId,
      inputPath: req.inputPath,
      profile: Self.chunkProfile
    )
    let plan = try encryptor.chunkPlan()
    guard plan.chunkSizeBytes == req.chunkSizeBytes, plan.chunkCount == req.chunkCount else {
      throw NativeUploadFailure(
        status: 0,
        code: "chunk_plan_mismatch",
        message: "Upload session was planned for \(req.chunkCount)×\(req.chunkSizeBytes) B but the file plans as \(plan.chunkCount)×\(plan.chunkSizeBytes) B"
      )
    }
    let bytesTotal = Int64(try encryptor.expectedTotalCiphertext())
    progress.setTotals(chunksTotal: Int(plan.chunkCount), bytesTotal: bytesTotal)

    let apiBase = req.apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    var bytesUploaded: Int64 = 0
    var chunksUploaded = Int(req.startChunkIndex)
    var cryptoPlainBytes: Int64 = 0
    var cryptoElapsed: TimeInterval = 0
    var cryptoRate: Double?

    while true {
      if progress.isCancelled { throw NativeUploadFailure.cancelled }
      let started = Date()
      guard let chunk = try encryptor.nextChunk() else { break }
      if chunk.index < req.startChunkIndex {
        // Resume: these frames are already on the server. The encryptor has to
        // walk them anyway so `finish()` can run its integrity guard.
        bytesUploaded += Int64(chunk.data.count)
        continue
      }
      cryptoElapsed += Date().timeIntervalSince(started)
      cryptoPlainBytes += Int64(max(0, chunk.data.count - Self.frameOverheadBytes))
      if cryptoElapsed > 0.05 { cryptoRate = Double(cryptoPlainBytes) / cryptoElapsed }

      progress.beginChunk(bytesBefore: bytesUploaded, chunksUploaded: chunksUploaded, cryptoBytesPerSec: cryptoRate)
      try await putChunk(
        frame: chunk.data,
        index: Int(chunk.index),
        uploadSessionId: req.uploadSessionId,
        token: req.token,
        apiBase: apiBase,
        progress: progress
      )
      bytesUploaded += Int64(chunk.data.count)
      chunksUploaded += 1
      progress.update(stage: "uploading", chunksUploaded: chunksUploaded, bytesUploaded: bytesUploaded, cryptoBytesPerSec: cryptoRate)
    }

    // Integrity guard (detects a source that shrank) BEFORE JS tells the server
    // the upload is complete.
    _ = try encryptor.finish()
    guard chunksUploaded == Int(plan.chunkCount) else {
      throw NativeUploadFailure(
        status: 0,
        code: "chunk_count_mismatch",
        message: "Encrypted \(chunksUploaded) of \(plan.chunkCount) planned chunks"
      )
    }
    progress.update(stage: "complete", chunksUploaded: chunksUploaded, bytesUploaded: bytesUploaded, cryptoBytesPerSec: cryptoRate)
    return [
      "chunksUploaded": chunksUploaded,
      "bytesUploaded": bytesUploaded,
      "bytesTotal": bytesTotal,
      "cryptoBytesPerSec": cryptoRate ?? 0,
    ]
  }

  // MARK: - Transport

  private func putChunk(
    frame: Data,
    index: Int,
    uploadSessionId: String,
    token: String,
    apiBase: String,
    progress: NativeUploadProgress
  ) async throws {
    guard let url = URL(string: "\(apiBase)/api/v1/uploads/\(uploadSessionId)/chunks/\(index)") else {
      throw NativeUploadFailure(status: 0, code: "invalid_url", message: "Invalid API URL")
    }
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.httpMethod = "PUT"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    var attempt = 0
    while true {
      attempt += 1
      if progress.isCancelled { throw NativeUploadFailure.cancelled }
      try await waitForRatePause(progress: progress)
      await enforceSpacing()
      do {
        let sentAt = Date()
        let (body, response) = try await session.upload(for: request, from: frame, delegate: progress)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if status != 429 { Self.ratePause.answered() }
        if (200..<300).contains(status) { return }
        let (code, message) = Self.parseErrorBody(body, status: status)
        if status == 429 {
          let hint = Self.rateLimitHintSeconds(http, body: body)
          // `banned`, or a wait above 60 s, is a policy refusal: no pause, no retry.
          if code == "banned" || (hint ?? 0) > Self.policyRefusalSeconds {
            throw NativeUploadFailure(status: status, code: code, message: message)
          }
          Self.ratePause.rateLimited(hintSeconds: hint, sentAt: sentAt)
          if attempt < Self.maxAttemptsPerChunk { continue }
          throw NativeUploadFailure(status: status, code: code, message: message)
        }
        if status >= 500 && attempt < Self.maxAttemptsPerChunk {
          try await Self.backoff(attempt: attempt, retryAfter: Self.retryAfterSeconds(http).map { min($0, 60) })
          continue
        }
        throw NativeUploadFailure(status: status, code: code, message: message)
      } catch let failure as NativeUploadFailure {
        throw failure
      } catch let urlError as URLError {
        if urlError.code == .cancelled || progress.isCancelled { throw NativeUploadFailure.cancelled }
        if attempt < Self.maxAttemptsPerChunk {
          try await Self.backoff(attempt: attempt, retryAfter: nil)
          continue
        }
        throw NativeUploadFailure(status: 0, code: "network", message: urlError.localizedDescription)
      }
    }
  }

  /// Holds the request until the shared 429 pause is over. Sleeps in short
  /// slices so a cancel is noticed, and re-reads the pause each time: another
  /// upload may have started one meanwhile.
  private func waitForRatePause(progress: NativeUploadProgress) async throws {
    while true {
      let remaining = Self.ratePause.remaining()
      if remaining <= 0 { return }
      if progress.isCancelled { throw NativeUploadFailure.cancelled }
      try await Task.sleep(nanoseconds: UInt64(min(remaining, 0.5) * 1_000_000_000))
    }
  }

  private func enforceSpacing() async {
    let wait = reserveRequestSlot()
    if wait > 0 {
      try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
    }
  }

  /// Synchronous so the lock never spans a suspension point. Returns how long
  /// the caller must wait before its request may go out.
  private func reserveRequestSlot() -> TimeInterval {
    spacingLock.lock()
    defer { spacingLock.unlock() }
    let wait = Self.requestSpacing - Date().timeIntervalSince(lastRequestAt)
    lastRequestAt = Date().addingTimeInterval(max(0, wait))
    return wait
  }

  private static func backoff(attempt: Int, retryAfter: TimeInterval?) async throws {
    let exponential = min(8.0, pow(2.0, Double(attempt - 1)))
    let delay = max(exponential, retryAfter ?? 0)
    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
  }

  private static func retryAfterSeconds(_ response: HTTPURLResponse?) -> TimeInterval? {
    guard let raw = response?.value(forHTTPHeaderField: "Retry-After") else { return nil }
    if let seconds = TimeInterval(raw.trimmingCharacters(in: .whitespaces)), seconds >= 0, seconds.isFinite {
      return seconds
    }
    return nil
  }

  /// The server's wait hint for a 429: the larger of the `Retry-After` header
  /// and the body's `retry_after`, in whole seconds (rounded up).
  private static func rateLimitHintSeconds(_ response: HTTPURLResponse?, body: Data) -> UInt64? {
    var hint = retryAfterSeconds(response)
    if
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let raw = (object["retry_after"] as? NSNumber)?.doubleValue,
      raw >= 0, raw.isFinite
    {
      hint = max(hint ?? 0, raw)
    }
    // Clamp before converting: anything above the refusal line is a refusal anyway.
    return hint.map { UInt64(min($0, 86_400).rounded(.up)) }
  }

  /// Server errors are `{ "error": <machine code>, "message": <human text> }`.
  private static func parseErrorBody(_ body: Data, status: Int) -> (code: String?, message: String) {
    let fallback = "Upload failed (HTTP \(status))"
    guard
      !body.isEmpty,
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    else { return (nil, fallback) }
    let code = object["error"] as? String
    let message = (object["message"] as? String) ?? code ?? fallback
    return (code, message)
  }
}
