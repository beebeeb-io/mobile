import FileProvider
import UniformTypeIdentifiers

/// `NSFileProviderItem` implementation backed by a row in the SQLite cache.
///
/// The Files app calls this for every visible row, so the implementation must
/// stay cheap: we only do work that requires the cache row (no API or crypto
/// calls). Filename decryption happens once per row, in the enumerator, and
/// the result is persisted back to `name_decrypted` so subsequent calls hit
/// the cached plaintext.
final class FileProviderItem: NSObject, NSFileProviderItem {
  private let cached: CachedItem

  init(cached: CachedItem) {
    self.cached = cached
  }

  // MARK: - Identity

  var itemIdentifier: NSFileProviderItemIdentifier {
    if cached.id == BeebeebConstants.rootContainerIdentifier {
      return .rootContainer
    }
    return NSFileProviderItemIdentifier(cached.id)
  }

  var parentItemIdentifier: NSFileProviderItemIdentifier {
    if cached.id == BeebeebConstants.rootContainerIdentifier {
      return .rootContainer
    }
    if let parent = cached.parentId, !parent.isEmpty {
      return NSFileProviderItemIdentifier(parent)
    }
    return .rootContainer
  }

  // MARK: - Display

  var filename: String {
    if let decrypted = cached.nameDecrypted, !decrypted.isEmpty { return decrypted }
    // If the encrypted name is not JSON (legacy plaintext), use it directly.
    if let raw = cached.nameEncrypted, !raw.isEmpty, !raw.hasPrefix("{") {
      return raw
    }
    // While we wait for the main app to populate name_decrypted via
    // syncFileProviderCache, show a stable placeholder. The system will
    // refetch the item once we signal a working set update.
    return cached.isFolder ? "Folder" : "Open Beebeeb to decrypt"
  }

  var contentType: UTType {
    if cached.isFolder { return .folder }
    if let mime = cached.mimeType, let ut = UTType(mimeType: mime) { return ut }
    return .data
  }

  // MARK: - Metadata

  var documentSize: NSNumber? {
    cached.isFolder ? nil : NSNumber(value: cached.sizeBytes)
  }

  var creationDate: Date? {
    cached.createdAt.flatMap { Self.iso8601.date(from: $0) }
  }

  var contentModificationDate: Date? {
    cached.updatedAt.flatMap { Self.iso8601.date(from: $0) }
  }

  // MARK: - Capabilities

  var capabilities: NSFileProviderItemCapabilities {
    if cached.isFolder {
      return [.allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming, .allowsDeleting, .allowsReparenting]
    }
    return [.allowsReading, .allowsWriting, .allowsRenaming, .allowsDeleting, .allowsReparenting]
  }

  // Note: NSFileProviderContentPolicy (downloadEagerlyAndKeepDownloaded / downloadLazily)
  // is macOS-only. On iOS, the system manages materialization automatically.
  // Pinning is tracked in our local cache for our own UI purposes.

  // MARK: - Versioning

  /// File Provider expects a stable version blob to detect changes. We hash
  /// the updated_at timestamp + size — server-driven changes always bump
  /// `updated_at`, so this captures every meaningful mutation.
  var itemVersion: NSFileProviderItemVersion {
    let contentPayload = "\(cached.updatedAt ?? "")|\(cached.sizeBytes)"
    let metadataPayload = "\(contentPayload)|\(cached.nameDecrypted ?? "")|\(cached.nameEncrypted ?? "")|\(cached.parentId ?? "")"
    return NSFileProviderItemVersion(
      contentVersion: Data(contentPayload.utf8),
      metadataVersion: Data(metadataPayload.utf8)
    )
  }

  // MARK: - Helpers

  private static let iso8601: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
}

extension CachedItem {
  /// Synthesize a cache row representing the logical root container so the
  /// enumerator and item lookup can both flow through the same code paths.
  static func rootContainer() -> CachedItem {
    CachedItem(
      id: BeebeebConstants.rootContainerIdentifier,
      parentId: nil,
      nameEncrypted: nil,
      nameDecrypted: "Beebeeb",
      mimeType: nil,
      sizeBytes: 0,
      isFolder: true,
      isPinned: false,
      hasThumbnail: false,
      thumbnailData: nil,
      thumbnailNonce: nil,
      createdAt: nil,
      updatedAt: nil,
      syncAnchor: 0,
      isMaterialized: true
    )
  }
}
