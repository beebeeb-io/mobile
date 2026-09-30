import Foundation

/// Handles file upload from the Share Extension to the Beebeeb API.
///
/// Streams encryption through the shared beebeeb-core chunk ladder
/// (`ChunkEncryptorHandle`) and uploads via the v2 chunked-upload session
/// (`/api/v1/uploads/init` → `PUT /uploads/{session}/chunks/{i}` →
/// `/uploads/{session}/complete`) — the SAME contract the File Provider uses
/// (task 0673). Key hygiene: the caller passes an opaque `MasterKeyHandle`;
/// raw `masterKey: Data` never crosses into this class. For file shares the
/// plaintext streams from disk one core-planned chunk at a time (bounded
/// memory) — a multi-GB share is never read whole into RAM.
///
/// If the master key is unavailable, `ShareViewController` refuses the share at
/// key-load, so we never reach this class without a key — there is no
/// plaintext-staging fallback (writing plaintext to the App Group leaked it on
/// uninstall; removed by task 0428).
final class ShareUploader {

    // MARK: - Types

    enum UploadError: LocalizedError {
        case fileReadFailed
        case cryptoUnavailable(String)
        /// Task 1671 (Issue 2b): the server's error `detail` is intentionally
        /// NOT part of this case — it is logged via `NSLog` at the throw site
        /// (`send(_:)`/`initUpload`/etc.) instead, never surfaced to the user.
        /// Showing the raw JSON response body (e.g. the full upload-init
        /// payload: chunk_count, lease_expires_at, object_version_id,
        /// storage_pool_id, tenant_id, upload_session_id, ...) as an alert is
        /// both unreadable and leaks internal identifiers for no benefit —
        /// exactly what Guus hit on TestFlight build 230.
        case uploadFailed(Int)
        /// A 2xx whose body could not be read (init only): the request
        /// succeeded, so there is no honest HTTP status to show.
        case unreadableResponse
        case networkError(Error)
        /// Task 1594 round 5: the server's typed 409 `account_mismatch` —
        /// the session's real account doesn't match the `X-Beebeeb-Expected-User`
        /// this request sent. A clean, non-retryable ownership failure, never
        /// the generic `.uploadFailed(409, ...)` (which the UI would present
        /// as "Upload failed (HTTP 409): ..." and invite a retry with the
        /// SAME stale key — the exact behavior this fix exists to avoid).
        case accountMismatch

        var errorDescription: String? {
            switch self {
            case .fileReadFailed: return "Could not read file data"
            case .cryptoUnavailable(let msg): return "Could not encrypt the file: \(msg). Open Beebeeb once, then try sharing again."
            case .uploadFailed(let code): return "Upload failed (HTTP \(code)). Please try again."
            case .unreadableResponse: return "Beebeeb got a reply it couldn't read. Please try again."
            case .networkError(let e): return "Network error: \(e.localizedDescription)"
            case .accountMismatch: return "This file belongs to a different account. Open Beebeeb, sign in again, then try sharing again."
            }
        }
    }

    /// Result of a share-sheet upload. The previous `staged` variant has been
    /// removed — we never write plaintext to disk anymore.
    enum UploadResult {
        case uploaded(fileId: String)
    }

    /// v2 init response (subset we use).
    private struct InitResponse: Decodable {
        let file_id: String
        let upload_session_id: String
    }

    // MARK: - Properties

    private let apiUrl: String
    private let sessionToken: String
    private let masterKey: MasterKeyHandle
    /// Task 1594 round 5: the F3-verified owner of `masterKey`
    /// (`ShareViewController.verifiedKeyOwnerId`, itself the same shared
    /// keychain value `keyOwnershipVerified()` already gated the share on) —
    /// sent as `X-Beebeeb-Expected-User` on every mutating request, exactly
    /// like `targets/file-provider/ApiClient.swift`'s own `expectedUser`
    /// (round 4). `nil`/empty omits the header — unchanged, pre-1594
    /// behaviour (`ShareUploadRequestPolicy.shouldAttachExpectedUserHeader`).
    private let expectedUser: String?

    /// beebeeb-core chunk-plan profile. Chunk size + count are derived in Rust
    /// from this profile + the plaintext size — never hardcoded here (the old
    /// 4 MiB constant is gone). Must be one of "desktop" | "web" | "mobile" |
    /// "backup".
    private static let chunkProfile = "mobile"

    init(apiUrl: String, sessionToken: String, masterKey: MasterKeyHandle, expectedUser: String?) {
        self.apiUrl = apiUrl
        self.sessionToken = sessionToken
        self.masterKey = masterKey
        self.expectedUser = expectedUser
    }

    // MARK: - Public

    /// Stream-encrypt a file on disk and upload it. Bounded memory: the core
    /// encryptor reads + encrypts one plan-sized chunk at a time from `fileURL`.
    func uploadFile(
        at fileURL: URL,
        fileName: String,
        parentId: String?,
        onProgress: @escaping (Float, String) -> Void
    ) async throws -> UploadResult {
        let fileId = UUID().uuidString.lowercased()

        let fileSize: Int64
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            fileSize = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        } catch {
            throw UploadError.fileReadFailed
        }
        guard fileSize > 0 else { throw UploadError.fileReadFailed }

        onProgress(0.05, "Encrypting...")
        let encryptedName: String
        let encryptor: ChunkEncryptorHandle
        let plan: ChunkPlanResult
        do {
            encryptedName = try masterKey.encryptName(fileId: fileId, filename: fileName, mimeType: nil)
            encryptor = try ChunkEncryptorHandle.fromFile(
                masterKey: masterKey,
                fileId: fileId,
                inputPath: fileURL.path,
                profile: Self.chunkProfile
            )
            plan = try encryptor.chunkPlan()
        } catch {
            throw UploadError.cryptoUnavailable(error.localizedDescription)
        }

        let session = try await initUpload(
            fileId: fileId,
            nameEncrypted: encryptedName,
            plaintextSize: fileSize,
            isMedia: Self.isMedia(fileName: fileName),
            parentId: parentId,
            chunkSizeBytes: Int(plan.chunkSizeBytes),
            chunkCount: Int(plan.chunkCount)
        )

        // Task 1671 (Issue 2b): `initUpload` above already created the file
        // row + upload session server-side. Any failure from here on must
        // abandon that session (best-effort) before rethrowing, so a retry
        // never piles up another stranded placeholder next to this one.
        do {
            onProgress(0.3, "Uploading...")
            let chunkCount = max(1, Int(plan.chunkCount))
            var uploaded = 0
            while true {
                let chunk: EncryptedChunkDto?
                do {
                    // Read + encrypt one chunk; autoreleasepool releases the frame
                    // buffer between iterations so peak memory stays ~one chunk.
                    chunk = try autoreleasepool { try encryptor.nextChunk() }
                } catch {
                    throw UploadError.cryptoUnavailable(error.localizedDescription)
                }
                guard let chunk else { break }
                try await putChunk(uploadSessionId: session.upload_session_id, index: Int(chunk.index), frame: chunk.data)
                uploaded += 1
                let progress = min(0.9, 0.3 + 0.6 * Float(uploaded) / Float(chunkCount))
                onProgress(progress, "Uploading... \(Int(progress * 100))%")
            }

            // Integrity guard (detects a source that shrank) before completing.
            do { _ = try encryptor.finish() }
            catch { throw UploadError.cryptoUnavailable(error.localizedDescription) }

            try await completeUpload(uploadSessionId: session.upload_session_id)
        } catch {
            await abandonUpload(fileId: fileId)
            throw error
        }
        onProgress(1.0, "Done")
        return .uploaded(fileId: fileId)
    }

    /// In-memory variant for small shares (text / URL items) delivered as `Data`.
    func uploadData(
        _ data: Data,
        fileName: String,
        parentId: String?,
        onProgress: @escaping (Float, String) -> Void
    ) async throws -> UploadResult {
        let fileId = UUID().uuidString.lowercased()

        onProgress(0.1, "Encrypting...")
        let encryptedName: String
        let encryptor: ChunkEncryptorHandle
        let plan: ChunkPlanResult
        do {
            encryptedName = try masterKey.encryptName(fileId: fileId, filename: fileName, mimeType: nil)
            encryptor = try ChunkEncryptorHandle.forPush(
                masterKey: masterKey,
                fileId: fileId,
                fileSize: UInt64(data.count),
                profile: Self.chunkProfile
            )
            plan = try encryptor.chunkPlan()
        } catch {
            throw UploadError.cryptoUnavailable(error.localizedDescription)
        }

        let session = try await initUpload(
            fileId: fileId,
            nameEncrypted: encryptedName,
            plaintextSize: Int64(data.count),
            isMedia: Self.isMedia(fileName: fileName),
            parentId: parentId,
            chunkSizeBytes: Int(plan.chunkSizeBytes),
            chunkCount: Int(plan.chunkCount)
        )

        // Task 1671 (Issue 2b) — see the matching comment in `uploadFile`.
        do {
            onProgress(0.3, "Uploading...")
            let chunkSize = Int(plan.chunkSizeBytes)
            let chunkCount = Int(plan.chunkCount)
            for index in 0..<chunkCount {
                let start = index * chunkSize
                let end = min(start + chunkSize, data.count)
                let slice = start < end ? data.subdata(in: start..<end) : Data()
                let frame: Data
                do { frame = try encryptor.pushChunk(plaintext: slice).data }
                catch { throw UploadError.cryptoUnavailable(error.localizedDescription) }
                try await putChunk(uploadSessionId: session.upload_session_id, index: index, frame: frame)
                let progress = min(0.9, 0.3 + 0.6 * Float(index + 1) / Float(chunkCount))
                onProgress(progress, "Uploading... \(Int(progress * 100))%")
            }

            do { _ = try encryptor.finish() }
            catch { throw UploadError.cryptoUnavailable(error.localizedDescription) }

            try await completeUpload(uploadSessionId: session.upload_session_id)
        } catch {
            await abandonUpload(fileId: fileId)
            throw error
        }
        onProgress(1.0, "Done")
        return .uploaded(fileId: fileId)
    }

    // MARK: - v2 chunked-upload session (mirrors the File Provider's ApiClient)

    private func initUpload(
        fileId: String,
        nameEncrypted: String,
        plaintextSize: Int64,
        isMedia: Bool,
        parentId: String?,
        chunkSizeBytes: Int,
        chunkCount: Int
    ) async throws -> InitResponse {
        guard let url = URL(string: "\(apiUrl)/api/v1/uploads/init") else {
            throw UploadError.networkError(URLError(.badURL))
        }
        // Wire contract: file_size_bytes is the PLAINTEXT byte count (the server
        // recomputes the stored ciphertext size from the chunks); chunk_size +
        // chunk_count come from the core plan.
        var body: [String: Any] = [
            "file_id": fileId,
            "file_name": nameEncrypted,
            "file_size_bytes": plaintextSize,
            "is_media": isMedia,
            "profile": Self.chunkProfile,
            "chunk_size_bytes": chunkSizeBytes,
            "chunk_count": chunkCount,
        ]
        body["mime_type"] = NSNull()
        body["parent_id"] = parentId ?? NSNull()

        var request = URLRequest(url: url)
        ProvenanceHeaders.apply(to: &request)
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if ShareUploadRequestPolicy.shouldAttachExpectedUserHeader(expectedUser) {
            request.setValue(expectedUser, forHTTPHeaderField: "X-Beebeeb-Expected-User")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await send(request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        if ShareUploadRequestPolicy.isAccountMismatchResponse(statusCode: statusCode, body: data) {
            throw UploadError.accountMismatch
        }
        // Task 1671 (Issue 2b): `init_upload` (beebeeb-api/src/routes/uploads.rs:924)
        // returns 201 Created, not 200 — accept the whole 2xx range like every
        // other step, never a single hardcoded code.
        guard ShareUploadRequestPolicy.isSuccessResponse(statusCode: statusCode) else {
            Self.logUploadFailureDetail(step: "init", statusCode: statusCode, body: data)
            throw UploadError.uploadFailed(statusCode)
        }
        guard let decoded = try? JSONDecoder().decode(InitResponse.self, from: data) else {
            NSLog("[Beebeeb] ShareUploader: init response failed to decode: \(String(data: data, encoding: .utf8) ?? "<non-utf8>")")
            // The 2xx means the file row + upload session already exist
            // server-side; without the session id no chunk can be sent, so
            // abandon it now (best-effort) instead of stranding a placeholder.
            await abandonUpload(fileId: fileId)
            throw UploadError.unreadableResponse
        }
        return decoded
    }

    private func putChunk(uploadSessionId: String, index: Int, frame: Data) async throws {
        guard let url = URL(string: "\(apiUrl)/api/v1/uploads/\(uploadSessionId)/chunks/\(index)") else {
            throw UploadError.networkError(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        ProvenanceHeaders.apply(to: &request)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if ShareUploadRequestPolicy.shouldAttachExpectedUserHeader(expectedUser) {
            request.setValue(expectedUser, forHTTPHeaderField: "X-Beebeeb-Expected-User")
        }
        request.httpBody = frame

        let (data, response) = try await send(request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        if ShareUploadRequestPolicy.isAccountMismatchResponse(statusCode: statusCode, body: data) {
            throw UploadError.accountMismatch
        }
        guard ShareUploadRequestPolicy.isSuccessResponse(statusCode: statusCode) else {
            Self.logUploadFailureDetail(step: "chunk \(index)", statusCode: statusCode, body: data)
            throw UploadError.uploadFailed(statusCode)
        }
    }

    private func completeUpload(uploadSessionId: String) async throws {
        guard let url = URL(string: "\(apiUrl)/api/v1/uploads/\(uploadSessionId)/complete") else {
            throw UploadError.networkError(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        ProvenanceHeaders.apply(to: &request)
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if ShareUploadRequestPolicy.shouldAttachExpectedUserHeader(expectedUser) {
            request.setValue(expectedUser, forHTTPHeaderField: "X-Beebeeb-Expected-User")
        }
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await send(request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        if ShareUploadRequestPolicy.isAccountMismatchResponse(statusCode: statusCode, body: data) {
            throw UploadError.accountMismatch
        }
        guard ShareUploadRequestPolicy.isSuccessResponse(statusCode: statusCode) else {
            Self.logUploadFailureDetail(step: "complete", statusCode: statusCode, body: data)
            throw UploadError.uploadFailed(statusCode)
        }
    }

    /// Task 1671 (Issue 2b): best-effort — mirrors `abandonTextFileUpload` in
    /// `src/lib/text-file-save.ts`, which calls the SAME
    /// `POST /api/v1/files/{id}/upload/abandon` endpoint
    /// (`beebeeb-api/src/routes/files.rs:1119`/`:3546`) on any failure after
    /// its own `init` succeeded, and swallows the result — "the server's
    /// 7-day stale-upload sweep is the backstop". Called from `uploadFile`/
    /// `uploadData` whenever a chunk PUT, `finish()`, or `complete` fails
    /// AFTER `initUpload` already created the file row + upload session, so a
    /// share-sheet retry never piles up another stranded placeholder next to
    /// the one from the failed attempt.
    private func abandonUpload(fileId: String) async {
        guard let url = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/upload/abandon") else { return }
        var request = URLRequest(url: url)
        ProvenanceHeaders.apply(to: &request)
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        if ShareUploadRequestPolicy.shouldAttachExpectedUserHeader(expectedUser) {
            request.setValue(expectedUser, forHTTPHeaderField: "X-Beebeeb-Expected-User")
        }
        do {
            _ = try await URLSession.shared.data(for: request)
        } catch {
            NSLog("[Beebeeb] ShareUploader: best-effort abandon(\(fileId)) failed: \(error.localizedDescription)")
        }
    }

    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await URLSession.shared.data(for: request)
        } catch {
            throw UploadError.networkError(error)
        }
    }

    // MARK: - Helpers

    /// Task 1671 (Issue 2b): logs the server's actual response body for
    /// engineers (device log / Console.app) — this is the ONLY place that
    /// detail is written down. `UploadError.uploadFailed` carries just the
    /// status code, so `showError()` never renders a raw JSON blob again.
    private static func logUploadFailureDetail(step: String, statusCode: Int, body: Data) {
        let detail = String(data: body, encoding: .utf8) ?? "<non-utf8, \(body.count) bytes>"
        NSLog("[Beebeeb] ShareUploader: \(step) failed (HTTP \(statusCode)): \(detail)")
    }

    private static func isMedia(fileName: String) -> Bool {
        switch (fileName as NSString).pathExtension.lowercased() {
        case "jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tiff", "bmp",
             "mp4", "mov", "m4v", "avi", "hevc":
            return true
        default:
            return false
        }
    }
}
