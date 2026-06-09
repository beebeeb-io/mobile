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
        case uploadFailed(Int, String)
        case networkError(Error)

        var errorDescription: String? {
            switch self {
            case .fileReadFailed: return "Could not read file data"
            case .cryptoUnavailable(let msg): return "Could not encrypt the file: \(msg). Open Beebeeb once, then try sharing again."
            case .uploadFailed(let code, let msg): return "Upload failed (HTTP \(code)): \(msg)"
            case .networkError(let e): return "Network error: \(e.localizedDescription)"
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

    /// beebeeb-core chunk-plan profile. Chunk size + count are derived in Rust
    /// from this profile + the plaintext size — never hardcoded here (the old
    /// 4 MiB constant is gone). Must be one of "desktop" | "web" | "mobile" |
    /// "backup".
    private static let chunkProfile = "mobile"

    init(apiUrl: String, sessionToken: String, masterKey: MasterKeyHandle) {
        self.apiUrl = apiUrl
        self.sessionToken = sessionToken
        self.masterKey = masterKey
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
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await send(request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw UploadError.uploadFailed(code, String(data: data, encoding: .utf8) ?? "init failed")
        }
        guard let decoded = try? JSONDecoder().decode(InitResponse.self, from: data) else {
            throw UploadError.uploadFailed(0, "Invalid init response")
        }
        return decoded
    }

    private func putChunk(uploadSessionId: String, index: Int, frame: Data) async throws {
        guard let url = URL(string: "\(apiUrl)/api/v1/uploads/\(uploadSessionId)/chunks/\(index)") else {
            throw UploadError.networkError(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = frame

        let (data, response) = try await send(request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw UploadError.uploadFailed(code, String(data: data, encoding: .utf8) ?? "chunk \(index) failed")
        }
    }

    private func completeUpload(uploadSessionId: String) async throws {
        guard let url = URL(string: "\(apiUrl)/api/v1/uploads/\(uploadSessionId)/complete") else {
            throw UploadError.networkError(URLError(.badURL))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await send(request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw UploadError.uploadFailed(code, String(data: data, encoding: .utf8) ?? "complete failed")
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
