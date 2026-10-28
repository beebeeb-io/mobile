import Foundation
import Security

struct SharedKeyEntryNative { let fileId: String; let wrapped: Data }
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
    static func unwrap(_ wrapper: FileKeyHandle, _ wrapped: Data) throws -> FileKeyHandle {
        guard wrapped.count == 60 else { throw SharedKeyError.invalidWrap }
        return try wrapper.unwrapKey(nonce: Data(wrapped.prefix(12)), ciphertext: Data(wrapped.dropFirst(12)))
    }
    static func openOwnerFolderKey(master: MasterKeyHandle, folderId: String, wrapped: Data,
                                   registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> Int {
        let epoch = registry.generation
        let key = try unwrap(master.deriveFileKey(fileId: Data(folderId.utf8)), wrapped)
        guard let id = registry.storeFolderIfCurrent(key, folderId: folderId, generation: epoch) else { throw SharedKeyError.locked }
        return id
    }
    static func generateFolderKey(master: MasterKeyHandle, folderId: String,
                                  registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> (handleId: Int, ownerWrapped: Data) {
        let epoch = registry.generation
        let key = try FileKeyHandle.generate()
        let wrapped = try wire(master.deriveFileKey(fileId: Data(folderId.utf8)).wrapKey(inner: key))
        guard let id = registry.storeFolderIfCurrent(key, folderId: folderId, generation: epoch) else { throw SharedKeyError.locked }
        return (id, wrapped)
    }
    static func loadFileKeys(folderId: Int, entries: [SharedKeyEntryNative],
                             registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> (loaded: [String], failed: [String]) {
        let epoch = registry.generation
        let key = try folder(folderId, registry: registry).handle
        var loaded: [String] = [], failed: [String] = []
        for entry in entries {
            do {
                let opened = try unwrap(key, entry.wrapped)
                if registry.storeFile(entry.fileId, opened, generation: epoch) { loaded.append(entry.fileId) }
                else { failed.append(entry.fileId) }
            } catch { failed.append(entry.fileId) }
        }
        return (loaded, failed)
    }
    static func openOwnerFileKey(master: MasterKeyHandle, fileId: String, wrapped: Data,
                                 registry: SharedKeyRegistry<FileKeyHandle> = registry) -> Bool {
        let epoch = registry.generation
        do { return registry.storeFile(fileId, try unwrap(master.deriveFileKey(fileId: Data(fileId.utf8)), wrapped), generation: epoch) }
        catch { return false }
    }
    static func wrapChildKeys(master: MasterKeyHandle, folderId: Int, fileIds: [String],
                              registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> [SharedKeyEntryNative] {
        let key = try folder(folderId, registry: registry).handle
        return try fileIds.map { id in SharedKeyEntryNative(fileId: id, wrapped: try wire(key.wrapKey(inner: master.deriveFileKey(fileId: Data(id.utf8))))) }
    }
    static func adoptWrap(master: MasterKeyHandle, fileId: String,
                          registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> Data {
        guard let key = registry.file(fileId) else { throw SharedKeyError.locked }
        return try wire(master.deriveFileKey(fileId: Data(fileId.utf8)).wrapKey(inner: key))
    }
    static func fileKey(master: MasterKeyHandle, fileId: String,
                        registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> FileKeyHandle {
        try pickKey(table: registry.file(fileId)) { try master.deriveFileKey(fileId: Data(fileId.utf8)) }
    }
    static func chunkDecryptor(master: MasterKeyHandle, fileId: String,
                               registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> ChunkDecryptorHandle {
        if let key = registry.file(fileId) {
            return try ChunkDecryptorHandle.forPushWithFileKeyHandle(fileKey: key, fileId: fileId, expectedChunkFormat: 0)
        }
        return try ChunkDecryptorHandle.forPush(masterKey: master, fileId: fileId, expectedChunkFormat: 0)
    }
    static func mintLink(master: MasterKeyHandle, folderId: Int, token: String, passphrase: String?,
                         registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> FolderLinkMintNative {
        let key = try folder(folderId, registry: registry).handle
        var kc = Data(count: 32)
        defer { kc.resetBytes(in: 0..<kc.count) }
        let status = kc.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw SharedKeyError.random }
        // The throwing branch is deliberate: Argon failure never selects the plain constructor.
        let link = try passphrase.map { try FileKeyHandle.fromFolderLinkPassphrase(kC: kc, passphrase: $0, token: token) }
            ?? FileKeyHandle.fromFolderLink(kC: kc, passphraseStretch: nil)
        var masterBytes = try master.exportForKeychain()
        defer { masterBytes.resetBytes(in: 0..<masterBytes.count) }
        return try FolderLinkMintNative(kc: base64url(kc), wrappedFolderKey: wire(link.wrapKey(inner: key)),
            ownerWrappedKey: wire(encryptChunk(key: masterBytes, plaintext: kc)),
            ownerWrappedToken: wire(encryptChunk(key: masterBytes, plaintext: Data(token.utf8))))
    }
    static func recoverKc(master: MasterKeyHandle, folderId: Int, wrapped: Data,
                          registry: SharedKeyRegistry<FileKeyHandle> = registry) throws -> String? {
        let key = try folder(folderId, registry: registry).handle
        guard wrapped.count == 60 else { throw SharedKeyError.invalidWrap }
        var masterBytes = try master.exportForKeychain()
        defer { masterBytes.resetBytes(in: 0..<masterBytes.count) }
        var candidate = try decryptChunk(key: masterBytes, nonce: Data(wrapped.prefix(12)), ciphertext: Data(wrapped.dropFirst(12)))
        defer { candidate.resetBytes(in: 0..<candidate.count) }
        guard candidate.count == 32 else { throw SharedKeyError.invalidWrap }
        if try FileKeyHandle.fromKeyBytes(key: candidate).keyId() == key.keyId() { return nil }
        return base64url(candidate)
    }
    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
