import FileProvider
import Foundation
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "APIClient")

private let kAppGroup = "group.io.beebeeb.shared"
private let kSharedSessionTokenKey = "io.beebeeb.sessionToken"
private let kSharedAPIBaseURLKey = "io.beebeeb.apiBaseUrl"
private let kFallbackAPIBaseURL = "https://api.beebeeb.io"

class FileProviderAPIClient {
    private let baseURL: URL
    private let session: URLSession

    init() {
        let defaults = UserDefaults(suiteName: kAppGroup)
        let rawBaseURL = defaults?.string(forKey: kSharedAPIBaseURLKey) ?? kFallbackAPIBaseURL
        self.baseURL = URL(string: rawBaseURL) ?? URL(string: kFallbackAPIBaseURL)!
        self.session = URLSession(configuration: .default)
    }

    // MARK: - Auth

    private func authToken() throws -> String {
        guard
            let token = UserDefaults(suiteName: kAppGroup)?.string(forKey: kSharedSessionTokenKey),
            !token.isEmpty
        else {
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

    private func filesURL(pathComponents: [String] = [], queryItems: [URLQueryItem] = []) throws -> URL {
        var url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("files")

        for component in pathComponents {
            url.appendPathComponent(component)
        }

        if !queryItems.isEmpty {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                throw FileProviderAPIError.invalidURL
            }
            components.queryItems = queryItems
            guard let resolved = components.url else {
                throw FileProviderAPIError.invalidURL
            }
            return resolved
        }

        return url
    }

    private func uploadsURL(pathComponents: [String] = []) -> URL {
        var url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("uploads")
        for component in pathComponents {
            url.appendPathComponent(component)
        }
        return url
    }

    // MARK: - Files API

    func listFiles(parentId: String?) async throws -> [FileMetadata] {
        var queryItems: [URLQueryItem] = []
        if let pid = parentId {
            queryItems.append(URLQueryItem(name: "parent_id", value: pid))
        }
        queryItems.append(URLQueryItem(name: "limit", value: "500"))
        let url = try filesURL(queryItems: queryItems)

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

    func listWorkingSet() async throws -> [FileMetadata] {
        let url = try filesURL(queryItems: [
            URLQueryItem(name: "recent", value: "true"),
            URLQueryItem(name: "limit", value: "500"),
        ])

        let request = try authorizedRequest(url: url)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        struct FilesResponse: Codable {
            let files: [FileMetadata]
        }

        return try JSONDecoder().decode(FilesResponse.self, from: data).files
    }

    func getFileMetadata(fileId: String) async throws -> FileMetadata {
        let url = try filesURL(pathComponents: [fileId])

        let request = try authorizedRequest(url: url)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        return try JSONDecoder().decode(FileMetadata.self, from: data)
    }

    func downloadFile(fileId: String) async throws -> DownloadedEncryptedFile {
        let url = try filesURL(pathComponents: [fileId, "download"])

        let request = try authorizedRequest(url: url)
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        let httpResponse = response as? HTTPURLResponse
        let chunkCount = Int(httpResponse?.value(forHTTPHeaderField: "X-Chunk-Count") ?? "1") ?? 1
        let chunkSize = Int(httpResponse?.value(forHTTPHeaderField: "X-Chunk-Size") ?? "") ?? kDefaultPlaintextChunkSize
        return DownloadedEncryptedFile(data: data, chunkCount: max(1, chunkCount), chunkSize: max(1, chunkSize))
    }

    func createFolder(folderId: String, nameEncrypted: String, parentId: String?) async throws -> FileMetadata {
        let url = try filesURL(pathComponents: ["folder"])

        var request = try authorizedRequest(url: url, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "folder_id": folderId,
            "name_encrypted": nameEncrypted,
            "parent_id": parentId as Any? ?? NSNull(),
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        return try JSONDecoder().decode(FileMetadata.self, from: data)
    }

    func uploadEncryptedFile(
        fileId: String,
        nameEncrypted: String,
        parentId: String?,
        mimeType: String?,
        sizeBytes: Int64,
        encryptedChunks: [Data]
    ) async throws -> FileMetadata {
        let initURL = try filesURL(pathComponents: ["upload", "init"])
        var initRequest = try authorizedRequest(url: initURL, method: "POST")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "file_id": fileId,
            "name_encrypted": nameEncrypted,
            "parent_id": parentId as Any? ?? NSNull(),
            "mime_type": mimeType as Any? ?? NSNull(),
            "size_bytes": sizeBytes,
            "chunk_count": encryptedChunks.count,
        ])

        let (initData, initResponse) = try await session.data(for: initRequest)
        try validateResponse(initResponse)

        struct InitResponse: Codable {
            let fileId: String

            enum CodingKeys: String, CodingKey {
                case fileId = "file_id"
            }
        }
        let serverFileId = try JSONDecoder().decode(InitResponse.self, from: initData).fileId

        for (index, chunk) in encryptedChunks.enumerated() {
            let chunkURL = try filesURL(pathComponents: [serverFileId, "chunks", String(index)])
            var chunkRequest = try authorizedRequest(url: chunkURL, method: "PUT")
            chunkRequest.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            chunkRequest.httpBody = chunk
            let (_, chunkResponse) = try await session.data(for: chunkRequest)
            try validateResponse(chunkResponse)
        }

        let completeURL = try filesURL(pathComponents: [serverFileId, "upload", "complete"])
        var completeRequest = try authorizedRequest(url: completeURL, method: "POST")
        completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        completeRequest.httpBody = Data("{}".utf8)
        let (data, completeResponse) = try await session.data(for: completeRequest)
        try validateResponse(completeResponse)

        return try JSONDecoder().decode(FileMetadata.self, from: data)
    }

    func renameFile(fileId: String, nameEncrypted: String) async throws {
        let url = try filesURL(pathComponents: [fileId])

        var request = try authorizedRequest(url: url, method: "PATCH")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name_encrypted": nameEncrypted])

        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    func moveFile(fileId: String, newParentId: String?) async throws {
        let url = try filesURL(pathComponents: [fileId])

        var request = try authorizedRequest(url: url, method: "PATCH")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["parent_id": newParentId as Any? ?? NSNull()])

        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    func updateFileContent(fileId: String, sizeBytes: Int64, encryptedChunks: [Data]) async throws {
        logger.info("updateFileContent unsupported for \(fileId) — \(encryptedChunks.count) chunks, \(sizeBytes) bytes")
        throw FileProviderAPIError.unsupportedOperation("Replacing an existing file's encrypted chunk set requires a server replacement/upload-session contract.")
    }

    func deleteFile(fileId: String) async throws {
        let url = try filesURL(pathComponents: [fileId])

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
    case unsupportedOperation(String)
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
        case .unsupportedOperation(let message):
            return message
        case .serverError(let code):
            return "Server error (\(code))."
        }
    }
}

struct DownloadedEncryptedFile {
    let data: Data
    let chunkCount: Int
    let chunkSize: Int
}

let kDefaultPlaintextChunkSize = 4 * 1024 * 1024

func fileProviderError(_ error: Error) -> Error {
    let description = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription

    if let apiError = error as? FileProviderAPIError {
        switch apiError {
        case .notAuthenticated:
            return NSFileProviderError(.notAuthenticated)
        case .notFound:
            return NSFileProviderError(.noSuchItem)
        case .quotaExceeded:
            return NSFileProviderError(.insufficientQuota)
        case .forbidden:
            return NSError(
                domain: NSCocoaErrorDomain,
                code: NSUserCancelledError,
                userInfo: [NSLocalizedDescriptionKey: description]
            )
        case .fileTooLarge, .unsupportedOperation:
            return NSError(
                domain: NSCocoaErrorDomain,
                code: NSFeatureUnsupportedError,
                userInfo: [NSLocalizedDescriptionKey: description]
            )
        case .invalidURL, .invalidResponse, .serverError:
            return NSFileProviderError(.serverUnreachable)
        }
    }

    if let cryptoError = error as? FileProviderCryptoError {
        switch cryptoError {
        case .noMasterKey:
            return NSFileProviderError(.notAuthenticated)
        case .invalidChunkFormat, .invalidMetadataFormat, .keychainReadFailed, .keychainDecryptFailed:
            return NSError(
                domain: NSCocoaErrorDomain,
                code: NSFileReadCorruptFileError,
                userInfo: [NSLocalizedDescriptionKey: description]
            )
        }
    }

    if let urlError = error as? URLError {
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .timedOut:
            return NSFileProviderError(.serverUnreachable)
        default:
            break
        }
    }

    return error
}
