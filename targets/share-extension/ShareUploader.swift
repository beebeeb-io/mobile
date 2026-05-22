import Foundation

/// Handles file upload from the Share Extension to the Beebeeb API.
///
/// Always encrypts in-process and uploads directly via URLSession. If the
/// master key is unavailable (device not unlocked yet, entitlement broken)
/// `ShareViewController` refuses the share at the point of key load — we
/// never reach this class without a master key, so we never need to consider
/// a plaintext-staging fallback. The previous fallback wrote unencrypted
/// bytes to the App Group container, which leaked plaintext if the user
/// uninstalled before the main app drained the staging directory.
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

    // MARK: - Properties

    private let apiUrl: String
    private let sessionToken: String
    private let masterKey: Data

    init(apiUrl: String, sessionToken: String, masterKey: Data) {
        self.apiUrl = apiUrl
        self.sessionToken = sessionToken
        self.masterKey = masterKey
    }

    // MARK: - Public

    /// Encrypt then upload a file. Throws if encryption or the network
    /// transfer fails. Never writes the plaintext to disk.
    ///
    /// Progress callback receives (fraction 0...1, statusMessage).
    func upload(
        fileData: Data,
        fileName: String,
        parentId: String?,
        onProgress: @escaping (Float, String) -> Void
    ) async throws -> UploadResult {
        let fileID = UUID().uuidString

        onProgress(0.1, "Encrypting...")
        let encryptedData: Data
        let encryptedName: String
        do {
            encryptedData = try BeebeebCryptoShim.encrypt(data: fileData, masterKey: masterKey, fileID: fileID)
            encryptedName = try BeebeebCryptoShim.encryptFilename(fileName, masterKey: masterKey, fileID: fileID)
        } catch let cryptoErr as BeebeebCryptoShim.CryptoError {
            throw UploadError.cryptoUnavailable(String(describing: cryptoErr))
        } catch {
            throw UploadError.cryptoUnavailable(error.localizedDescription)
        }

        onProgress(0.3, "Uploading...")
        try await directUpload(
            fileID: fileID,
            encryptedData: encryptedData,
            encryptedName: encryptedName,
            parentId: parentId,
            plaintextSize: fileData.count,
            onProgress: onProgress
        )
        return .uploaded(fileId: fileID)
    }

    // MARK: - Direct Upload

    private func directUpload(
        fileID: String,
        encryptedData: Data,
        encryptedName: String,
        parentId: String?,
        plaintextSize: Int,
        onProgress: @escaping (Float, String) -> Void
    ) async throws {
        let chunkSize = 4 * 1024 * 1024  // 4MB chunks
        let chunkCount = max(1, Int(ceil(Double(encryptedData.count) / Double(chunkSize))))

        // Init upload
        let initBody: [String: Any] = [
            "file_name": encryptedName,
            "file_size_bytes": encryptedData.count,
            "parent_id": parentId as Any,
            "mime_type": NSNull(),
            "is_media": false,
            "profile": "mobile-share",
            "chunk_size_bytes": chunkSize,
            "chunk_count": chunkCount,
        ]

        guard let initURL = URL(string: "\(apiUrl)/api/v1/uploads/init") else {
            throw UploadError.networkError(URLError(.badURL))
        }

        var initRequest = URLRequest(url: initURL)
        initRequest.httpMethod = "POST"
        initRequest.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: initBody)

        let (initData, initResponse) = try await URLSession.shared.data(for: initRequest)
        guard let httpResp = initResponse as? HTTPURLResponse, httpResp.statusCode == 200 else {
            let code = (initResponse as? HTTPURLResponse)?.statusCode ?? 0
            let msg = String(data: initData, encoding: .utf8) ?? "Unknown error"
            throw UploadError.uploadFailed(code, msg)
        }

        guard let initJson = try? JSONSerialization.jsonObject(with: initData) as? [String: Any],
              let serverFileId = initJson["file_id"] as? String else {
            throw UploadError.uploadFailed(0, "Invalid init response")
        }

        // Upload chunks
        for i in 0..<chunkCount {
            let start = i * chunkSize
            let end = min(start + chunkSize, encryptedData.count)
            let chunk = encryptedData[start..<end]

            guard let chunkURL = URL(string: "\(apiUrl)/api/v1/files/\(serverFileId)/chunks/\(i)") else {
                throw UploadError.networkError(URLError(.badURL))
            }

            var chunkRequest = URLRequest(url: chunkURL)
            chunkRequest.httpMethod = "PUT"
            chunkRequest.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
            chunkRequest.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            chunkRequest.httpBody = Data(chunk)

            let (_, chunkResponse) = try await URLSession.shared.data(for: chunkRequest)
            guard let chunkHttpResp = chunkResponse as? HTTPURLResponse, chunkHttpResp.statusCode == 200 else {
                let code = (chunkResponse as? HTTPURLResponse)?.statusCode ?? 0
                throw UploadError.uploadFailed(code, "Chunk \(i) upload failed")
            }

            let progress = 0.3 + 0.6 * Float(i + 1) / Float(chunkCount)
            onProgress(progress, "Uploading... \(Int(progress * 100))%")
        }

        // Complete upload
        guard let completeURL = URL(string: "\(apiUrl)/api/v1/files/\(serverFileId)/upload/complete") else {
            throw UploadError.networkError(URLError(.badURL))
        }

        var completeRequest = URLRequest(url: completeURL)
        completeRequest.httpMethod = "POST"
        completeRequest.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        completeRequest.httpBody = "{}".data(using: .utf8)

        let (_, completeResponse) = try await URLSession.shared.data(for: completeRequest)
        guard let completeHttpResp = completeResponse as? HTTPURLResponse, completeHttpResp.statusCode == 200 else {
            let code = (completeResponse as? HTTPURLResponse)?.statusCode ?? 0
            throw UploadError.uploadFailed(code, "Complete request failed")
        }

        onProgress(1.0, "Done")
    }
}
