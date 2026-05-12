import FileProvider
import UniformTypeIdentifiers
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "FileProvider")
private let trashContainerIdentifier = NSFileProviderItemIdentifier("NSFileProviderTrashContainerItemIdentifier")

class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    private let apiClient: FileProviderAPIClient
    private let cryptoClient: FileProviderCrypto

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        self.apiClient = FileProviderAPIClient()
        self.cryptoClient = FileProviderCrypto()
        super.init()
        logger.info("File Provider Extension initialized for domain: \(domain.identifier.rawValue)")
    }

    func invalidate() {
        logger.info("File Provider Extension invalidated")
    }

    // MARK: - Item Lookup

    func item(
        for identifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)

        Task {
            do {
                if identifier != .rootContainer {
                    try validateFileProviderAccess()
                }
                let item = try await fetchItem(identifier: identifier)
                completionHandler(item, nil)
            } catch {
                logger.error("item(for:) failed: \(error.localizedDescription)")
                completionHandler(nil, fileProviderError(error))
            }
            progress.completedUnitCount = 1
        }

        return progress
    }

    // MARK: - Enumeration

    func enumerator(
        for containerItemIdentifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest
    ) throws -> NSFileProviderEnumerator {
        logger.info("enumerator(for: \(containerItemIdentifier.rawValue))")

        if containerItemIdentifier == .rootContainer {
            return FileProviderEnumerator(
                scope: .root,
                apiClient: apiClient,
                crypto: cryptoClient
            )
        }

        if containerItemIdentifier == .workingSet {
            return FileProviderEnumerator(
                scope: .workingSet,
                apiClient: apiClient,
                crypto: cryptoClient
            )
        }

        if containerItemIdentifier == trashContainerIdentifier {
            return FileProviderEnumerator(
                scope: .empty("trash"),
                apiClient: apiClient,
                crypto: cryptoClient
            )
        }

        return FileProviderEnumerator(
            scope: .folder(containerItemIdentifier.rawValue),
            apiClient: apiClient,
            crypto: cryptoClient
        )
    }

    // MARK: - Fetch Contents (Download + Decrypt)

    func fetchContents(
        for itemIdentifier: NSFileProviderItemIdentifier,
        version requestedVersion: NSFileProviderItemVersion?,
        request: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 100)

        Task {
            do {
                logger.info("fetchContents for: \(itemIdentifier.rawValue)")
                try validateFileProviderAccess()

                let metadata = try await apiClient.getFileMetadata(fileId: itemIdentifier.rawValue)
                progress.completedUnitCount = 20

                let encryptedFile = try await apiClient.downloadFile(fileId: itemIdentifier.rawValue)
                progress.completedUnitCount = 60

                let plaintext = try cryptoClient.decryptFile(
                    fileId: itemIdentifier.rawValue,
                    encryptedFile: encryptedFile,
                    plaintextSize: metadata.sizeBytes,
                    metadataChunkCount: metadata.chunkCount
                )
                progress.completedUnitCount = 90

                let tempDir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("BeebeebFileProvider", isDirectory: true)
                    .appendingPathComponent(itemIdentifier.rawValue, isDirectory: true)
                try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

                let fileName = cryptoClient.decryptFilename(
                    fileId: itemIdentifier.rawValue,
                    encrypted: metadata.nameEncrypted
                ) ?? "file"
                let tempFile = tempDir.appendingPathComponent(safeFilename(fileName), isDirectory: false)
                try plaintext.write(to: tempFile, options: [.atomic, .completeFileProtection])
                progress.completedUnitCount = 100

                let item = FileProviderItem(metadata: metadata, crypto: cryptoClient)
                completionHandler(tempFile, item, nil)
            } catch {
                logger.error("fetchContents failed: \(error.localizedDescription)")
                completionHandler(nil, nil, fileProviderError(error))
            }
        }

        return progress
    }

    // MARK: - Create Item (Upload + Encrypt)

    func createItem(
        basedOn itemTemplate: NSFileProviderItem,
        fields: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 100)

        Task {
            do {
                try validateFileProviderAccess()
                if itemTemplate.contentType == .folder {
                    let folderId = UUID().uuidString.lowercased()
                    let parentId = itemTemplate.parentItemIdentifier == .rootContainer
                        ? nil
                        : itemTemplate.parentItemIdentifier.rawValue

                    let encryptedName = try cryptoClient.encryptFilename(
                        fileId: folderId,
                        name: itemTemplate.filename,
                        mimeType: nil
                    )

                    let metadata = try await apiClient.createFolder(
                        folderId: folderId,
                        nameEncrypted: encryptedName,
                        parentId: parentId
                    )
                    progress.completedUnitCount = 100

                    let item = FileProviderItem(metadata: metadata, crypto: cryptoClient)
                    completionHandler(item, [], false, nil)
                } else if let fileURL = url {
                    let fileId = UUID().uuidString.lowercased()
                    let parentId = itemTemplate.parentItemIdentifier == .rootContainer
                        ? nil
                        : itemTemplate.parentItemIdentifier.rawValue

                    let plaintext = try Data(contentsOf: fileURL)
                    progress.completedUnitCount = 10

                    let encryptedName = try cryptoClient.encryptFilename(
                        fileId: fileId,
                        name: itemTemplate.filename,
                        mimeType: itemTemplate.contentType?.preferredMIMEType
                    )

                    let encrypted = try cryptoClient.encryptFile(
                        fileId: fileId,
                        plaintext: plaintext
                    )
                    progress.completedUnitCount = 50

                    let metadata = try await apiClient.uploadEncryptedFile(
                        fileId: fileId,
                        nameEncrypted: encryptedName,
                        parentId: parentId,
                        mimeType: itemTemplate.contentType?.preferredMIMEType,
                        sizeBytes: Int64(plaintext.count),
                        encryptedChunks: encrypted
                    )
                    progress.completedUnitCount = 100

                    let item = FileProviderItem(metadata: metadata, crypto: cryptoClient)
                    completionHandler(item, [], false, nil)
                } else {
                    completionHandler(nil, [], false, NSFileProviderError(.noSuchItem))
                }
            } catch {
                logger.error("createItem failed: \(error.localizedDescription)")
                completionHandler(nil, [], false, fileProviderError(error))
            }
        }

        return progress
    }

    // MARK: - Modify Item

    func modifyItem(
        _ item: NSFileProviderItem,
        baseVersion version: NSFileProviderItemVersion,
        changedFields: NSFileProviderItemFields,
        contents newContents: URL?,
        options: NSFileProviderModifyItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 100)

        Task {
            do {
                try validateFileProviderAccess()
                let fileId = item.itemIdentifier.rawValue

                if changedFields.contains(.contents) {
                    throw FileProviderAPIError.unsupportedOperation("File Provider content replacement is not enabled until the server replacement-upload contract is wired.")
                }

                // Handle rename
                if changedFields.contains(.filename) {
                    let encryptedName = try cryptoClient.encryptFilename(
                        fileId: fileId,
                        name: item.filename,
                        mimeType: item.contentType?.preferredMIMEType
                    )
                    try await apiClient.renameFile(fileId: fileId, nameEncrypted: encryptedName)
                }

                // Handle move
                if changedFields.contains(.parentItemIdentifier) {
                    let newParentId = item.parentItemIdentifier == .rootContainer
                        ? nil
                        : item.parentItemIdentifier.rawValue
                    try await apiClient.moveFile(fileId: fileId, newParentId: newParentId)
                }

                progress.completedUnitCount = 90

                let metadata = try await apiClient.getFileMetadata(fileId: fileId)
                let updatedItem = FileProviderItem(metadata: metadata, crypto: cryptoClient)
                progress.completedUnitCount = 100

                completionHandler(updatedItem, [], false, nil)
            } catch {
                logger.error("modifyItem failed: \(error.localizedDescription)")
                completionHandler(nil, [], false, fileProviderError(error))
            }
        }

        return progress
    }

    // MARK: - Delete Item

    func deleteItem(
        identifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)

        Task {
            do {
                try validateFileProviderAccess()
                try await apiClient.deleteFile(fileId: identifier.rawValue)
                completionHandler(nil)
            } catch {
                logger.error("deleteItem failed: \(error.localizedDescription)")
                completionHandler(fileProviderError(error))
            }
            progress.completedUnitCount = 1
        }

        return progress
    }

    // MARK: - Private helpers

    private func fetchItem(identifier: NSFileProviderItemIdentifier) async throws -> FileProviderItem {
        if identifier == .rootContainer {
            return FileProviderItem.rootContainer
        }
        if identifier == trashContainerIdentifier {
            throw FileProviderAPIError.notFound
        }
        let metadata = try await apiClient.getFileMetadata(fileId: identifier.rawValue)
        return FileProviderItem(metadata: metadata, crypto: cryptoClient)
    }

    private func safeFilename(_ value: String) -> String {
        let invalid = CharacterSet(charactersIn: "/:\\")
            .union(.newlines)
            .union(.controlCharacters)
        let components = value.components(separatedBy: invalid).filter { !$0.isEmpty }
        let cleaned = components.joined(separator: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "file" : cleaned
    }
}
