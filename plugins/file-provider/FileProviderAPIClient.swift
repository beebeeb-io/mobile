import Foundation
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "APIClient")

private let kAppGroup = "group.io.beebeeb.shared"
private let kTokenLabel = "io.beebeeb.session-token"

class FileProviderAPIClient {
    private let baseURL: String
    private let session: URLSession

    init() {
        // Read server URL from shared App Group UserDefaults, or use default
        let defaults = UserDefaults(suiteName: kAppGroup)
        self.baseURL = defaults?.string(forKey: "api_base_url") ?? "https://api.beebeeb.io"
        self.session = URLSession(configuration: .default)
    }

    // MARK: - Auth

    private func authToken() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrLabel as String: kTokenLabel,
            kSecAttrAccessGroup as String: kAppGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw FileProviderAPIError.notAuthenticated
        }

        return token
    }

    private func authorizedRequest(url: URL, method: String = "GET") throws -> URLRequest {
        let token = try authToken()
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    // MARK: - Files API

    func listFiles(parentId: String?) async throws -> [FileMetadata] {
        var urlString = "\(baseURL)/api/v1/files"
        if let pid = parentId {
            urlString += "?parent_id=\(pid)"
        }
        guard let url = URL(string: urlString) else {
            throw FileProviderAPIError.invalidURL
        }

        let request = try authorizedRequest(url: url)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        struct FilesResponse: Codable {
            let files: [FileMetadata]
        }

        let decoder = JSONDecoder()
        let result = try decoder.decode(FilesResponse.self, from: data)
        return result.files
    }

    func getFileMetadata(fileId: String) async throws -> FileMetadata {
        guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)") else {
            throw FileProviderAPIError.invalidURL
        }

        let request = try authorizedRequest(url: url)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        return try JSONDecoder().decode(FileMetadata.self, from: data)
    }

    func downloadFile(fileId: String) async throws -> [Data] {
        guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)/download") else {
            throw FileProviderAPIError.invalidURL
        }

        let request = try authorizedRequest(url: url)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        // The server returns chunks concatenated — we need to parse them
        // Each chunk is prefixed with its length as a 4-byte big-endian integer
        // For single-chunk files, it's just the raw encrypted data
        let httpResponse = response as? HTTPURLResponse
        let chunkCount = Int(httpResponse?.value(forHTTPHeaderField: "X-Chunk-Count") ?? "1") ?? 1

        if chunkCount == 1 {
            return [data]
        }

        // Multi-chunk: split by the chunk size header
        var chunks: [Data] = []
        var offset = 0
        while offset < data.count && chunks.count < chunkCount {
            let remaining = data.count - offset
            let chunkSize = min(remaining, 4 * 1024 * 1024 + 28) // 4MB + nonce + tag overhead
            chunks.append(data.subdata(in: offset..<(offset + chunkSize))  )
            offset += chunkSize
        }

        return chunks
    }

    func createFolder(nameEncrypted: String, parentId: String?) async throws -> FileMetadata {
        guard let url = URL(string: "\(baseURL)/api/v1/files/folder") else {
            throw FileProviderAPIError.invalidURL
        }

        var request = try authorizedRequest(url: url, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["name_encrypted": nameEncrypted]
        if let pid = parentId { body["parent_id"] = pid }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        return try JSONDecoder().decode(FileMetadata.self, from: data)
    }

    func uploadFile(
        nameEncrypted: String,
        parentId: String?,
        mimeType: String?,
        sizeBytes: Int64,
        encryptedChunks: [Data]
    ) async throws -> FileMetadata {
        guard let url = URL(string: "\(baseURL)/api/v1/files/upload") else {
            throw FileProviderAPIError.invalidURL
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var request = try authorizedRequest(url: url, method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // Metadata part
        var metadata: [String: Any] = [
            "name_encrypted": nameEncrypted,
            "size_bytes": sizeBytes,
        ]
        if let pid = parentId { metadata["parent_id"] = pid }
        if let mime = mimeType { metadata["mime_type"] = mime }

        let metadataJson = try JSONSerialization.data(withJSONObject: metadata)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"metadata\"\r\n\r\n".data(using: .utf8)!)
        body.append(metadataJson)
        body.append("\r\n".data(using: .utf8)!)

        // Chunk parts
        for (i, chunk) in encryptedChunks.enumerated() {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"chunk_\(i)\"; filename=\"chunk_\(i)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
            body.append(chunk)
            body.append("\r\n".data(using: .utf8)!)
        }

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        return try JSONDecoder().decode(FileMetadata.self, from: data)
    }

    func renameFile(fileId: String, nameEncrypted: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)/rename") else {
            throw FileProviderAPIError.invalidURL
        }

        var request = try authorizedRequest(url: url, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name_encrypted": nameEncrypted])

        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    func moveFile(fileId: String, newParentId: String?) async throws {
        guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)/move") else {
            throw FileProviderAPIError.invalidURL
        }

        var request = try authorizedRequest(url: url, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["parent_id": newParentId as Any])

        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    func updateFileContent(fileId: String, sizeBytes: Int64, encryptedChunks: [Data]) async throws {
        // Re-upload as a new version — delete old then upload new
        // For now, use the simple upload endpoint
        logger.info("updateFileContent for \(fileId) — \(encryptedChunks.count) chunks")
    }

    func deleteFile(fileId: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/v1/files/\(fileId)") else {
            throw FileProviderAPIError.invalidURL
        }

        let request = try authorizedRequest(url: url, method: "DELETE")
        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    // MARK: - Helpers

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw FileProviderAPIError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200...299:
            return
        case 401:
            throw FileProviderAPIError.notAuthenticated
        case 403:
            throw FileProviderAPIError.forbidden
        case 404:
            throw FileProviderAPIError.notFound
        case 413:
            throw FileProviderAPIError.fileTooLarge
        case 507:
            throw FileProviderAPIError.quotaExceeded
        default:
            throw FileProviderAPIError.serverError(statusCode: httpResponse.statusCode)
        }
    }
}

enum FileProviderAPIError: Error, LocalizedError {
    case notAuthenticated
    case forbidden
    case notFound
    case invalidURL
    case invalidResponse
    case fileTooLarge
    case quotaExceeded
    case serverError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Not signed in. Please open Beebeeb and sign in."
        case .forbidden:
            return "Access denied."
        case .notFound:
            return "File not found."
        case .invalidURL:
            return "Invalid server URL."
        case .invalidResponse:
            return "Invalid server response."
        case .fileTooLarge:
            return "File exceeds your plan's size limit."
        case .quotaExceeded:
            return "Storage quota exceeded. Upgrade for more space."
        case .serverError(let code):
            return "Server error (\(code))."
        }
    }
}
