import CryptoKit
import Foundation
import Network

private let harnessKey = SymmetricKey(data: Data((0..<32).map { UInt8($0) }))

private final class FakeFileKey: FileKeyHandle, @unchecked Sendable {
  override func decryptChunk(nonce: Data, ciphertext: Data) throws -> Data {
    guard nonce.count == 12, ciphertext.count >= 16 else {
      throw NSError(domain: "Harness", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad frame"])
    }
    let sealed = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce),
      ciphertext: ciphertext.dropLast(16),
      tag: ciphertext.suffix(16)
    )
    return try AES.GCM.open(sealed, using: harnessKey)
  }
}

private final class FakeMasterKey: MasterKeyHandle, @unchecked Sendable {
  override func deriveFileKey(fileId: Data) throws -> FileKeyHandle {
    FakeFileKey(noHandle: .init())
  }
}

private final class ChunkServer {
  private let chunks: [Data]
  private let blockIndex: Int?
  private let slowBodyIndex: Int?
  private let blockSemaphore = DispatchSemaphore(value: 0)
  private let ready = DispatchSemaphore(value: 0)
  private let queue = DispatchQueue(label: "native-video-streamer-harness.chunks")
  private var listener: NWListener?
  private(set) var requests: [Int] = []
  private(set) var baseUrl: String = ""

  init(chunks: [Data], blockIndex: Int? = nil, slowBodyIndex: Int? = nil) throws {
    self.chunks = chunks
    self.blockIndex = blockIndex
    self.slowBodyIndex = slowBodyIndex
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(IPv4Address("127.0.0.1")!), port: .any)
    let listener = try NWListener(using: parameters, on: .any)
    var assignedPort: UInt16 = 0
    listener.stateUpdateHandler = { state in
      if case .ready = state, let port = listener.port {
        assignedPort = port.rawValue
        self.ready.signal()
      }
    }
    listener.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
    listener.start(queue: queue)
    guard ready.wait(timeout: .now() + 3) == .success else {
      throw NSError(domain: "Harness", code: 3, userInfo: [NSLocalizedDescriptionKey: "chunk server not ready"])
    }
    self.listener = listener
    self.baseUrl = "http://127.0.0.1:\(assignedPort)"
  }

  func unblock() {
    blockSemaphore.signal()
  }

  func stop() {
    listener?.cancel()
  }

  private func serve(_ conn: NWConnection) {
    conn.start(queue: queue)
    conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, _ in
      guard let self, let data, let text = String(data: data, encoding: .isoLatin1) else {
        conn.cancel()
        return
      }
      let line = text.components(separatedBy: "\r\n").first ?? ""
      let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""
      let index = Int(path.split(separator: "/").last ?? "") ?? -1
      self.requests.append(index)
      if index == self.blockIndex {
        _ = self.blockSemaphore.wait(timeout: .now() + 5)
      }
      guard index >= 0, index < self.chunks.count else {
        self.send(conn, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".data(using: .utf8)!)
        return
      }
      var body = self.chunks[index]
      let headers = [
        "HTTP/1.1 200 OK",
        "X-Chunk-Count: \(self.chunks.count)",
        "X-Chunk-Index: \(index)",
        "Content-Length: \(body.count)",
        "Connection: close",
        "",
        "",
      ].joined(separator: "\r\n")
      var response = Data(headers.utf8)
      if index == self.slowBodyIndex {
        // Headers and the first half now, the rest after a pause: the client sees
        // a chunk that is partly received, as a 128 MiB chunk is for many seconds.
        let half = body.count / 2
        response.append(body.prefix(half))
        let rest = Data(body.suffix(from: half))
        conn.send(content: response, completion: .contentProcessed { _ in })
        self.queue.asyncAfter(deadline: .now() + 0.4) { self.send(conn, rest) }
        return
      }
      response.append(body)
      body.removeAll(keepingCapacity: false)
      self.send(conn, response)
    }
  }

  private func send(_ conn: NWConnection, _ data: Data) {
    conn.send(content: data, completion: .contentProcessed { _ in conn.cancel() })
  }
}

private func frame(_ plaintext: String, goodTag: Bool = true) -> Data {
  frame(data: Data(plaintext.utf8), goodTag: goodTag)
}

private func frame(data plain: Data, goodTag: Bool = true) -> Data {
  var nonceBytes = Array(repeating: UInt8(0x11), count: 12)
  nonceBytes[11] = UInt8(plain.count & 0xff)
  let nonce = try! AES.GCM.Nonce(data: Data(nonceBytes))
  let sealed = try! AES.GCM.seal(plain, using: harnessKey, nonce: nonce)
  var data = Data(nonceBytes)
  data.append(sealed.ciphertext)
  var tag = Data(sealed.tag)
  if !goodTag { tag[tag.index(before: tag.endIndex)] ^= 0x01 }
  data.append(tag)
  return data
}

private func fetch(_ url: String, range: String? = nil, method: String = "GET", timeout: TimeInterval = 3) throws -> (Int, Data, [AnyHashable: Any]) {
  var request = URLRequest(url: URL(string: url)!)
  request.httpMethod = method
  if let range { request.setValue(range, forHTTPHeaderField: "Range") }
  let sem = DispatchSemaphore(value: 0)
  var result: (Int, Data, [AnyHashable: Any])?
  var thrown: Error?
  URLSession.shared.dataTask(with: request) { data, response, error in
    if let error { thrown = error }
    else {
      let http = response as? HTTPURLResponse
      result = (http?.statusCode ?? 0, data ?? Data(), http?.allHeaderFields ?? [:])
    }
    sem.signal()
  }.resume()
  guard sem.wait(timeout: .now() + timeout) == .success else {
    throw NSError(domain: "Harness", code: 4, userInfo: [NSLocalizedDescriptionKey: "fetch timeout"])
  }
  if let thrown { throw thrown }
  return result!
}

private var assertionCount = 0
private let harnessTempDirectory: URL = {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("bb-video-streamer-\(UUID().uuidString)", isDirectory: true)
  try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}()

private func makeOutputURL() -> URL {
  harnessTempDirectory.appendingPathComponent("stream-\(UUID().uuidString).mp4")
}

private func cleanupHarnessTempDirectory() {
  try? FileManager.default.removeItem(at: harnessTempDirectory)
}

private func assert(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertionCount += 1
  if !condition() {
    fputs("FAIL: \(message)\n", stderr)
    cleanupHarnessTempDirectory()
    exit(1)
  }
}

private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    Thread.sleep(forTimeInterval: 0.005)
  }
  return condition()
}

private func runEarlyRangeAndCancel() throws {
  let chunks = [frame("HEAD"), frame("MID!"), frame("TL")]
  let server = try ChunkServer(chunks: chunks, blockIndex: 1)
  defer { server.stop() }
  let output = makeOutputURL()
  var events: [[String: Any]] = []
  let progress = NativeVideoStreamProgress(requestId: "req-early", fileId: "file") { events.append($0) }
  let started = try NativeVideoStreamer.start(
    requestId: "req-early",
    master: FakeMasterKey(noHandle: .init()),
    apiUrl: server.baseUrl,
    token: "token",
    fileId: "file",
    outputUri: output.absoluteString,
    declaredSizeBytes: 10,
    declaredChunkCount: 3,
    progress: progress,
    onTerminal: {}
  )
  assert(started.plaintextSize == 10, "inferred plaintext size")
  assert(server.requests.prefix(2).contains(0) && server.requests.prefix(2).contains(2), "head and tail fetched before startup")
  let headMeta = try fetch(started.streamUri, method: "HEAD")
  assert(headMeta.0 == 200 && (headMeta.2["Accept-Ranges"] as? String) == "bytes", "HEAD without range returns 200 with byte ranges")
  let head = try fetch(started.streamUri, range: "bytes=0-3")
  assert(head.0 == 206 && String(data: head.1, encoding: .utf8) == "HEAD", "head range is served")

  let middleDone = DispatchSemaphore(value: 0)
  var middle: (Int, Data)?
  var middleError: Error?
  URLSession.shared.dataTask(with: {
    var r = URLRequest(url: URL(string: started.streamUri)!)
    r.setValue("bytes=4-7", forHTTPHeaderField: "Range")
    return r
  }()) { data, response, error in
    middleError = error
    middle = ((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data())
    middleDone.signal()
  }.resume()
  assert(middleDone.wait(timeout: .now() + 0.25) == .timedOut, "hole range blocks before chunk verifies")
  server.unblock()
  assert(middleDone.wait(timeout: .now() + 8) == .success, "hole range completes after chunk verifies; error=\(String(describing: middleError)); requests=\(server.requests); events=\(events)")
  assert(middle?.0 == 206 && String(data: middle?.1 ?? Data(), encoding: .utf8) == "MID!", "middle range body")

  let badRange = try fetch(started.streamUri, range: "bytes=999-1000")
  assert(badRange.0 == 416, "invalid range is 416")
  let malformedRange = try fetch(started.streamUri, range: "bytes=4-nope")
  assert(malformedRange.0 == 416 && (malformedRange.2["Content-Range"] as? String) == "bytes */10", "malformed range is 416 with total content range")
  let badUnit = try fetch(started.streamUri, range: "items=0-1")
  assert(badUnit.0 == 416, "unsupported range unit is 416")
  NativeVideoStreamer.cancel(streamId: started.streamId)
  let afterCancel = try fetch(started.streamUri, range: "bytes=0-1")
  assert(afterCancel.0 == 404, "completed stream unregisters on explicit cancel")
}

private func runAuthFailure() throws {
  let server = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("TL", goodTag: false)])
  defer { server.stop() }
  let output = makeOutputURL()
  let progress = NativeVideoStreamProgress(requestId: "req-auth", fileId: "file") { _ in }
  do {
    _ = try NativeVideoStreamer.start(
      requestId: "req-auth",
      master: FakeMasterKey(noHandle: .init()),
      apiUrl: server.baseUrl,
      token: "token",
      fileId: "file",
      outputUri: output.absoluteString,
      declaredSizeBytes: 10,
      declaredChunkCount: 3,
      progress: progress,
      onTerminal: {}
    )
    assert(false, "auth failure must throw")
  } catch {
    assert(!FileManager.default.fileExists(atPath: output.path), "auth failure does not promote output")
  }
}


private func runCancelAtPromotion() throws {
  let server = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("DONE")])
  defer {
    server.stop()
    NativeVideoStreamer.beforePromotionForTest = nil
  }
  let output = makeOutputURL()
  var events: [[String: Any]] = []
  let eventLock = NSLock()
  let progress = NativeVideoStreamProgress(requestId: "req-promote", fileId: "file") { event in
    eventLock.lock()
    events.append(event)
    eventLock.unlock()
  }
  var fired = false
  let terminal = DispatchSemaphore(value: 0)
  NativeVideoStreamer.beforePromotionForTest = {
    guard !fired else { return }
    fired = true
    DispatchQueue.global(qos: .userInitiated).async {
      NativeVideoStreamer.cancel(requestId: "req-promote")
    }
    assert(waitUntil(timeout: 2) { progress.isCancelled() }, "promotion cancellation admitted")
  }
  do {
    _ = try NativeVideoStreamer.start(
      requestId: "req-promote",
      master: FakeMasterKey(noHandle: .init()),
      apiUrl: server.baseUrl,
      token: "token",
      fileId: "file",
      outputUri: output.absoluteString,
      declaredSizeBytes: 12,
      declaredChunkCount: 3,
      progress: progress,
      onTerminal: { terminal.signal() }
    )
  } catch {
    // Cancellation may win before startup returns on slow machines.
  }
  assert(terminal.wait(timeout: .now() + 2) == .success, "promotion cancellation reached terminal cleanup")
  eventLock.lock()
  let sawComplete = events.contains { ($0["stage"] as? String) == "complete" }
  eventLock.unlock()
  assert(fired, "promotion cancellation hook fired")
  assert(!FileManager.default.fileExists(atPath: output.path), "cancel at promotion does not leave final plaintext")
  assert(!sawComplete, "cancel at promotion suppresses complete")
}

private func runCancelDrain() throws {
  let server = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("TL")], blockIndex: 1)
  defer { server.stop() }
  let output = makeOutputURL()
  let progress = NativeVideoStreamProgress(requestId: "req-cancel", fileId: "file") { _ in }
  _ = try NativeVideoStreamer.start(
    requestId: "req-cancel",
    master: FakeMasterKey(noHandle: .init()),
    apiUrl: server.baseUrl,
    token: "token",
    fileId: "file",
    outputUri: output.absoluteString,
    declaredSizeBytes: 10,
    declaredChunkCount: 3,
    progress: progress,
    onTerminal: {}
  )
  let started = Date()
  NativeVideoStreamer.cancelAll()
  assert(Date().timeIntervalSince(started) < 2, "cancelAll drains promptly")
  assert(!FileManager.default.fileExists(atPath: output.path), "cancel before complete does not promote output")
}

// The file list can carry a stale chunk count (a single chunk for a file the
// server actually holds as many). The chunk endpoint's count is authoritative
// and every chunk is authenticated, so a wrong hint must not stop streaming;
// the declared size is still checked.
private func runStaleDeclaredChunkCount() throws {
  let server = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("TL")])
  defer { server.stop() }
  let output = makeOutputURL()
  let progress = NativeVideoStreamProgress(requestId: "req-stale-count", fileId: "file") { _ in }
  let started = try NativeVideoStreamer.start(
    requestId: "req-stale-count",
    master: FakeMasterKey(noHandle: .init()),
    apiUrl: server.baseUrl,
    token: "token",
    fileId: "file",
    outputUri: output.absoluteString,
    declaredSizeBytes: 10,
    declaredChunkCount: 1,
    progress: progress,
    onTerminal: {}
  )
  assert(started.chunkCount == 3, "endpoint chunk count wins over a stale declared count")
  assert(started.plaintextSize == 10, "size inferred from the chunks")
  let body = try fetch(started.streamUri, range: "bytes=0-9")
  assert(body.0 == 206 && String(data: body.1, encoding: .utf8) == "HEADMID!TL", "stream serves the whole file")
  assert(waitUntil(timeout: 2) { FileManager.default.fileExists(atPath: output.path) }, "finished stream is promoted")
  let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: output.deletingLastPathComponent().path)) ?? []
  assert(!leftovers.contains { $0.hasPrefix(".beebeeb-stream-file-") }, "a finished stream leaves no temp directory behind")
  NativeVideoStreamer.cancelAll()

  let wrongSize = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("TL")])
  defer { wrongSize.stop() }
  let progress2 = NativeVideoStreamProgress(requestId: "req-wrong-size", fileId: "file") { _ in }
  var rejected = false
  do {
    _ = try NativeVideoStreamer.start(
      requestId: "req-wrong-size",
      master: FakeMasterKey(noHandle: .init()),
      apiUrl: wrongSize.baseUrl,
      token: "token",
      fileId: "file",
      outputUri: output.absoluteString,
      declaredSizeBytes: 999,
      declaredChunkCount: 1,
      progress: progress2,
      onTerminal: {}
    )
  } catch {
    rejected = true
  }
  assert(rejected, "a declared size that matches nothing is still rejected")
}


private func streamTempDirectories(fileId: String) -> [URL] {
  let names = (try? FileManager.default.contentsOfDirectory(atPath: harnessTempDirectory.path)) ?? []
  return names.filter { $0.hasPrefix(".beebeeb-stream-\(fileId)-") }.map { harnessTempDirectory.appendingPathComponent($0) }
}

// Task 2335 fix 4: the stream used to copy every chunk's ciphertext into one
// `encrypted.bin` the size of the whole file, next to the whole plaintext, and
// removed it only at the end (17.48 GB twice for the CLI-pushed .mkv). A chunk's
// ciphertext now lives on disk only until that chunk is decrypted.
private func runNoSecondWholeFileCopy() throws {
  let server = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("TL")], blockIndex: 1)
  defer { server.stop() }
  let output = makeOutputURL()
  let progress = NativeVideoStreamProgress(requestId: "req-nocopy", fileId: "nocopy") { _ in }
  let started = try NativeVideoStreamer.start(
    requestId: "req-nocopy",
    master: FakeMasterKey(noHandle: .init()),
    apiUrl: server.baseUrl,
    token: "token",
    fileId: "nocopy",
    outputUri: output.absoluteString,
    declaredSizeBytes: 10,
    declaredChunkCount: 3,
    progress: progress,
    onTerminal: {}
  )
  let dirs = streamTempDirectories(fileId: "nocopy")
  assert(dirs.count == 1, "one working directory for the live stream (found \(dirs.count))")
  let contents = ((try? FileManager.default.contentsOfDirectory(atPath: dirs.first?.path ?? "")) ?? []).sorted()
  assert(contents == ["decrypted.streaming"], "while chunk 1 is in flight, only the plaintext is on disk: no whole-file ciphertext, no decrypted chunk's ciphertext (found \(contents))")
  server.unblock()
  assert(waitUntil(timeout: 4) { FileManager.default.fileExists(atPath: output.path) }, "the stream completes and promotes")
  assert(streamTempDirectories(fileId: "nocopy").isEmpty, "a finished stream leaves no ciphertext behind")
  let body = try fetch(started.streamUri, range: "bytes=0-9")
  assert(body.0 == 206 && String(data: body.1, encoding: .utf8) == "HEADMID!TL", "the plaintext is intact without the ciphertext copy")
  NativeVideoStreamer.cancelAll()
}

// Task 2335 fix 3: before the player gets a URL the stream fetches chunk 0 and
// the tail whole. That wait reported nothing until a chunk finished. It now
// reports bytes done of the bytes it needs, while a chunk is still arriving.
private func runStartupBufferingProgress() throws {
  // 512 KiB chunks: CFNetwork holds back a small partial body (an 8 KiB first half was
  // never reported), so the arriving half must be big enough to surface, as 128 MiB is.
  let full = 524_288
  let chunks = [
    frame(data: Data(repeating: 0x41, count: full)),
    frame(data: Data(repeating: 0x42, count: full)),
    frame(data: Data(repeating: 0x43, count: 10)),
  ]
  let need = Int64(chunks[0].count + chunks[2].count)
  let server = try ChunkServer(chunks: chunks, slowBodyIndex: 0)
  defer { server.stop() }
  let output = makeOutputURL()
  var events: [[String: Any]] = []
  let eventLock = NSLock()
  let progress = NativeVideoStreamProgress(requestId: "req-buffering", fileId: "buffering") { event in
    eventLock.lock()
    events.append(event)
    eventLock.unlock()
  }
  _ = try NativeVideoStreamer.start(
    requestId: "req-buffering",
    master: FakeMasterKey(noHandle: .init()),
    apiUrl: server.baseUrl,
    token: "token",
    fileId: "buffering",
    outputUri: output.absoluteString,
    declaredSizeBytes: Int64(full * 2 + 10),
    declaredChunkCount: 3,
    progress: progress,
    onTerminal: {}
  )
  eventLock.lock()
  let startup = events
  eventLock.unlock()
  let buffering = startup.filter { ($0["stage"] as? String) == "downloading" && ($0["buffering"] as? Bool) == true }
  func bytes(_ event: [String: Any], _ key: String) -> Int64 { (event[key] as? Int64) ?? Int64((event[key] as? Int) ?? -1) }
  assert(!buffering.isEmpty, "startup emits buffering progress (events: \(startup))")
  assert(buffering.allSatisfy { bytes($0, "bytesTotal") == need }, "every buffering event's total is chunk 0 plus the tail: \(need) (events: \(buffering))")
  assert(buffering.contains { bytes($0, "bytesDownloaded") > 0 && bytes($0, "bytesDownloaded") < Int64(chunks[0].count) }, "progress moves while chunk 0 is still arriving (events: \(buffering))")
  assert(bytes(buffering.last ?? [:], "bytesDownloaded") == need, "the last buffering event is all bytes needed (events: \(buffering))")
  let wholeFileTotals = startup.filter { ($0["stage"] as? String) == "downloading" && bytes($0, "bytesTotal") > need }
  assert(wholeFileTotals.isEmpty, "startup never shows the whole file as the amount it waits for (events: \(wholeFileTotals))")
  NativeVideoStreamer.cancelAll()
}

private enum HarnessMain {
  static func main() throws {
    defer { cleanupHarnessTempDirectory() }
    try runEarlyRangeAndCancel()
    try runAuthFailure()
    try runCancelAtPromotion()
    try runCancelDrain()
    try runStaleDeclaredChunkCount()
    try runNoSecondWholeFileCopy()
    try runStartupBufferingProgress()
    print("native-video-streamer-harness: \(assertionCount) assertions, 0 failed")
  }
}

try HarnessMain.main()
