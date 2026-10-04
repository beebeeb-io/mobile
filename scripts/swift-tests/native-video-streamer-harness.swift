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
  private let blockSemaphore = DispatchSemaphore(value: 0)
  private let ready = DispatchSemaphore(value: 0)
  private let queue = DispatchQueue(label: "native-video-streamer-harness.chunks")
  private var listener: NWListener?
  private(set) var requests: [Int] = []
  private(set) var baseUrl: String = ""

  init(chunks: [Data], blockIndex: Int? = nil) throws {
    self.chunks = chunks
    self.blockIndex = blockIndex
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
  let plain = Data(plaintext.utf8)
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

private func assert(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertionCount += 1
  if !condition() {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
  }
}

private func runEarlyRangeAndCancel() throws {
  let chunks = [frame("HEAD"), frame("MID!"), frame("TL")]
  let server = try ChunkServer(chunks: chunks, blockIndex: 1)
  defer { server.stop() }
  let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("stream-harness-\(UUID().uuidString).mp4")
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
  let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("stream-harness-\(UUID().uuidString).mp4")
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

private func runCancelDrain() throws {
  let server = try ChunkServer(chunks: [frame("HEAD"), frame("MID!"), frame("TL")], blockIndex: 1)
  defer { server.stop() }
  let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("stream-harness-\(UUID().uuidString).mp4")
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

@main
private enum HarnessMain {
  static func main() throws {
    try runEarlyRangeAndCancel()
    try runAuthFailure()
    try runCancelDrain()
    print("native-video-streamer-harness: assertions=\(assertionCount) failures=0")
  }
}
