import Foundation

/// Handles file upload from the Share Extension to the Beebeeb API.
///
/// Phase 1 (current): BeebeebCryptoShim stubs throw NotLinkedError, so files are
/// staged unencrypted to the App Group `pending-uploads/` directory. The main app
/// picks them up, encrypts via CryptoContext, and uploads on next launch.
///
/// Phase 2: Once the xcframework is linked, this class will encrypt chunks in-process
/// and upload directly via URLSession without needing the main app.
final class ShareUploader {

    // MARK: - Types

    /// Manifest format compatible with PendingSharesAccess.swift in the main app.
    /// Includes an optional `parentId` field that the main app uses to route
    /// the upload to the correct folder.
    struct IncomingShareManifest: Codable {
        let id: String
        let filename: String
        let relativePath: String
        let mimeType: String?
        let sizeBytes: Int64
        let timestamp: TimeInterval
        let kind: String
        let parentId: String?
    }

    enum UploadError: LocalizedError {
        case noAppGroup
        case fileReadFailed
        case stagingFailed(Error)
        case uploadFailed(Int, String)
        case networkError(Error)

        var errorDescription: String? {
            switch self {
            case .noAppGroup: return "App Group container not available"
            case .fileReadFailed: return "Could not read file data"
            case .stagingFailed(let e): return "Staging failed: \(e.localizedDescription)"
            case .uploadFailed(let code, let msg): return "Upload failed (HTTP \(code)): \(msg)"
            case .networkError(let e): return "Network error: \(e.localizedDescription)"
            }
        }
    }

    enum UploadResult {
        /// File was encrypted and uploaded directly (Phase 2)
        case uploaded(fileId: String)
        /// File was staged to App Group for main app to encrypt and upload
        case staged(fileId: String)
    }

    // MARK: - Constants

    private static let appGroup = "group.io.beebeeb.shared"
    /// Stages into IncomingShares/ which the main app's PendingSharesAccess.swift
    /// already knows how to read via the native bridge → JS PendingSharesHandler.
    private static let incomingDir = "IncomingShares"

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

    /// Upload or stage a file. Returns the result indicating whether the file
    /// was uploaded directly or staged for the main app.
    ///
    /// Progress callback receives (fraction 0...1, statusMessage).
    func upload(
        fileData: Data,
        fileName: String,
        parentId: String?,
        onProgress: @escaping (Float, String) -> Void
    ) async throws -> UploadResult {
        let fileID = UUID().uuidString

        // Phase 1: Attempt encryption — will fail with NotLinkedError
        do {
            onProgress(0.1, "Encrypting...")
            let encryptedData = try BeebeebCryptoShim.encrypt(data: fileData, masterKey: masterKey, fileID: fileID)
            let encryptedName = try BeebeebCryptoShim.encryptFilename(fileName, masterKey: masterKey, fileID: fileID)

            // Encryption succeeded (Phase 2) — upload directly
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

        } catch is BeebeebCryptoShim.NotLinkedError {
            // Phase 1 fallback: stage unencrypted for main app
            onProgress(0.5, "Saving locally...")
            try stageForMainApp(
                fileID: fileID,
                fileData: fileData,
                fileName: fileName,
                parentId: parentId
            )
            onProgress(1.0, "Saved")
            return .staged(fileId: fileID)
        }
    }

    // MARK: - Direct Upload (Phase 2)

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

    // MARK: - Stage for Main App (Phase 1 fallback)

    /// Stages the file into IncomingShares/ with a .json manifest compatible
    /// with PendingSharesAccess.swift. The main app picks these up via the
    /// existing native bridge (listPendingShares → consumePendingShare → upload).
    ///
    /// The manifest includes `parentId` in the filename field as a prefix hack:
    /// "parentId:originalName" — the main app's handler parses this to route
    /// the upload to the correct folder. If no parentId, just the original name.
    private func stageForMainApp(
        fileID: String,
        fileData: Data,
        fileName: String,
        parentId: String?
    ) throws {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else {
            throw UploadError.noAppGroup
        }

        let incomingDir = containerURL.appendingPathComponent(Self.incomingDir, isDirectory: true)
        try FileManager.default.createDirectory(at: incomingDir, withIntermediateDirectories: true)

        // Determine file extension
        let ext = (fileName as NSString).pathExtension
        let storedFilename = ext.isEmpty ? fileID : "\(fileID).\(ext)"

        // Write file payload
        let fileURL = incomingDir.appendingPathComponent(storedFilename)
        try fileData.write(to: fileURL)

        // Write manifest in the format PendingSharesAccess.swift expects
        let manifest = IncomingShareManifest(
            id: fileID,
            filename: fileName,
            relativePath: storedFilename,
            mimeType: mimeTypeForExtension(ext),
            sizeBytes: Int64(fileData.count),
            timestamp: Date().timeIntervalSince1970,
            kind: kindForExtension(ext),
            parentId: parentId
        )

        let manifestURL = incomingDir.appendingPathComponent("\(fileID).json")
        let encoded = try JSONEncoder().encode(manifest)
        try encoded.write(to: manifestURL)

        // Write parentId mapping as a JSON file in the App Group container.
        // The main app's PendingSharesHandler.ts reads this via expo-file-system/next
        // Paths.appleSharedContainers to route uploads to the correct folder.
        if let pid = parentId {
            let mapURL = containerURL.appendingPathComponent("share-parent-map.json")
            var parentMap: [String: String] = [:]
            if let existingData = try? Data(contentsOf: mapURL),
               let existing = try? JSONDecoder().decode([String: String].self, from: existingData) {
                parentMap = existing
            }
            parentMap[fileID] = pid
            if let mapData = try? JSONEncoder().encode(parentMap) {
                try? mapData.write(to: mapURL)
            }
        }
    }

    // MARK: - Helpers

    private func mimeTypeForExtension(_ ext: String) -> String? {
        switch ext.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "mp4": return "video/mp4"
        case "mov": return "video/quicktime"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        case "url": return "text/uri-list"
        default: return nil
        }
    }

    private func kindForExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "jpg", "jpeg", "png", "gif", "heic", "webp": return "image"
        case "mp4", "mov", "avi": return "video"
        case "url": return "url"
        case "txt": return "text"
        default: return "file"
        }
    }
}
