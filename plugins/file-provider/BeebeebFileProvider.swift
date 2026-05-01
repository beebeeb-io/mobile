import FileProvider
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "FileProvider")

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
                let item = try await fetchItem(identifier: identifier)
                completionHandler(item, nil)
            } catch {
                logger.error("item(for:) failed: \(error.localizedDescription)")
                completionHandler(nil, error)
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
                parentId: nil,
                apiClient: apiClient,
                crypto: cryptoClient
            )
        }

        return FileProviderEnumerator(
            parentId: containerItemIdentifier.rawValue,
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

                // Download encrypted chunks from server
                let encryptedData = try await apiClient.downloadFile(fileId: itemIdentifier.rawValue)
                progress.completedUnitCount = 60

                // Decrypt using the file key derived from master key
                let plaintext = try cryptoClient.decryptFile(
                    fileId: itemIdentifier.rawValue,
                    encryptedChunks: encryptedData
                )
                progress.completedUnitCount = 90

                // Write plaintext to a temporary file
                let tempDir = NSFileProviderManager.default.documentStorageURL
                    .appendingPathComponent(itemIdentifier.rawValue, isDirectory: true)
                try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

                let metadata = try await apiClient.getFileMetadata(fileId: itemIdentifier.rawValue)
                let fileName = cryptoClient.decryptFilename(
                    fileId: itemIdentifier.rawValue,
                    encrypted: metadata.nameEncrypted
                ) ?? "file"
                let tempFile = tempDir.appendingPathComponent(fileName)
                try plaintext.write(to: tempFile)
                progress.completedUnitCount = 100

                let item = FileProviderItem(metadata: metadata, crypto: cryptoClient)
                completionHandler(tempFile, item, nil)
            } catch {
                logger.error("fetchContents failed: \(error.localizedDescription)")
                completionHandler(nil, nil, error)
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
                if itemTemplate.contentType == .folder {
                    // Create folder
                    let parentId = itemTemplate.parentItemIdentifier == .rootContainer
                        ? nil
                        : itemTemplate.parentItemIdentifier.rawValue

                    let encryptedName = try cryptoClient.encryptFilename(
                        parentId: parentId,
                        name: itemTemplate.filename
                    )

                    let metadata = try await apiClient.createFolder(
                        nameEncrypted: encryptedName,
                        parentId: parentId
                    )
                    progress.completedUnitCount = 100

                    let item = FileProviderItem(metadata: metadata, crypto: cryptoClient)
                    completionHandler(item, [], false, nil)
                } else if let fileURL = url {
                    // Upload file — read, encrypt, upload
                    let parentId = itemTemplate.parentItemIdentifier == .rootContainer
                        ? nil
                        : itemTemplate.parentItemIdentifier.rawValue

                    let plaintext = try Data(contentsOf: fileURL)
                    progress.completedUnitCount = 10

                    let encryptedName = try cryptoClient.encryptFilename(
                        parentId: parentId,
                        name: itemTemplate.filename
                    )

                    // Encrypt the file content
                    let encrypted = try cryptoClient.encryptFile(
                        parentId: parentId,
                        plaintext: plaintext
                    )
                    progress.completedUnitCount = 50

                    // Upload to server
                    let metadata = try await apiClient.uploadFile(
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
                completionHandler(nil, [], false, error)
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
                let fileId = item.itemIdentifier.rawValue

                // Handle rename
                if changedFields.contains(.filename) {
                    let encryptedName = try cryptoClient.encryptFilename(
                        parentId: item.parentItemIdentifier == .rootContainer ? nil : item.parentItemIdentifier.rawValue,
                        name: item.filename
                    )
                    try await apiClient.renameFile(fileId: fileId, nameEncrypted: encryptedName)
                }

                // Handle content update (re-encrypt and re-upload)
                if changedFields.contains(.contents), let fileURL = newContents {
                    let plaintext = try Data(contentsOf: fileURL)
                    let encrypted = try cryptoClient.encryptFile(
                        parentId: item.parentItemIdentifier == .rootContainer ? nil : item.parentItemIdentifier.rawValue,
                        plaintext: plaintext
                    )
                    try await apiClient.updateFileContent(
                        fileId: fileId,
                        sizeBytes: Int64(plaintext.count),
                        encryptedChunks: encrypted
                    )
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
                completionHandler(nil, [], false, error)
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
                try await apiClient.deleteFile(fileId: identifier.rawValue)
                completionHandler(nil)
            } catch {
                logger.error("deleteItem failed: \(error.localizedDescription)")
                completionHandler(error)
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
        let metadata = try await apiClient.getFileMetadata(fileId: identifier.rawValue)
        return FileProviderItem(metadata: metadata, crypto: cryptoClient)
    }
}
