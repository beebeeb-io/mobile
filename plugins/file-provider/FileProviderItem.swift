import FileProvider
import UniformTypeIdentifiers

struct FileMetadata: Codable {
    let id: String
    let nameEncrypted: String
    let parentId: String?
    let mimeType: String?
    let sizeBytes: Int64
    let isFolder: Bool
    let createdAt: String
    let updatedAt: String
    let chunkCount: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case nameEncrypted = "name_encrypted"
        case parentId = "parent_id"
        case mimeType = "mime_type"
        case sizeBytes = "size_bytes"
        case isFolder = "is_folder"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case chunkCount = "chunk_count"
    }
}

class FileProviderItem: NSObject, NSFileProviderItem {
    let metadata: FileMetadata?
    private let crypto: FileProviderCrypto?
    private let isRoot: Bool

    init(metadata: FileMetadata, crypto: FileProviderCrypto) {
        self.metadata = metadata
        self.crypto = crypto
        self.isRoot = false
        super.init()
    }

    private override init() {
        self.metadata = nil
        self.crypto = nil
        self.isRoot = true
        super.init()
    }

    static var rootContainer: FileProviderItem {
        return FileProviderItem()
    }

    var itemIdentifier: NSFileProviderItemIdentifier {
        if isRoot { return .rootContainer }
        return NSFileProviderItemIdentifier(metadata!.id)
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier {
        if isRoot { return .rootContainer }
        guard let pid = metadata?.parentId else { return .rootContainer }
        return NSFileProviderItemIdentifier(pid)
    }

    var capabilities: NSFileProviderItemCapabilities {
        if isRoot {
            return [.allowsAddingSubItems, .allowsContentEnumerating]
        }
        if metadata?.isFolder == true {
            return [.allowsAddingSubItems, .allowsContentEnumerating, .allowsDeleting, .allowsRenaming, .allowsReparenting]
        }
        return [.allowsReading, .allowsWriting, .allowsDeleting, .allowsRenaming, .allowsReparenting]
    }

    var filename: String {
        if isRoot { return "Beebeeb" }
        guard let meta = metadata, let c = crypto else { return "Unknown" }
        return c.decryptFilename(fileId: meta.id, encrypted: meta.nameEncrypted)
            ?? (meta.isFolder ? "Encrypted folder" : "Encrypted file")
    }

    var contentType: UTType {
        if isRoot || metadata?.isFolder == true { return .folder }
        guard let mime = metadata?.mimeType else { return .data }
        return UTType(mimeType: mime) ?? .data
    }

    var documentSize: NSNumber? {
        guard let size = metadata?.sizeBytes, size > 0 else { return nil }
        return NSNumber(value: size)
    }

    var creationDate: Date? {
        guard let dateStr = metadata?.createdAt else { return nil }
        return ISO8601DateFormatter().date(from: dateStr)
    }

    var contentModificationDate: Date? {
        guard let dateStr = metadata?.updatedAt else { return nil }
        return ISO8601DateFormatter().date(from: dateStr)
    }

    var itemVersion: NSFileProviderItemVersion {
        let contentVersion = (metadata?.updatedAt ?? "v1").data(using: .utf8) ?? Data()
        return NSFileProviderItemVersion(contentVersion: contentVersion, metadataVersion: contentVersion)
    }
}

final class LockedFileProviderItem: NSObject, NSFileProviderItem {
    var itemIdentifier: NSFileProviderItemIdentifier {
        NSFileProviderItemIdentifier("__beebeeb_files_locked__")
    }

    var parentItemIdentifier: NSFileProviderItemIdentifier {
        .rootContainer
    }

    var capabilities: NSFileProviderItemCapabilities {
        []
    }

    var filename: String {
        "Open Beebeeb to unlock Files access"
    }

    var contentType: UTType {
        .data
    }

    var documentSize: NSNumber? {
        0
    }

    var itemVersion: NSFileProviderItemVersion {
        let version = Data("locked-v1".utf8)
        return NSFileProviderItemVersion(contentVersion: version, metadataVersion: version)
    }
}
