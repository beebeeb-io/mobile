import Foundation
import Security

struct SharedKeyEntryNative { let fileId: String; let wrapped: Data; let kind: UInt8 }
struct FolderLinkMintNative {
    let kc: String
    let wrappedFolderKey: Data
    let ownerWrappedKey: Data
    let ownerWrappedToken: Data
}
enum SharedKeyError: LocalizedError {
    case locked, invalidWrap, random
    var errorDescription: String? {
        switch self {
        case .locked: return "Vault is locked"
        case .invalidWrap: return "Invalid shared key wrap"
        case .random: return "Secure random generator failed"
        }
    }
}

enum SharedKeyOps {
    static let registry = SharedKeyRegistry<FileKeyHandle>()
    static func folder(_ id: Int, registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> (handle: FileKeyHandle, folderId: String) {
        guard let folder = registry.folder(id) else { throw SharedKeyError.locked }
        return folder
    }
    static func wire(_ encrypted: EncryptedData) -> Data { encrypted.nonce + encrypted.ciphertext }
    static func openOwnerFolderKey(master: MasterKeyHandle, folderId: String, wrapped: Data,
                                   registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> Int {
        let epoch = registry.generation
        guard wrapped.count == 60 else { throw SharedKeyError.invalidWrap }
        let key = try master.unwrapFolderCustody(folderId: folderId, nonce: Data(wrapped.prefix(12)), ciphertext: Data(wrapped.dropFirst(12)))
        guard let id = registry.storeFolderIfCurrent(key, folderId: folderId, generation: epoch) else { throw SharedKeyError.locked }
        return id
    }
    static func generateFolderKey(master: MasterKeyHandle, folderId: String,
                                  registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> (handleId: Int, ownerWrapped: Data) {
        let epoch = registry.generation
        let key = try FileKeyHandle.generate()
        let wrapped = try wire(master.wrapFolderCustody(folderId: folderId, inner: key))
        guard let id = registry.storeFolderIfCurrent(key, folderId: folderId, generation: epoch) else { throw SharedKeyError.locked }
        return (id, wrapped)
    }
    static func loadFileKeys(folderId: Int, entries: [SharedKeyEntryNative],
                             registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> (loaded: [String], failed: [String]) {
        let epoch = registry.generation
        let folder = try folder(folderId, registry: registry)
        var loaded: [String] = [], failed: [String] = []
        for entry in entries {
            do {
                guard entry.wrapped.count == 60, entry.kind == 1 || entry.kind == 2 else { throw SharedKeyError.invalidWrap }
                let opened = try folder.handle.unwrapFolderChild(sharedFolderId: folder.folderId, itemId: entry.fileId, kind: entry.kind, nonce: Data(entry.wrapped.prefix(12)), ciphertext: Data(entry.wrapped.dropFirst(12)))
                if registry.storeFile(entry.fileId, opened, generation: epoch) { loaded.append(entry.fileId) }
                else { failed.append(entry.fileId) }
            } catch { failed.append(entry.fileId) }
        }
        return (loaded, failed)
    }
    static func openOwnerFileKey(master: MasterKeyHandle, fileId: String, wrapped: Data,
                                 registry: SharedKeyRegistry<FileKeyHandle> = registry) -> Bool {
        let epoch = registry.generation
        do {
            guard wrapped.count == 60 else { return false }
            let key = try master.unwrapOwnerFileKey(itemId: fileId, nonce: Data(wrapped.prefix(12)), ciphertext: Data(wrapped.dropFirst(12)))
            return registry.storeFile(fileId, key, generation: epoch)
        }
        catch { return false }
    }
    static func wrapChildKeys(master: MasterKeyHandle, folderId: Int, fileIds: [String], kind: UInt8 = 1,
                              registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> [SharedKeyEntryNative] {
        let folder = try folder(folderId, registry: registry)
        guard kind == 1 || kind == 2 else { throw SharedKeyError.invalidWrap }
        return try fileIds.map { id in SharedKeyEntryNative(fileId: id, wrapped: try wire(folder.handle.wrapFolderChild(sharedFolderId: folder.folderId, itemId: id, kind: kind, inner: fileKey(master: master, fileId: id, registry: registry))), kind: kind) }
    }
    static func adoptWrap(master: MasterKeyHandle, fileId: String,
                          registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> Data {
        guard let key = registry.file(fileId) else { throw SharedKeyError.locked }
        return try wire(master.wrapOwnerFileKey(itemId: fileId, inner: key))
    }
    static func fileKey(master: MasterKeyHandle, fileId: String,
                        registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> FileKeyHandle {
        try pickKey(table: registry.file(fileId)) { try master.deriveFileKey(fileId: Data(fileId.utf8)) }
    }
    // Read the pin from authenticated file metadata, never HTTP format headers.
    static func previewChunkFormat(master: MasterKeyHandle, fileId: String, nameEncrypted: String,
                                   registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> UInt8 {
        if let key = registry.file(fileId) {
            return try key.decryptFileMetadata(nameEncrypted: nameEncrypted).chunkFormat
        }
        return try master.decryptFileMetadata(fileId: fileId, nameEncrypted: nameEncrypted).chunkFormat
    }
    static func chunkDecryptor(master: MasterKeyHandle, fileId: String, expectedChunkFormat: UInt8,
                               registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> ChunkDecryptorHandle {
        if let key = registry.file(fileId) {
            return try ChunkDecryptorHandle.forPushWithFileKeyHandle(fileKey: key, fileId: fileId, expectedChunkFormat: expectedChunkFormat)
        }
        return try ChunkDecryptorHandle.forPush(masterKey: master, fileId: fileId, expectedChunkFormat: expectedChunkFormat)
    }
    static func mintLink(master: MasterKeyHandle, folderId: Int, token: String, passphrase: String?, shareId: String,
                         registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> FolderLinkMintNative {
        let key = try folder(folderId, registry: registry).handle
        var kc = Data(count: 32)
        defer { kc.resetBytes(in: 0..<kc.count) }
        let status = kc.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw SharedKeyError.random }
        // The throwing branch is deliberate: Argon failure never selects the plain constructor.
        let link = try passphrase.map { try FileKeyHandle.fromFolderLinkPassphrase(kC: kc, passphrase: $0, token: token) }
            ?? FileKeyHandle.fromFolderLink(kC: kc, passphraseStretch: nil)
        return try FolderLinkMintNative(kc: base64url(kc), wrappedFolderKey: wire(link.wrapKey(inner: key)),
            ownerWrappedKey: wire(master.wrapLinkOwnerKey(shareId: shareId, inner: FileKeyHandle.fromKeyBytes(key: kc))),
            ownerWrappedToken: wire(master.wrapLinkOwnerToken(shareId: shareId, token: Data(token.utf8))))
    }
    static func recoverKc(master: MasterKeyHandle, folderId: Int, wrapped: Data, shareId: String,
                          registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> String? {
        let key = try folder(folderId, registry: registry).handle
        guard wrapped.count == 60 else { throw SharedKeyError.invalidWrap }
        // Legacy generic wraps are incompatible with L6; never retry under an old key.
        guard var candidate = try? master.unwrapLinkOwnerKey(shareId: shareId, nonce: Data(wrapped.prefix(12)), ciphertext: Data(wrapped.dropFirst(12))) else { return nil }
        defer { candidate.resetBytes(in: 0..<candidate.count) }
        guard candidate.count == 32 else { throw SharedKeyError.invalidWrap }
        if try FileKeyHandle.fromKeyBytes(key: candidate).keyId() == key.keyId() { return nil }
        return base64url(candidate)
    }
    static func decryptNames(master: MasterKeyHandle, items: [BatchNameItem],
                             registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> [BatchNameResult] {
        var fromTable: [(index: Int, value: BatchNameResult)] = []
        var remaining: [BatchNameItem] = [], indices: [Int] = []
        for (index, item) in items.enumerated() {
            if let key = registry.file(item.fileId) {
                do {
                    let value = try key.decryptNameMetadata(nameEncrypted: item.nameEncrypted)
                    fromTable.append((index, BatchNameResult(name: value.name, mimeType: value.mimeType, error: nil)))
                } catch {
                    // A present but wrong table key is an error; never retry with the master.
                    fromTable.append((index, BatchNameResult(name: nil, mimeType: nil, error: String(describing: error))))
                }
            } else { remaining.append(item); indices.append(index) }
        }
        let results = remaining.isEmpty ? [] : try master.decryptNames(items: remaining)
        return mergeNameResults(count: items.count, fromTable: fromTable, fromMaster: Array(zip(indices, results)))
    }
    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
