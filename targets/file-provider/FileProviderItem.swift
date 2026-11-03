import FileProvider
import Foundation
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

  /// `sync_state` key under which the app publishes the id of the root "Backups" folder, a
  /// protected system folder. Cleared with the rest of `sync_state` on sign-out. The app side
  /// (`BeebeebCryptoModule.swift`) writes the same literal; a guard test keeps them equal.
  static let protectedBackupsRootKey = "protected.backupsRootId"

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
    if let display = cached.displayName, !display.isEmpty { return display }
    if let decrypted = cached.nameDecrypted, !decrypted.isEmpty { return decrypted }
    // If the encrypted name is not JSON (legacy plaintext), use it directly.
    if let raw = cached.nameEncrypted, !raw.isEmpty, !raw.hasPrefix("{") {
      return raw
    }
    // Task 1722 (d): a name this row cannot show. The listing refuses to
    // vend rows like this while the vault key is unavailable (SyncEngine), so
    // this is a single undecryptable name. The label is unique per item: the
    // old constant "Folder" / "Open Beebeeb to decrypt" collided between
    // siblings and fileproviderd bounced them to "Folder 2", "Folder 3".
    return FileProviderDisplayNames.unresolvedNameLabel(id: cached.id)
  }

  /// "Encrypted item · 1a2b3c4d": the first 8 characters of the server id.
  static func unresolvedNameLabel(id: String) -> String {
    FileProviderDisplayNames.unresolvedNameLabel(id: id)
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
    // Trash is a read-only view: open and copy out; no rename, move or delete. A folder keeps
    // `allowsAddingSubItems` / `allowsWriting`: without it fileproviderd cannot create the item
    // on disk (cannotSetMetadata, an error on the whole location). Writes are refused by the
    // extension instead, so the server view remains read-only.
    if FilesTrash.isTrashNamespace(cached.id) {
      return cached.isFolder ? [.allowsContentEnumerating, .allowsAddingSubItems] : [.allowsReading, .allowsWriting]
    }
    var capabilities: NSFileProviderItemCapabilities = cached.isFolder
      ? [.allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming, .allowsDeleting, .allowsReparenting]
      : [.allowsReading, .allowsWriting, .allowsRenaming, .allowsDeleting, .allowsReparenting]
    // Task 1722 (d): renaming an item whose real name we cannot read would
    // overwrite that name on the server. `modifyItem` refuses it as well.
    if cached.hasUnresolvedName {
      capabilities.remove(.allowsRenaming)
    }
    // The root Backups folder cannot be deleted, renamed or moved.
    if cached.isProtectedBackupsRoot {
      capabilities.subtract([.allowsDeleting, .allowsRenaming, .allowsReparenting])
    }
    return capabilities
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
    // A protected folder gets its own version, so Files re-reads its capabilities when the
    // app publishes the id.
    let protectedMarker = cached.isProtectedBackupsRoot ? "|protected" : ""
    // Namespaced Trash rows need a distinct version after their advertised capabilities change.
    // Existing installations then replace snapshots captured before that capability change.
    let trashCapabilitiesMarker = cached.id.hasPrefix(FilesTrash.itemPrefix) ? "|trash-capabilities-v2" : ""
    // v2 records that aliases are tied to the real name and parent they were derived from. The
    // marker is unconditional so upgraded installs replace snapshots carrying a stale v1 alias.
    let displayNameMarker = "|display-name-v2"
    let metadataPayload = "\(contentPayload)|\(cached.nameDecrypted ?? "")|\(cached.nameEncrypted ?? "")|\(cached.displayName ?? "")|\(cached.parentId ?? "")\(protectedMarker)\(trashCapabilitiesMarker)\(displayNameMarker)"
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

/// The read-only Trash folder of the Beebeeb location. Its rows are cached under their own ids
/// (`trash:<server id>`) with the Trash folder (or a trashed folder) as parent.
enum FilesTrash {
  static var containerId: String { BeebeebConstants.trashContainerIdentifier }
  static var itemPrefix: String { BeebeebConstants.trashItemPrefix }
  /// Bound extension memory and decrypt work when an account has a large trash.
  static let rootListingLimit = 500

  /// The Trash folder itself, or anything inside it.
  static func isTrashNamespace(_ id: String) -> Bool {
    id == containerId || id.hasPrefix(itemPrefix)
  }

  /// The id the server knows an item by (a trashed item's cache id carries the prefix).
  static func serverId(_ id: String) -> String {
    id.hasPrefix(itemPrefix) ? String(id.dropFirst(itemPrefix.count)) : id
  }

  /// A fixed date for the Trash folder. A folder with no dates (epoch 0) made fileproviderd fail to
  /// create it ("cannotSetMetadata"), which left an error on the location.
  static let folderDate = "2026-01-01T00:00:00.000Z"

  static func cacheId(forServerId id: String) -> String { itemPrefix + id }

  /// Where a container's children come from and where they are cached.
  struct Listing {
    /// `parent_id` for the server (nil: the root, or Trash's flat top level).
    let serverParent: String?
    let trashed: Bool
    /// The cache parent of the rows this listing writes.
    let cacheParent: String?
    /// Rows are written under `trash:<id>` ids.
    var namespaced: Bool { trashed }
    var isTrashRoot: Bool { trashed && serverParent == nil }
  }

  static func listing(forContainer containerId: String) -> Listing {
    if containerId == Self.containerId {
      return Listing(serverParent: nil, trashed: true, cacheParent: Self.containerId)
    }
    if containerId.hasPrefix(itemPrefix) {
      return Listing(serverParent: serverId(containerId), trashed: true, cacheParent: containerId)
    }
    let parent: String? = (containerId == BeebeebConstants.rootContainerIdentifier) ? nil : containerId
    return Listing(serverParent: parent, trashed: false, cacheParent: parent)
  }
}

extension CachedItem {
  /// The Trash folder, synthesized like the root: it is not a server row.
  static func trashContainer() -> CachedItem {
    CachedItem(
      id: FilesTrash.containerId,
      parentId: nil,
      nameEncrypted: nil,
      nameDecrypted: "Beebeeb Trash",
      mimeType: nil,
      sizeBytes: 0,
      isFolder: true,
      isPinned: false,
      hasThumbnail: false,
      thumbnailData: nil,
      thumbnailNonce: nil,
      createdAt: FilesTrash.folderDate,
      updatedAt: FilesTrash.folderDate,
      syncAnchor: 0,
      isMaterialized: false
    )
  }

  /// True for the root "Backups" folder, identified by the id the app published, never by name.
  /// Only folders ask the cache, so a large file listing costs no extra lookups.
  var isProtectedBackupsRoot: Bool {
    guard isFolder, let protectedId = CacheManager.shared.syncState(key: FileProviderItem.protectedBackupsRootKey),
          !protectedId.isEmpty else { return false }
    return protectedId.lowercased() == id.lowercased()
  }

  /// True for the app's internal per-device backup manifest, `Backups/{Device}/.device.json`: a
  /// file by that exact name whose parent folder sits directly under the Backups root the app
  /// published. It stays in the cache (the backup screens read it) but is never enumerated.
  /// Until the root id is published the name alone decides. The app applies the same rule in
  /// `src/lib/hidden-system-files.ts`.
  var isHiddenBackupManifest: Bool {
    guard !isFolder, nameDecrypted == ".device.json" else { return false }
    guard let rootId = CacheManager.shared.syncState(key: FileProviderItem.protectedBackupsRootKey),
          !rootId.isEmpty else { return true }
    guard let parentId, let grandparentId = CacheManager.shared.item(id: parentId)?.parentId else { return false }
    return grandparentId.lowercased() == rootId.lowercased()
  }

  /// Task 1722 (d): true when no readable name is known for this row: no
  /// decrypted name, and the server name is an encrypted envelope (or
  /// missing). Such a row shows `FileProviderItem.unresolvedNameLabel`, and
  /// nothing derived from that label may be written back to the server.
  var hasUnresolvedName: Bool {
    if let decrypted = nameDecrypted, !decrypted.isEmpty { return false }
    if let raw = nameEncrypted, !raw.isEmpty, !raw.hasPrefix("{") { return false }
    return true
  }

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
