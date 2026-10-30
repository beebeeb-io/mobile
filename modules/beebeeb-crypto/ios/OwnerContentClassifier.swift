import Foundation

/// SF-0002 M2a: classify one owned content version as `string`, `binary`,
/// `string_or_binary`, `upper_repair` or `unknown`.
///
/// The rules are ordered and each early rule costs zero requests:
///  1. a cached convention for `(epoch, fileId, objectVersionId)`;
///  2. `createdAt` before the 2026-05-01 cutover → `string_or_binary`;
///  3. an UpperRepair name already known for this file → `upper_repair`;
///  4. ONE `GET /api/v1/files/{id}/chunks/0` (the native video streamers' path
///     and auth): a declared length over `maxChunkZeroBytes` aborts WITHOUT
///     reading the body → `string_or_binary`; otherwise at most
///     `maxChunkZeroBytes` are read and `resolveOwnerContent` authenticates the
///     first frame, whose exact convention is cached;
///  5. any failure → `unknown`, never cached.
///
/// `maxChunkZeroBytes` (C) is the largest chunk 0 any File Provider build since
/// 2026-05-01 could have written, plus the AEAD overhead — derived from the
/// File Provider's git history in `C.md` and pinned by the Swift harness.
struct ChunkZeroResponse {
    let status: Int?
    let contentLength: Int?
    let body: Data
    /// The client cap (or a declared length over it) was reached: no body was
    /// handed over. The classifier maps this to `string_or_binary`, not unknown.
    let tooLarge: Bool
}

protocol ChunkZeroTransport {
    func fetch(apiUrl: String, fileId: String, token: String, maxBytes: Int) throws -> ChunkZeroResponse
}

struct OwnerContentClassifier {
    /// C = 4 MiB (the largest chunk 0 a shipped File Provider build wrote since
    /// 2026-05-01) + 12-byte nonce + 16-byte tag.
    static let maxChunkZeroBytes = 4 * 1024 * 1024 + 28

    let transport: ChunkZeroTransport

    init(transport: ChunkZeroTransport = URLSessionChunkZeroTransport()) {
        self.transport = transport
    }

    func classify(master: MasterKeyHandle, fileId: String, objectVersionId: String,
                  createdAt: String, apiUrl: String, token: String,
                  registry: SharedKeyRegistry<FileKeyHandle> = SharedKeyOps.registry) -> String {
        let epoch = registry.generation
        if let cached = SharedKeyOps.ownerConventions.content(
            epoch: epoch, fileId: fileId, objectVersionId: objectVersionId) {
            return SharedKeyOps.conventionCode(cached)
        }
        if Self.isBeforeCutover(createdAt) { return "string_or_binary" }
        if SharedKeyOps.ownerConventions.isUpperRepairName(epoch: epoch, fileId: fileId) {
            return "upper_repair"
        }
        do {
            let response = try transport.fetch(apiUrl: apiUrl, fileId: fileId, token: token,
                                               maxBytes: Self.maxChunkZeroBytes)
            if response.tooLarge { return "string_or_binary" }
            guard let status = response.status, (200..<300).contains(status),
                  !response.body.isEmpty, response.body.count <= Self.maxChunkZeroBytes else {
                return "unknown"
            }
            let resolved = try SharedKeyOps.resolveOwnerContent(
                master: master, fileId: fileId, firstFrame: response.body, registry: registry)
            SharedKeyOps.ownerConventions.storeContent(
                resolved.convention, epoch: epoch, fileId: fileId, objectVersionId: objectVersionId)
            return SharedKeyOps.conventionCode(resolved.convention)
        } catch {
            return "unknown"
        }
    }

    /// The contract's cutover: anything created before 2026-05-01 may predate the
    /// pinned framing and is `string_or_binary` with zero requests.
    static func isBeforeCutover(_ createdAt: String) -> Bool {
        createdAt.prefix(10) < "2026-05-01"
    }
}

/// The production transport: one bounded GET through URLSession. The
/// `Content-Length` check happens when the response headers arrive, so the body
/// of an over-cap chunk is never read; a chunked response is read up to the cap.
final class URLSessionChunkZeroTransport: NSObject, ChunkZeroTransport, URLSessionDataDelegate {
    private final class Receiver {
        let cap: Int
        var status: Int?
        var contentLength: Int?
        var body = Data()
        var tooLarge = false
        var error: Error?
        let done = DispatchSemaphore(value: 0)
        init(cap: Int) { self.cap = cap }
    }

    func fetch(apiUrl: String, fileId: String, token: String, maxBytes: Int) throws -> ChunkZeroResponse {
        let url = URL(string: "\(apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/v1/files/\(fileId)/chunks/0")!
        var request = URLRequest(url: url)
        ProvenanceHeaders.apply(to: &request)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30

        let receiver = Receiver(cap: maxBytes)
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: request)
        activeReceivers[ObjectIdentifier(task)] = receiver
        task.resume()
        receiver.done.wait()
        activeReceivers.removeValue(forKey: ObjectIdentifier(task))
        if let error = receiver.error { throw error }
        return ChunkZeroResponse(status: receiver.status, contentLength: receiver.contentLength,
                                 body: receiver.body, tooLarge: receiver.tooLarge)
    }

    /// Tasks run one at a time per instance; keyed so parallel instances stay safe.
    private var activeReceivers: [ObjectIdentifier: Receiver] = [:]
    private let lock = NSLock()
    private func receiver(for task: URLSessionTask) -> Receiver? {
        lock.lock(); defer { lock.unlock() }
        return activeReceivers[ObjectIdentifier(task)]
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let receiver = receiver(for: dataTask) else { completionHandler(.cancel); return }
        guard let http = response as? HTTPURLResponse else { receiver.tooLarge = true; completionHandler(.cancel); return }
        receiver.status = http.statusCode
        let length = http.expectedContentLength >= 0 ? Int(http.expectedContentLength) : nil
        receiver.contentLength = length
        if let length, length > receiver.cap { receiver.tooLarge = true; completionHandler(.cancel); return }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let receiver = receiver(for: dataTask) else { return }
        if receiver.body.count + data.count > receiver.cap {
            receiver.tooLarge = true
            dataTask.cancel()
            return
        }
        receiver.body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let receiver = receiver(for: task) else { return }
        receiver.error = error
        receiver.done.signal()
    }
}
