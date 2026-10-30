import Foundation
import CryptoKit

/// The owner's resolved per-file key, wrapped so it can only READ.
///
/// SF-0002: an owner key resolved from `(file_id, name_encrypted)` or a content
/// version's first frame may belong to the uppercase-repair convention, which is
/// read-only. This type deliberately exposes no encryption, wrapping, adoption or
/// raw-key operation, and the `FileKeyHandle` stays private: a caller can decrypt
/// this file's name metadata, read its pin, or push a decryptor — nothing else.
/// It lives for one read and is never stored in `SharedKeyRegistry`.
struct OwnerReadKey {
    private let key: FileKeyHandle

    init(_ key: FileKeyHandle) {
        self.key = key
    }

    func decryptFileMetadata(nameEncrypted: String) throws -> NameMetadataDto {
        try key.decryptFileMetadata(nameEncrypted: nameEncrypted)
    }

    func decryptNameMetadata(nameEncrypted: String) throws -> NameMetadataDto {
        try key.decryptNameMetadata(nameEncrypted: nameEncrypted)
    }

    func makeDecryptor(fileId: String, chunkFormat: UInt8) throws -> ChunkDecryptorHandle {
        try ChunkDecryptorHandle.forPushWithFileKeyHandle(
            fileKey: key, fileId: fileId, expectedChunkFormat: chunkFormat)
    }
}

/// What a caller needs to read one owned content version: the authenticated pin and
/// the convention the content key came from (`upperRepair` means read-only).
struct ContentPin {
    let chunkFormat: UInt8
    let nameConvention: OwnerKeyConvention
}

struct ContentPinUnverifiable: LocalizedError {
    let underlying: Error
    var errorDescription: String? {
        "Content pin could not be authenticated: \(underlying)"
    }
}

/// Conventions only — never keys. Kept separate from `SharedKeyRegistry` so a lock
/// (`clearSharedKeys`) empties both, while remembering that an owned file needs the
/// owner resolver cannot outlive the vault session.
final class OwnerConventionCache {
    private struct NameKey: Hashable {
        let epoch: UInt64
        let fileId: String
        let nameHash: String
    }

    private struct ContentKey: Hashable {
        let epoch: UInt64
        let fileId: String
        let objectVersionId: String
    }

    private let lock = NSLock()
    private var names: [NameKey: OwnerKeyConvention] = [:]
    private var contents: [ContentKey: OwnerKeyConvention] = [:]

    func name(epoch: UInt64, fileId: String, nameEncrypted: String) -> OwnerKeyConvention? {
        let key = NameKey(epoch: epoch, fileId: fileId, nameHash: Self.hash(nameEncrypted))
        lock.lock()
        defer { lock.unlock() }
        return names[key]
    }

    func storeName(_ convention: OwnerKeyConvention, epoch: UInt64, fileId: String, nameEncrypted: String) {
        let key = NameKey(epoch: epoch, fileId: fileId, nameHash: Self.hash(nameEncrypted))
        lock.lock()
        defer { lock.unlock() }
        names[key] = convention
    }

    func content(epoch: UInt64, fileId: String, objectVersionId: String) -> OwnerKeyConvention? {
        let key = ContentKey(epoch: epoch, fileId: fileId, objectVersionId: objectVersionId)
        lock.lock()
        defer { lock.unlock() }
        return contents[key]
    }

    func storeContent(_ convention: OwnerKeyConvention, epoch: UInt64, fileId: String, objectVersionId: String) {
        let key = ContentKey(epoch: epoch, fileId: fileId, objectVersionId: objectVersionId)
        lock.lock()
        defer { lock.unlock() }
        contents[key] = convention
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        names.removeAll()
        contents.removeAll()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return names.count + contents.count
    }

    private static func hash(_ value: String) -> String {
        // Stable, non-secret digest: the cache key never carries the sealed name.
        var hash = SHA256()
        hash.update(data: Data(value.utf8))
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

