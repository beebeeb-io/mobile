import Foundation
import Network
import Security

struct NativeVideoStreamStart {
  let streamUri: String
  let outputUri: String
  let outputPath: String
  let plaintextSize: Int64
  let chunkCount: Int
  let streamId: String
}

final class NativeVideoStreamProgress: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private let requestId: String
  private let fileId: String
  private let emit: ([String: Any]) -> Void

  init(requestId: String, fileId: String, emit: @escaping ([String: Any]) -> Void) {
    self.requestId = requestId
    self.fileId = fileId
    self.emit = emit
  }

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }

  func isCancelled() -> Bool {
    lock.lock()
    let value = cancelled
    lock.unlock()
    return value
  }

  func emitDownload(bytesWritten: Int64, bytesExpected: Int64) {
    emitProgress(stage: "downloading", bytesDownloaded: max(0, bytesWritten), bytesTotal: bytesExpected > 0 ? bytesExpected : 0)
  }

  func emitProgress(
    stage: String,
    bytesDownloaded: Int64? = nil,
    bytesTotal: Int64? = nil,
    chunksCompleted: Int? = nil,
    chunksTotal: Int? = nil,
    extra: [String: Any] = [:]
  ) {
    var body: [String: Any] = ["requestId": requestId, "fileId": fileId, "stage": stage]
    if let bytesDownloaded { body["bytesDownloaded"] = bytesDownloaded }
    if let bytesTotal { body["bytesTotal"] = bytesTotal }
    if let chunksCompleted { body["chunksCompleted"] = chunksCompleted }
    if let chunksTotal { body["chunksTotal"] = chunksTotal }
    for (key, value) in extra { body[key] = value }
    emit(body)
  }

  func onComplete() {
    emitProgress(stage: "complete")
  }

  func onError(_ error: String) {
    emitProgress(stage: "error", extra: ["error": error])
  }
}

enum NativeVideoStreamer {
  static func start(
    requestId: String,
    master: MasterKeyHandle,
    apiUrl: String,
    token: String,
    fileId: String,
    outputUri: String,
    declaredSizeBytes: Int64?,
    declaredChunkCount: Int?,
    progress: NativeVideoStreamProgress,
    onTerminal: @escaping () -> Void
  ) throws -> NativeVideoStreamStart {
    guard !PlaintextStorageProtection.isPurgePending() else {
      throw streamError("Plaintext purge is pending")
    }
    let session = try NativeVideoStreamSession(
      requestId: requestId,
      master: master,
      apiUrl: apiUrl,
      token: token,
      fileId: fileId,
      outputUrl: streamFileURL(fromURI: outputUri),
      declaredSizeBytes: declaredSizeBytes,
      declaredChunkCount: declaredChunkCount,
      progress: progress,
      onTerminal: onTerminal
    )
    NativeVideoStreamRegistry.shared.register(session)
    if PlaintextStorageProtection.isPurgePending() {
      session.cancel()
      throw streamError("Plaintext purge is pending")
    }
    do {
      let start = try session.start()
      if PlaintextStorageProtection.isPurgePending() {
        session.cancel()
        throw streamError("Plaintext purge is pending")
      }
      return start
    } catch {
      session.failAndWait(error.localizedDescription)
      throw error
    }
  }

  @discardableResult
  static func cancel(requestId: String) -> Bool {
    NativeVideoStreamRegistry.shared.cancel(requestId: requestId)
  }

  @discardableResult
  static func cancel(streamId: String) -> Bool {
    NativeVideoStreamRegistry.shared.cancel(streamId: streamId)
  }

  static func cancelAll() {
    NativeVideoStreamRegistry.shared.cancelAll()
  }
}

private enum NativeVideoChunkMath {
  static let nonceBytes = 12
  static let tagBytes = 16
  static let overheadBytes = nonceBytes + tagBytes

  static func validate(chunkCount: Int, plaintextChunkSize: Int64, originalSize: Int64) throws {
    guard chunkCount > 0, originalSize > 0 else { throw streamError("Streaming requires positive size and chunk count") }
    guard chunkCount < 1_000_000 else { throw streamError("Streaming chunk count is out of bounds") }
    if chunkCount == 1 {
      guard plaintextChunkSize == originalSize else { throw streamError("Single-chunk stream metadata is inconsistent") }
      return
    }
    guard plaintextChunkSize > 0 else { throw streamError("Streaming requires a positive chunk size") }
    let wire = plaintextChunkSize.addingReportingOverflow(Int64(overheadBytes))
    guard !wire.overflow else { throw streamError("Streaming chunk metadata overflowed") }
    let encryptedOffsetMax = wire.partialValue.multipliedReportingOverflow(by: Int64(chunkCount - 1))
    guard !encryptedOffsetMax.overflow else { throw streamError("Streaming chunk metadata overflowed") }
    let multiplied = plaintextChunkSize.multipliedReportingOverflow(by: Int64(chunkCount - 1))
    guard !multiplied.overflow else { throw streamError("Streaming chunk metadata overflowed") }
    let minimum = multiplied.partialValue
    let maximum = minimum.addingReportingOverflow(plaintextChunkSize)
    guard !maximum.overflow else { throw streamError("Streaming chunk metadata overflowed") }
    guard minimum < originalSize, originalSize <= minimum + plaintextChunkSize else {
      throw streamError("Streaming chunk metadata is inconsistent")
    }
  }

  static func plaintextSize(index: Int, chunkCount: Int, plaintextChunkSize: Int64, originalSize: Int64) -> Int64 {
    if chunkCount == 1 { return originalSize }
    return index == chunkCount - 1 ? originalSize - plaintextChunkSize * Int64(chunkCount - 1) : plaintextChunkSize
  }

  static func encryptedSize(index: Int, chunkCount: Int, plaintextChunkSize: Int64, originalSize: Int64) -> Int64 {
    plaintextSize(index: index, chunkCount: chunkCount, plaintextChunkSize: plaintextChunkSize, originalSize: originalSize)
      + Int64(overheadBytes)
  }

  static func originalSize(chunkCount: Int, plaintextChunkSize: Int64, tailWireSize: Int64) throws -> Int64 {
    let tailPlain = tailWireSize - Int64(overheadBytes)
    guard tailPlain > 0 else { throw streamError("Tail chunk is too small") }
    if chunkCount == 1 { return tailPlain }
    let multiplied = plaintextChunkSize.multipliedReportingOverflow(by: Int64(chunkCount - 1))
    guard !multiplied.overflow else { throw streamError("Streaming size inference overflowed") }
    let added = multiplied.partialValue.addingReportingOverflow(tailPlain)
    guard !added.overflow else { throw streamError("Streaming size inference overflowed") }
    return added.partialValue
  }

  static func declaredSizeMatches(_ declared: Int64?, originalSize: Int64, chunkCount: Int) -> Bool {
    guard let declared else { return true }
    if declared == originalSize { return true }
    let overhead = Int64(overheadBytes).multipliedReportingOverflow(by: Int64(chunkCount))
    guard !overhead.overflow else { return false }
    let ciphertextTotal = originalSize.addingReportingOverflow(overhead.partialValue)
    return !ciphertextTotal.overflow && declared == ciphertextTotal.partialValue
  }

  static func plainOffset(index: Int, plaintextChunkSize: Int64) -> Int64 {
    Int64(index) * plaintextChunkSize
  }

  static func encryptedOffset(index: Int, chunkCount: Int, plaintextChunkSize: Int64, originalSize: Int64) -> Int64 {
    guard chunkCount > 1 else { return 0 }
    let fullWireSize = plaintextChunkSize + Int64(overheadBytes)
    let offset = fullWireSize.multipliedReportingOverflow(by: Int64(index))
    return offset.overflow ? Int64.max : offset.partialValue
  }

  static func chunkIndex(for position: Int64, chunkCount: Int, plaintextChunkSize: Int64) -> Int {
    if chunkCount <= 1 || plaintextChunkSize <= 0 { return 0 }
    return min(chunkCount - 1, max(0, Int(position / plaintextChunkSize)))
  }
}

private final class NativeVideoStreamRegistry: @unchecked Sendable {
  static let shared = NativeVideoStreamRegistry()
  private let lock = NSLock()
  private var sessionsByStreamId: [String: NativeVideoStreamSession] = [:]
  private var streamIdByRequestId: [String: String] = [:]

  func register(_ session: NativeVideoStreamSession) {
    lock.lock()
    sessionsByStreamId[session.streamId] = session
    streamIdByRequestId[session.requestId] = session.streamId
    lock.unlock()
  }

  func session(streamId: String) -> NativeVideoStreamSession? {
    lock.lock()
    let value = sessionsByStreamId[streamId]
    lock.unlock()
    return value
  }

  func unregister(streamId: String, requestId: String) {
    lock.lock()
    sessionsByStreamId.removeValue(forKey: streamId)
    if !requestId.isEmpty {
      streamIdByRequestId.removeValue(forKey: requestId)
    } else if let match = streamIdByRequestId.first(where: { $0.value == streamId }) {
      streamIdByRequestId.removeValue(forKey: match.key)
    }
    lock.unlock()
  }

  @discardableResult
  func cancel(requestId: String) -> Bool {
    lock.lock()
    let session = streamIdByRequestId[requestId].flatMap { sessionsByStreamId[$0] }
    lock.unlock()
    session?.cancel()
    return session != nil
  }

  @discardableResult
  func cancel(streamId: String) -> Bool {
    lock.lock()
    let session = sessionsByStreamId[streamId]
    lock.unlock()
    session?.cancel()
    return session != nil
  }

  func cancelAll() {
    lock.lock()
    let sessions = Array(sessionsByStreamId.values)
    lock.unlock()
    sessions.forEach { $0.cancel() }
  }
}

private struct NativeVideoChunkFetchResult {
  let bytesWritten: Int64
  let chunkCount: Int
}

private final class NativeVideoStreamSession: @unchecked Sendable {
  let requestId: String
  let streamId: String
  let fileId: String
  let outputUrl: URL

  private let master: MasterKeyHandle
  private let apiUrl: String
  private let token: String
  private let declaredSizeBytes: Int64?
  private let declaredChunkCount: Int?
  private let progress: NativeVideoStreamProgress
  private let onTerminal: () -> Void
  private let tempDir: URL
  private let encryptedUrl: URL
  private let partialPlainUrl: URL
  private let state = NSCondition()
  private let writerLock = NSLock()
  private let fetchQueue = OperationQueue()
  private let decryptQueue = OperationQueue()
  private var inFlight: [Int: ChunkFuture] = [:]
  private var downloaded = Set<Int>()
  private var decrypted = Set<Int>()
  private var cancelled = false
  private var terminal = false
  private var didTeardown = false
  private var terminalNotified = false
  private var fatal: Error?
  private var fileKey: FileKeyHandle?
  private var chunkCount = 0
  private var plaintextChunkSize: Int64 = 0
  private var originalSize: Int64 = 0
  private var downloadedBytes: Int64 = 0
  private var mutedDownloadProgress = false
  private var activeConnections: [NWConnection] = []
  private var activeTasks: [URLSessionTask] = []

  init(
    requestId: String,
    master: MasterKeyHandle,
    apiUrl: String,
    token: String,
    fileId: String,
    outputUrl: URL,
    declaredSizeBytes: Int64?,
    declaredChunkCount: Int?,
    progress: NativeVideoStreamProgress,
    onTerminal: @escaping () -> Void
  ) throws {
    guard !token.isEmpty else { throw streamError("streamVideoNative requires token") }
    self.requestId = requestId
    self.streamId = try Self.randomCapability()
    self.master = master
    self.apiUrl = apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    self.token = token
    self.fileId = fileId
    self.outputUrl = outputUrl
    self.declaredSizeBytes = declaredSizeBytes
    self.declaredChunkCount = declaredChunkCount
    self.progress = progress
    self.onTerminal = onTerminal
    self.tempDir = outputUrl.deletingLastPathComponent()
      .appendingPathComponent(".beebeeb-stream-\(fileId)-\(UUID().uuidString)", isDirectory: true)
    self.encryptedUrl = tempDir.appendingPathComponent("encrypted.bin")
    self.partialPlainUrl = tempDir.appendingPathComponent("decrypted.streaming")
    fetchQueue.name = "beebeeb.stream.fetch.\(fileId.prefix(8))"
    fetchQueue.maxConcurrentOperationCount = 4
    decryptQueue.name = "beebeeb.stream.decrypt.\(fileId.prefix(8))"
    decryptQueue.maxConcurrentOperationCount = 1
    try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    _ = PlaintextStorageProtection.protect(tempDir)
    try FileManager.default.createDirectory(at: outputUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
  }

  func start() throws -> NativeVideoStreamStart {
    progress.emitProgress(stage: "downloading", bytesDownloaded: 0, bytesTotal: 0)
    let head = try fetchChunkToDisk(index: 0, encryptedOffset: 0, expectedLength: nil)
    let resolvedChunkCount = head.chunkCount
    if let declaredChunkCount, declaredChunkCount != resolvedChunkCount {
      throw streamError("Declared chunk count does not match chunk endpoint metadata")
    }
    let resolvedChunkSize = max(0, head.bytesWritten - Int64(NativeVideoChunkMath.overheadBytes))
    let tail: NativeVideoChunkFetchResult
    if resolvedChunkCount == 1 {
      tail = head
    } else {
      let tailOffset = head.bytesWritten.multipliedReportingOverflow(by: Int64(resolvedChunkCount - 1))
      guard !tailOffset.overflow else { throw streamError("Streaming encrypted offset overflowed") }
      tail = try fetchChunkToDisk(index: resolvedChunkCount - 1, encryptedOffset: tailOffset.partialValue, expectedLength: nil)
    }
    let resolvedOriginalSize = try NativeVideoChunkMath.originalSize(
      chunkCount: resolvedChunkCount,
      plaintextChunkSize: resolvedChunkSize,
      tailWireSize: tail.bytesWritten
    )
    guard NativeVideoChunkMath.declaredSizeMatches(declaredSizeBytes, originalSize: resolvedOriginalSize, chunkCount: resolvedChunkCount) else {
      throw streamError("Declared size does not match inferred stream size")
    }
    try NativeVideoChunkMath.validate(chunkCount: resolvedChunkCount, plaintextChunkSize: resolvedChunkSize, originalSize: resolvedOriginalSize)
    state.lock()
    chunkCount = resolvedChunkCount
    plaintextChunkSize = resolvedChunkSize
    originalSize = resolvedOriginalSize
    state.unlock()
    fetchQueue.maxConcurrentOperationCount = resolvedChunkSize > (32 * 1024 * 1024) ? 1 : 4
    progress.emitDownload(bytesWritten: downloadedBytes, bytesExpected: encryptedTotalBytes())
    try preallocatePartialPlaintext(size: resolvedOriginalSize)
    _ = try decryptChunkFromDisk(index: 0)
    if resolvedChunkCount > 1 {
      _ = try decryptChunkFromDisk(index: resolvedChunkCount - 1)
    }
    mutedDownloadProgress = true
    startPump()
    guard awaitChunk(resolvedChunkCount - 1) else { throw fatal ?? streamError("Stream failed before it became playable") }
    let streamUri = try NativeVideoStreamServer.shared.register(session: self)
    if !isTerminalSuccess() {
      progress.emitProgress(stage: "decrypting", chunksCompleted: decryptedCount(), chunksTotal: resolvedChunkCount, extra: ["streaming": true])
    }
    return NativeVideoStreamStart(
      streamUri: streamUri,
      outputUri: outputUrl.absoluteString,
      outputPath: outputUrl.path,
      plaintextSize: resolvedOriginalSize,
      chunkCount: resolvedChunkCount,
      streamId: streamId
    )
  }

  func chunkPlan() -> (chunkCount: Int, plaintextChunkSize: Int64, originalSize: Int64)? {
    state.lock()
    defer { state.unlock() }
    guard chunkCount > 0 else { return nil }
    return (chunkCount, plaintextChunkSize, originalSize)
  }

  func awaitChunk(_ index: Int) -> Bool {
    ensureChunk(index).wait()
  }

  func currentPlaintextUrl() -> URL {
    state.lock()
    let complete = terminal && FileManager.default.fileExists(atPath: outputUrl.path)
    state.unlock()
    return complete ? outputUrl : partialPlainUrl
  }

  func addConnection(_ connection: NWConnection) {
    state.lock()
    activeConnections.append(connection)
    state.unlock()
  }

  func removeConnection(_ connection: NWConnection) {
    state.lock()
    activeConnections.removeAll { $0 === connection }
    state.unlock()
  }

  func stopRequested() -> Bool {
    state.lock()
    let value = cancelled || progress.isCancelled() || PlaintextStorageProtection.isPurgePending()
    state.unlock()
    return value
  }

  func isTerminalSuccess() -> Bool {
    state.lock()
    let value = terminal && !cancelled
    state.unlock()
    return value
  }

  func cancel() {
    cancelAndDrain(errorMessage: nil, waitForQueues: true)
  }

  func fail(_ message: String) {
    cancelAndDrain(errorMessage: message, waitForQueues: false)
  }

  func failAndWait(_ message: String) {
    cancelAndDrain(errorMessage: message, waitForQueues: true)
  }

  private func cancelAndDrain(errorMessage: String?, waitForQueues: Bool) {
    state.lock()
    if didTeardown {
      state.unlock()
      return
    }
    if let errorMessage { fatal = streamError(errorMessage) }
    cancelled = true
    let connections = activeConnections
    let tasks = activeTasks
    let futures = inFlight.map { ($0.key, $0.value) }
    inFlight.removeAll()
    state.broadcast()
    state.unlock()
    progress.cancel()
    futures.forEach { $0.1.complete(false) }
    tasks.forEach { $0.cancel() }
    fetchQueue.cancelAllOperations()
    decryptQueue.cancelAllOperations()
    connections.forEach { $0.cancel() }
    let finish = { [weak self] in
      guard let self else { return }
      self.fetchQueue.waitUntilAllOperationsAreFinished()
      self.decryptQueue.waitUntilAllOperationsAreFinished()
      if let errorMessage { self.progress.onError(errorMessage) }
      self.teardown(deletePartial: true, unregister: true)
    }
    if waitForQueues {
      finish()
    } else {
      DispatchQueue.global(qos: .utility).async(execute: finish)
    }
  }

  private func ensureChunk(_ index: Int) -> ChunkFuture {
    state.lock()
    if decrypted.contains(index) {
      state.unlock()
      return ChunkFuture.completed(true)
    }
    if let existing = inFlight[index] {
      state.unlock()
      return existing
    }
    let future = ChunkFuture()
    inFlight[index] = future
    let count = chunkCount
    let chunkSize = plaintextChunkSize
    let size = originalSize
    state.unlock()

    fetchQueue.addOperation { [weak self] in
      guard let self else {
        future.complete(false)
        return
      }
      if self.stopRequested() {
        self.completeFuture(index: index, future: future, value: false)
        return
      }
      do {
        let expected = NativeVideoChunkMath.encryptedSize(index: index, chunkCount: count, plaintextChunkSize: chunkSize, originalSize: size)
        let offset = NativeVideoChunkMath.encryptedOffset(index: index, chunkCount: count, plaintextChunkSize: chunkSize, originalSize: size)
        _ = try self.fetchChunkToDisk(index: index, encryptedOffset: offset, expectedLength: expected)
        self.decryptQueue.addOperation { [weak self] in
          guard let self else {
            future.complete(false)
            return
          }
          do {
            self.completeFuture(index: index, future: future, value: try self.decryptChunkFromDisk(index: index))
          } catch {
            self.completeFailure(index: index, error: error, future: future)
          }
        }
      } catch {
        self.completeFailure(index: index, error: error, future: future)
      }
    }
    return future
  }

  private func completeFailure(index: Int, error: Error, future: ChunkFuture) {
    if stopRequested() {
      completeFuture(index: index, future: future, value: false)
      return
    }
    completeFuture(index: index, future: future, value: false)
    fail("chunk \(index) failed: \(error.localizedDescription)")
  }

  private func completeFuture(index: Int, future: ChunkFuture, value: Bool) {
    state.lock()
    if inFlight[index] === future {
      inFlight.removeValue(forKey: index)
    }
    state.unlock()
    future.complete(value)
  }

  private func fetchChunkToDisk(index: Int, encryptedOffset: Int64, expectedLength: Int64?) throws -> NativeVideoChunkFetchResult {
    let url = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/chunks/\(index)")!
    var request = URLRequest(url: url)
    ProvenanceHeaders.apply(to: &request)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let stableDownloadUrl = tempDir.appendingPathComponent("chunk-\(index)-\(UUID().uuidString).download")
    var resultUrl: URL?
    var resultResponse: URLResponse?
    var resultError: Error?
    let semaphore = DispatchSemaphore(value: 0)
    let task = URLSession.shared.downloadTask(with: request) { [weak self] url, response, error in
      guard let self else {
        resultError = streamError("Preview stream released")
        semaphore.signal()
        return
      }
      resultResponse = response
      if self.stopRequested() {
        resultError = streamError("Preview stream cancelled")
        semaphore.signal()
        return
      }
      if let url {
        try? FileManager.default.removeItem(at: stableDownloadUrl)
        do {
          try FileManager.default.moveItem(at: url, to: stableDownloadUrl)
          resultUrl = stableDownloadUrl
        } catch {
          resultError = error
        }
      }
      if let error { resultError = error }
      semaphore.signal()
    }
    state.lock()
    activeTasks.append(task)
    state.unlock()
    task.resume()
    while semaphore.wait(timeout: .now() + 0.05) == .timedOut {
      if stopRequested() {
        task.cancel()
        state.lock()
        activeTasks.removeAll { $0 === task }
        state.unlock()
        throw streamError("Preview stream cancelled")
      }
    }
    state.lock()
    activeTasks.removeAll { $0 === task }
    state.unlock()
    if stopRequested() {
      task.cancel()
      throw streamError("Preview stream cancelled")
    }
    if let resultError { throw resultError }
    guard let http = resultResponse as? HTTPURLResponse else { throw streamError("Chunk \(index) response was not HTTP") }
    guard (200..<300).contains(http.statusCode) else { throw streamError("Chunk \(index) fetch failed with HTTP \(http.statusCode)") }
    guard let countHeader = http.value(forHTTPHeaderField: "X-Chunk-Count"), let responseChunkCount = Int(countHeader), responseChunkCount > 0 else {
      throw streamError("Chunk \(index) response is missing X-Chunk-Count")
    }
    if let indexHeader = http.value(forHTTPHeaderField: "X-Chunk-Index"), let responseIndex = Int(indexHeader), responseIndex != index {
      throw streamError("Chunk \(index) response had mismatched X-Chunk-Index \(responseIndex)")
    }
    state.lock()
    if chunkCount == 0 {
      chunkCount = responseChunkCount
    } else if chunkCount != responseChunkCount {
      state.unlock()
      throw streamError("Chunk \(index) response had mismatched X-Chunk-Count")
    }
    state.unlock()
    guard let resultUrl else {
      throw streamError("Chunk \(index) response had no body")
    }
    let bodySize = Int64((try FileManager.default.attributesOfItem(atPath: resultUrl.path)[.size] as? NSNumber)?.int64Value ?? 0)
    guard bodySize >= Int64(NativeVideoChunkMath.overheadBytes) else {
      throw streamError("Chunk \(index) response was empty or too small")
    }
    if let expectedLength, bodySize != expectedLength {
      throw streamError("Chunk \(index) is \(bodySize) bytes on the wire, expected \(expectedLength)")
    }
    if stopRequested() {
      throw streamError("Preview stream cancelled")
    }
    if !FileManager.default.fileExists(atPath: encryptedUrl.path) {
      FileManager.default.createFile(atPath: encryptedUrl.path, contents: nil)
    }
    let handle = try FileHandle(forWritingTo: encryptedUrl)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(encryptedOffset))
    let input = try FileHandle(forReadingFrom: resultUrl)
    defer {
      try? input.close()
      try? FileManager.default.removeItem(at: stableDownloadUrl)
    }
    while true {
      if stopRequested() {
        throw streamError("Preview stream cancelled")
      }
      let data = input.readData(ofLength: 256 * 1024)
      if data.isEmpty { break }
      try handle.write(contentsOf: data)
    }

    state.lock()
    if downloaded.insert(index).inserted {
      downloadedBytes += bodySize
    }
    let bytes = downloadedBytes
    let expected = encryptedTotalBytesLocked()
    state.broadcast()
    state.unlock()
    if !mutedDownloadProgress {
      progress.emitDownload(bytesWritten: bytes, bytesExpected: expected)
    }
    return NativeVideoChunkFetchResult(bytesWritten: bodySize, chunkCount: responseChunkCount)
  }

  private func fileKeyHandle() throws -> FileKeyHandle {
    state.lock()
    if let fileKey {
      state.unlock()
      return fileKey
    }
    state.unlock()

    let derived = try master.deriveFileKey(fileId: Data(fileId.utf8))
    state.lock()
    if cancelled || progress.isCancelled() || PlaintextStorageProtection.isPurgePending() {
      state.unlock()
      throw streamError("Preview stream cancelled")
    }
    if fileKey == nil { fileKey = derived }
    let value = fileKey ?? derived
    state.unlock()
    return value
  }

  private func decryptChunkFromDisk(index: Int) throws -> Bool {
    if stopRequested() { return false }
    state.lock()
    let count = chunkCount
    let chunkSize = plaintextChunkSize
    let size = originalSize
    guard downloaded.contains(index) else {
      state.unlock()
      throw streamError("Chunk \(index) was not downloaded")
    }
    state.unlock()

    let key = try fileKeyHandle()
    let encryptedSize = NativeVideoChunkMath.encryptedSize(index: index, chunkCount: count, plaintextChunkSize: chunkSize, originalSize: size)
    let encryptedOffset = NativeVideoChunkMath.encryptedOffset(index: index, chunkCount: count, plaintextChunkSize: chunkSize, originalSize: size)
    let encrypted = try readBytes(url: encryptedUrl, offset: encryptedOffset, count: Int(encryptedSize))
    let nonce = encrypted.subdata(in: 0..<NativeVideoChunkMath.nonceBytes)
    let ciphertext = encrypted.subdata(in: NativeVideoChunkMath.nonceBytes..<encrypted.count)
    let plaintext = try key.decryptChunk(nonce: nonce, ciphertext: ciphertext)
    if stopRequested() { return false }
    let expectedPlain = NativeVideoChunkMath.plaintextSize(index: index, chunkCount: count, plaintextChunkSize: chunkSize, originalSize: size)
    guard Int64(plaintext.count) == expectedPlain else {
      throw streamError("Chunk \(index) decrypted to \(plaintext.count) bytes, expected \(expectedPlain)")
    }
    writerLock.lock()
    do {
      defer { writerLock.unlock() }
      if stopRequested() { return false }
      let out = try FileHandle(forWritingTo: partialPlainUrl)
      defer { try? out.close() }
      try out.seek(toOffset: UInt64(NativeVideoChunkMath.plainOffset(index: index, plaintextChunkSize: chunkSize)))
      try out.write(contentsOf: plaintext)
    }

    state.lock()
    let inserted = decrypted.insert(index).inserted
    let done = decrypted.count
    state.broadcast()
    state.unlock()
    if inserted {
      progress.emitProgress(stage: "decrypting", chunksCompleted: done, chunksTotal: count, extra: ["streaming": true])
    }
    if done >= count {
      if stopRequested() { return false }
      try finalizeSuccess()
    }
    return true
  }

  private func startPump() {
    let count = chunkCount
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      if count > 1, !self.ensureChunk(count - 1).wait() { return }
      guard count > 1 else { return }
      for index in 0..<(count - 1) {
        if !self.ensureChunk(index).wait() || self.stopRequested() { return }
      }
    }
  }

  private func finalizeSuccess() throws {
    state.lock()
    if terminal {
      state.unlock()
      return
    }
    state.unlock()

    writerLock.lock()
    defer { writerLock.unlock() }
    if stopRequested() { return }
    try? FileManager.default.removeItem(at: outputUrl)
    try FileManager.default.moveItem(at: partialPlainUrl, to: outputUrl)
    state.lock()
    terminal = true
    state.broadcast()
    state.unlock()
    progress.onComplete()
    try? FileManager.default.removeItem(at: encryptedUrl)
    fileKey = nil
    notifyTerminalOnce()
  }

  private func teardown(deletePartial: Bool, unregister: Bool) {
    state.lock()
    if didTeardown {
      state.unlock()
      return
    }
    didTeardown = true
    state.unlock()
    fetchQueue.cancelAllOperations()
    decryptQueue.cancelAllOperations()
    fileKey = nil
    writerLock.lock()
    if deletePartial {
      try? FileManager.default.removeItem(at: partialPlainUrl)
      try? FileManager.default.removeItem(at: tempDir)
    } else {
      try? FileManager.default.removeItem(at: encryptedUrl)
    }
    writerLock.unlock()
    if unregister {
      NativeVideoStreamRegistry.shared.unregister(streamId: streamId, requestId: requestId)
      NativeVideoStreamServer.shared.unregister(streamId: streamId)
    }
    notifyTerminalOnce()
  }

  private func notifyTerminalOnce() {
    state.lock()
    if terminalNotified {
      state.unlock()
      return
    }
    terminalNotified = true
    state.unlock()
    onTerminal()
  }

  private func preallocatePartialPlaintext(size: Int64) throws {
    FileManager.default.createFile(atPath: partialPlainUrl.path, contents: nil)
    let handle = try FileHandle(forWritingTo: partialPlainUrl)
    defer { try? handle.close() }
    try handle.truncate(atOffset: UInt64(size))
  }

  private func encryptedTotalBytes() -> Int64 {
    state.lock()
    let total = encryptedTotalBytesLocked()
    state.unlock()
    return total
  }

  private func encryptedTotalBytesLocked() -> Int64 {
    guard chunkCount > 0, originalSize > 0 else { return 0 }
    let overhead = Int64(NativeVideoChunkMath.overheadBytes).multipliedReportingOverflow(by: Int64(chunkCount))
    guard !overhead.overflow else { return 0 }
    let total = originalSize.addingReportingOverflow(overhead.partialValue)
    return total.overflow ? 0 : total.partialValue
  }

  private func decryptedCount() -> Int {
    state.lock()
    let count = decrypted.count
    state.unlock()
    return count
  }

  private static func randomCapability() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else { throw streamError("Could not create stream capability") }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
}

private final class ChunkFuture: @unchecked Sendable {
  private let condition = NSCondition()
  private var value: Bool?

  static func completed(_ value: Bool) -> ChunkFuture {
    let future = ChunkFuture()
    future.complete(value)
    return future
  }

  func complete(_ value: Bool) {
    condition.lock()
    if self.value == nil {
      self.value = value
      condition.broadcast()
    }
    condition.unlock()
  }

  func wait() -> Bool {
    condition.lock()
    while value == nil {
      condition.wait()
    }
    let result = value ?? false
    condition.unlock()
    return result
  }
}

private final class NativeVideoStreamServer: @unchecked Sendable {
  static let shared = NativeVideoStreamServer()
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "beebeeb.video-stream.server", qos: .utility)
  private var listener: NWListener?
  private var port: UInt16?

  func register(session: NativeVideoStreamSession) throws -> String {
    let port = try ensureStarted()
    let ext = session.outputUrl.pathExtension.isEmpty ? "mp4" : session.outputUrl.pathExtension
    return "http://127.0.0.1:\(port)/s/\(session.streamId)/v.\(ext)"
  }

  func unregister(streamId: String) {
    NativeVideoStreamRegistry.shared.unregister(streamId: streamId, requestId: "")
  }

  private func ensureStarted() throws -> UInt16 {
    lock.lock()
    if let port {
      lock.unlock()
      return port
    }
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    guard let loopback = IPv4Address("127.0.0.1") else {
      lock.unlock()
      throw streamError("Could not create loopback address")
    }
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(loopback), port: .any)
    let listener = try NWListener(using: parameters, on: .any)
    let ready = DispatchSemaphore(value: 0)
    var readyError: Error?
    listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        ready.signal()
      case .failed(let error):
        readyError = error
        ready.signal()
      default:
        break
      }
    }
    listener.start(queue: queue)
    guard ready.wait(timeout: .now() + 3) == .success else {
      lock.unlock()
      listener.cancel()
      throw streamError("Video stream listener did not become ready")
    }
    if let readyError {
      lock.unlock()
      listener.cancel()
      throw readyError
    }
    guard let assigned = listener.port else {
      lock.unlock()
      listener.cancel()
      throw streamError("Could not allocate video stream port")
    }
    self.listener = listener
    self.port = assigned.rawValue
    lock.unlock()
    return assigned.rawValue
  }

  private func serve(_ connection: NWConnection) {
    guard isLoopbackEndpoint(connection.endpoint) else {
      connection.cancel()
      return
    }
    connection.start(queue: queue)
    receiveHeaders(connection: connection, accumulated: Data())
  }

  private func receiveHeaders(connection: NWConnection, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, error in
      guard let self else { return }
      if error != nil {
        connection.cancel()
        return
      }
      var buffer = accumulated
      if let data { buffer.append(data) }
      guard buffer.count <= 16 * 1024 else {
        self.respondError(connection: connection, status: 400, message: "Bad request")
        return
      }
      if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
        self.handleRequest(connection: connection, headerData: buffer.subdata(in: 0..<range.lowerBound))
      } else {
        self.receiveHeaders(connection: connection, accumulated: buffer)
      }
    }
  }

  private func handleRequest(connection: NWConnection, headerData: Data) {
    guard let text = String(data: headerData, encoding: .isoLatin1), let requestLine = text.components(separatedBy: "\r\n").first else {
      respondError(connection: connection, status: 400, message: "Bad request")
      return
    }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else {
      respondError(connection: connection, status: 400, message: "Bad request")
      return
    }
    let method = parts[0].uppercased()
    let path = String(parts[1])
    let components = path.split(separator: "/").map(String.init)
    guard components.count >= 3, components[0] == "s" else {
      respondError(connection: connection, status: 404, message: "Unknown stream")
      return
    }
    let streamId = components[1]
    guard let session = NativeVideoStreamRegistry.shared.session(streamId: streamId) else {
      respondError(connection: connection, status: 404, message: "Unknown stream")
      return
    }
    session.addConnection(connection)
    var rangeHeader: String?
    for line in text.components(separatedBy: "\r\n").dropFirst() {
      let pair = line.split(separator: ":", maxSplits: 1).map(String.init)
      if pair.count == 2 && pair[0].lowercased() == "range" {
        rangeHeader = pair[1].trimmingCharacters(in: .whitespaces)
      }
    }
    switch method {
    case "GET": serveGet(connection: connection, session: session, rangeHeader: rangeHeader)
    case "HEAD": serveHead(connection: connection, session: session, rangeHeader: rangeHeader)
    default: respondError(connection: connection, status: 405, message: "Method not allowed", session: session)
    }
  }

  private func serveHead(connection: NWConnection, session: NativeVideoStreamSession, rangeHeader: String?) {
    guard let plan = session.chunkPlan() else {
      respondError(connection: connection, status: 416, message: "Range not satisfiable", session: session)
      return
    }
    guard let range = resolveRange(rangeHeader, total: plan.originalSize) else {
      respondRangeNotSatisfiable(connection: connection, total: plan.originalSize, session: session)
      return
    }
    let status = rangeHeader == nil ? 200 : 206
    sendAndClose(connection, Data(headers(status: status, start: range.start, end: range.end, total: plan.originalSize, ext: session.outputUrl.pathExtension).utf8), session: session)
  }

  private func serveGet(connection: NWConnection, session: NativeVideoStreamSession, rangeHeader: String?) {
    guard let plan = session.chunkPlan() else {
      respondError(connection: connection, status: 416, message: "Range not satisfiable", session: session)
      return
    }
    guard let range = resolveRange(rangeHeader, total: plan.originalSize) else {
      respondRangeNotSatisfiable(connection: connection, total: plan.originalSize, session: session)
      return
    }
    let status = rangeHeader == nil ? 200 : 206
    let header = headers(status: status, start: range.start, end: range.end, total: plan.originalSize, ext: session.outputUrl.pathExtension)
    send(connection, Data(header.utf8)) { [weak self] ok in
      guard ok, let self else {
        session.removeConnection(connection)
        connection.cancel()
        return
      }
      DispatchQueue.global(qos: .utility).async {
        self.sendBody(connection: connection, session: session, plan: plan, start: range.start, end: range.end)
      }
    }
  }

  private func sendBody(
    connection: NWConnection,
    session: NativeVideoStreamSession,
    plan: (chunkCount: Int, plaintextChunkSize: Int64, originalSize: Int64),
    start: Int64,
    end: Int64
  ) {
    do {
      let handle = try FileHandle(forReadingFrom: session.currentPlaintextUrl())
      defer { try? handle.close() }
      var position = start
      while position <= end && !session.stopRequested() {
        let chunkIndex = NativeVideoChunkMath.chunkIndex(for: position, chunkCount: plan.chunkCount, plaintextChunkSize: plan.plaintextChunkSize)
        guard session.awaitChunk(chunkIndex) else { break }
        let chunkEnd = NativeVideoChunkMath.plainOffset(index: chunkIndex, plaintextChunkSize: plan.plaintextChunkSize)
          + NativeVideoChunkMath.plaintextSize(index: chunkIndex, chunkCount: plan.chunkCount, plaintextChunkSize: plan.plaintextChunkSize, originalSize: plan.originalSize) - 1
        let length = min(Int64(64 * 1024), end - position + 1, chunkEnd - position + 1)
        try handle.seek(toOffset: UInt64(position))
        let data = handle.readData(ofLength: Int(length))
        guard data.count == Int(length), sendSync(connection, data) else { break }
        position += length
      }
    } catch {
      // The player retries by opening a fresh range request.
    }
    session.removeConnection(connection)
    connection.cancel()
  }

  private func resolveRange(_ header: String?, total: Int64) -> (start: Int64, end: Int64)? {
    guard total > 0 else { return nil }
    guard let header else { return (0, total - 1) }
    guard header.hasPrefix("bytes=") else { return nil }
    let spec = header.dropFirst("bytes=".count)
    let pair = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    guard pair.count == 2 else { return nil }
    let startRaw = String(pair[0])
    let endRaw = String(pair[1])
    let start: Int64
    let end: Int64
    if startRaw.isEmpty {
      guard let suffix = Int64(endRaw), suffix > 0 else { return nil }
      start = max(0, total - suffix)
      end = total - 1
    } else {
      guard let parsedStart = Int64(startRaw) else { return nil }
      start = parsedStart
      if endRaw.isEmpty {
        end = total - 1
      } else {
        guard let parsedEnd = Int64(endRaw) else { return nil }
        end = min(parsedEnd, total - 1)
      }
    }
    guard start >= 0, start <= end, start < total else { return nil }
    return (start, end)
  }

  private func headers(status: Int, start: Int64, end: Int64, total: Int64, ext: String) -> String {
    let reason = status == 206 ? "Partial Content" : "OK"
    var lines = ["HTTP/1.1 \(status) \(reason)"]
    if status == 206 {
      lines.append("Content-Range: bytes \(start)-\(end)/\(total)")
      lines.append("Content-Length: \(end - start + 1)")
    } else {
      lines.append("Content-Length: \(total)")
    }
    lines.append("Content-Type: \(mimeType(ext: ext))")
    lines.append("Accept-Ranges: bytes")
    lines.append("Cache-Control: no-store")
    lines.append("Connection: close")
    lines.append("")
    lines.append("")
    return lines.joined(separator: "\r\n")
  }

  private func respondError(connection: NWConnection, status: Int, message: String, session: NativeVideoStreamSession? = nil) {
    let body = Data(message.utf8)
    var data = Data("HTTP/1.1 \(status) \(message)\r\nContent-Length: \(body.count)\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n".utf8)
    data.append(body)
    sendAndClose(connection, data, session: session)
  }

  private func respondRangeNotSatisfiable(connection: NWConnection, total: Int64, session: NativeVideoStreamSession) {
    let body = Data("Range not satisfiable".utf8)
    var data = Data((
      "HTTP/1.1 416 Range not satisfiable\r\n"
        + "Content-Range: bytes */\(total)\r\n"
        + "Content-Length: \(body.count)\r\n"
        + "Content-Type: text/plain\r\n"
        + "Connection: close\r\n\r\n"
    ).utf8)
    data.append(body)
    sendAndClose(connection, data, session: session)
  }

  private func sendAndClose(_ connection: NWConnection, _ data: Data, session: NativeVideoStreamSession?) {
    send(connection, data) { _ in
      if let session { session.removeConnection(connection) }
      connection.cancel()
    }
  }

  private func sendSync(_ connection: NWConnection, _ data: Data) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var ok = false
    send(connection, data) { sent in
      ok = sent
      semaphore.signal()
    }
    semaphore.wait()
    return ok
  }

  private func send(_ connection: NWConnection, _ data: Data, completion: @escaping (Bool) -> Void) {
    connection.send(content: data, completion: .contentProcessed { error in completion(error == nil) })
  }

  private func isLoopbackEndpoint(_ endpoint: NWEndpoint) -> Bool {
    guard case let .hostPort(host, _) = endpoint else { return false }
    switch host {
    case .ipv4(let address): return address.debugDescription == "127.0.0.1"
    case .ipv6(let address): return address.debugDescription == "::1"
    case .name(let name, _): return name == "localhost"
    @unknown default: return false
    }
  }

  private func mimeType(ext: String) -> String {
    switch ext.lowercased() {
    case "mov": return "video/quicktime"
    case "webm": return "video/webm"
    case "mkv": return "video/x-matroska"
    case "3gp", "3g2": return "video/3gpp"
    default: return "video/mp4"
    }
  }
}

private func readBytes(url: URL, offset: Int64, count: Int) throws -> Data {
  let handle = try FileHandle(forReadingFrom: url)
  defer { try? handle.close() }
  try handle.seek(toOffset: UInt64(offset))
  let data = handle.readData(ofLength: count)
  guard data.count == count else { throw streamError("Encrypted chunk was truncated") }
  return data
}

private func streamFileURL(fromURI uri: String) -> URL {
  if uri.hasPrefix("file://"), let url = URL(string: uri) {
    return url
  }
  return URL(fileURLWithPath: uri)
}

private func streamError(_ message: String) -> NSError {
  NSError(domain: "BeebeebVideoStream", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
