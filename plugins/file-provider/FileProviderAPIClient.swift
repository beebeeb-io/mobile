import FileProvider
import Foundation
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "APIClient")

private let kAppGroup = "group.io.beebeeb.shared"
private let kSharedSessionTokenKey = "io.beebeeb.sessionToken"
private let kSharedAPIBaseURLKey = "io.beebeeb.apiBaseUrl"
#if DEBUG && targetEnvironment(simulator)
private let kFallbackAPIBaseURL = "http://localhost:3001"
#else
private let kFallbackAPIBaseURL = "https://api.beebeeb.io"
#endif
private let kFileProviderEnabledKey = "io.beebeeb.fileProvider.enabled"
private let kFileProviderAuthRequiredKey = "io.beebeeb.fileProvider.requireDeviceAuth"
private let kFileProviderUnlockedUntilKey = "io.beebeeb.fileProvider.unlockedUntilMs"

private func sharedDefaults() -> UserDefaults? {
    UserDefaults(suiteName: kAppGroup)
}

private func appGroupPreferencesURL() -> URL? {
    FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: kAppGroup)?
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Preferences", isDirectory: true)
        .appendingPathComponent("\(kAppGroup).plist", isDirectory: false)
}

#if DEBUG && targetEnvironment(simulator)
private func rawAppGroupPreferences() -> [String: Any] {
    guard
        let url = appGroupPreferencesURL(),
        let data = try? Data(contentsOf: url),
        let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
        let values = plist as? [String: Any]
    else {
        return [:]
    }
    return values
}
#endif

private func appGroupObject(_ defaults: UserDefaults?, key: String) -> Any? {
#if DEBUG && targetEnvironment(simulator)
    if let rawValue = rawAppGroupPreferences()[key] {
        return rawValue
    }
#endif
    return defaults?.object(forKey: key)
}

private func appGroupString(_ defaults: UserDefaults?, key: String) -> String? {
    if let value = appGroupObject(defaults, key: key) as? String {
        return value
    }
    return defaults?.string(forKey: key)
}

private func appGroupBool(_ defaults: UserDefaults?, key: String) -> Bool? {
    switch appGroupObject(defaults, key: key) {
    case let value as Bool:
        return value
    case let value as NSNumber:
        return value.boolValue
    case let value as String:
        return ["true", "1", "yes"].contains(value.lowercased())
    default:
        return nil
    }
}

private func appGroupDouble(_ defaults: UserDefaults?, key: String) -> Double {
    switch appGroupObject(defaults, key: key) {
    case let value as Double:
        return value
    case let value as Int:
        return Double(value)
    case let value as Int64:
        return Double(value)
    case let value as NSNumber:
        return value.doubleValue
    case let value as String:
        return Double(value) ?? 0
    default:
        return defaults?.double(forKey: key) ?? 0
    }
}

private func boolDefaultTrue(_ defaults: UserDefaults?, key: String) -> Bool {
    guard let value = appGroupBool(defaults, key: key) else {
        return true
    }
    return value
}

func clearFileProviderTemporaryFiles() {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("BeebeebFileProvider", isDirectory: true)
    try? FileManager.default.removeItem(at: url)
}

func validateFileProviderAccess() throws {
    let defaults = sharedDefaults()
    let isEnabled = boolDefaultTrue(defaults, key: kFileProviderEnabledKey)
    guard isEnabled else {
        clearFileProviderTemporaryFiles()
        throw FileProviderAPIError.fileProviderDisabled
    }

    let requiresAuth = boolDefaultTrue(defaults, key: kFileProviderAuthRequiredKey)
    guard requiresAuth else {
        return
    }

    let nowMs = Date().timeIntervalSince1970 * 1000
    let unlockedUntilMs = appGroupDouble(defaults, key: kFileProviderUnlockedUntilKey)
    logger.info("File Provider access state enabled=\(isEnabled), requiresAuth=\(requiresAuth), unlockedUntilMs=\(unlockedUntilMs), nowMs=\(nowMs)")
    guard unlockedUntilMs > nowMs else {
        clearFileProviderTemporaryFiles()
        throw FileProviderAPIError.fileProviderLocked
    }
}

class FileProviderAPIClient {
    private let session: URLSession

    init() {
        self.session = URLSession(configuration: .default)
    }

    // MARK: - Auth

    private func authToken() throws -> String {
        guard
            let token = appGroupString(UserDefaults(suiteName: kAppGroup), key: kSharedSessionTokenKey),
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

    private func currentBaseURL() -> URL {
        let rawBaseURL = appGroupString(UserDefaults(suiteName: kAppGroup), key: kSharedAPIBaseURLKey) ?? kFallbackAPIBaseURL
        return URL(string: rawBaseURL) ?? URL(string: kFallbackAPIBaseURL)!
    }

    private func filesURL(pathComponents: [String] = [], queryItems: [URLQueryItem] = []) throws -> URL {
        var url = currentBaseURL()
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
        var url = currentBaseURL()
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

    func updateFileContent(
        fileId: String,
        sizeBytes: Int64,
        encryptedChunks: [Data],
        baseVersionNumber: Int?
    ) async throws -> FileMetadata {
        let existing = try await getFileMetadata(fileId: fileId)

        let initURL = uploadsURL(pathComponents: ["init"])
        var initRequest = try authorizedRequest(url: initURL, method: "POST")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var initBody: [String: Any] = [
            "file_id": fileId,
            "file_name": existing.nameEncrypted,
            "file_size_bytes": sizeBytes,
            "mime_type": existing.mimeType as Any? ?? NSNull(),
            "parent_id": existing.parentId as Any? ?? NSNull(),
            "profile": "mobile",
            "chunk_size_bytes": kDefaultPlaintextChunkSize,
            "chunk_count": encryptedChunks.count,
        ]
        initBody["base_version_number"] = baseVersionNumber as Any? ?? NSNull()
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: initBody)

        let (initData, initResponse) = try await session.data(for: initRequest)
        try validateResponse(initResponse)

        struct InitResponse: Codable {
            let fileId: String
            let uploadSessionId: String

            enum CodingKeys: String, CodingKey {
                case fileId = "file_id"
                case uploadSessionId = "upload_session_id"
            }
        }
        let initResult = try JSONDecoder().decode(InitResponse.self, from: initData)

        for (index, chunk) in encryptedChunks.enumerated() {
            let chunkURL = uploadsURL(pathComponents: [initResult.uploadSessionId, "chunks", String(index)])
            var chunkRequest = try authorizedRequest(url: chunkURL, method: "PUT")
            chunkRequest.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            chunkRequest.httpBody = chunk
            let (_, chunkResponse) = try await session.data(for: chunkRequest)
            try validateResponse(chunkResponse)
        }

        let completeURL = uploadsURL(pathComponents: [initResult.uploadSessionId, "complete"])
        var completeRequest = try authorizedRequest(url: completeURL, method: "POST")
        completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        completeRequest.httpBody = Data("{}".utf8)
        let (_, completeResponse) = try await session.data(for: completeRequest)
        try validateResponse(completeResponse)

        return try await getFileMetadata(fileId: initResult.fileId)
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
        case 409:
            throw FileProviderAPIError.conflict
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
    case fileProviderDisabled
    case fileProviderLocked
    case conflict
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
        case .fileProviderDisabled:
            return "Beebeeb is hidden from Files. Open Beebeeb Settings to show it again."
        case .fileProviderLocked:
            return "Beebeeb is locked. Open Beebeeb and unlock Files access."
        case .conflict:
            return "This file changed while Files was editing it. Reload the file and try again."
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
        case .notAuthenticated, .fileProviderLocked:
            return NSFileProviderError(.notAuthenticated)
        case .fileProviderDisabled:
            return NSFileProviderError(.providerNotFound)
        case .notFound:
            return NSFileProviderError(.noSuchItem)
        case .conflict:
            if #available(iOS 26.0, *) {
                return NSFileProviderError(.localVersionConflictingWithServer)
            }
            return NSError(
                domain: NSCocoaErrorDomain,
                code: NSFileWriteUnknownError,
                userInfo: [NSLocalizedDescriptionKey: description]
            )
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
