import AVFoundation
import ExpoModulesCore
import Foundation
import FileProvider
import PDFKit
import Photos
import Security
import SQLite3
import UIKit
import UniformTypeIdentifiers
import UserNotifications

private let fileProviderDomainIdentifier = NSFileProviderDomainIdentifier("io.beebeeb.files")
private let fileProviderDisplayName = "Beebeeb"
private let fileProviderDomainSchemaKey = "io.beebeeb.fileProviderDomainSchema"
private let fileProviderDomainSchemaVersion = "replicated-v6-cache-bootstrap"
private let appGroupIdentifier = "group.io.beebeeb.shared"
private let simulatorFileProviderMasterKeyKey = "io.beebeeb.simulatorFileProviderMasterKey"
private let sharedSessionTokenKey = "io.beebeeb.sessionToken"
private let sharedAPIBaseURLKey = "io.beebeeb.apiBaseUrl"
private let fileProviderEnabledKey = "io.beebeeb.fileProvider.enabled"
private let fileProviderTrustedMountKey = "io.beebeeb.fileProvider.trustedMountEnabled"
private let fileProviderAuthRequiredKey = "io.beebeeb.fileProvider.requireDeviceAuth"
private let fileProviderUnlockedUntilKey = "io.beebeeb.fileProvider.unlockedUntilMs"
private let fileProviderEnumeratorStatePrefix = "io.beebeeb.fileProvider.enumerator."

// PHKit picks its own callback queue (often main when the app is foregrounded).
// Hop here as the first line of every PhotoKit completion so the work in the
// closure body never blocks main, consistent with PhotoBackupManager.
private let beebeebCryptoPHKitCallbackQueue = DispatchQueue(
  label: "io.beebeeb.crypto.phkit-callback",
  qos: .utility
)

private func decodeBase64(_ value: String, field: String) throws -> Data {
  guard let data = Data(base64Encoded: value) else {
    throw NSError(
      domain: "BeebeebCrypto",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Invalid base64 for \(field)"]
    )
  }
  return data
}

private func fileURL(fromURI uri: String) -> URL {
  if let url = URL(string: uri), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: uri)
}

private func isVideoMediaHint(_ value: String?) -> Bool {
  guard let value = value?.lowercased() else { return false }
  return value.hasPrefix("video/") ||
         value == "com.apple.quicktime-movie" ||
         value == "public.mpeg-4" ||
         value.hasPrefix("public.movie") ||
         value.hasPrefix("public.video")
}

private func generatePhotoLibraryImageThumbnail(
  localIdentifier: String,
  maxSize: Int,
  config: ThumbnailGenerator.Config = .medium
) async throws -> Data {
  let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
  guard let phAsset else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 10,
      userInfo: [NSLocalizedDescriptionKey: "Photo asset not found in library"]
    )
  }

  let image: UIImage = try await withCheckedThrowingContinuation { continuation in
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.isNetworkAccessAllowed = true
    options.isSynchronous = false
    options.resizeMode = .fast

    PHImageManager.default().requestImage(
      for: phAsset,
      targetSize: CGSize(width: maxSize, height: maxSize),
      contentMode: .aspectFit,
      options: options
    ) { result, info in
      beebeebCryptoPHKitCallbackQueue.async {
        let isDegraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
        if isDegraded { return }
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let result {
          continuation.resume(returning: result)
        } else {
          continuation.resume(throwing: NSError(
            domain: "BeebeebThumbnail",
            code: 11,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load photo thumbnail from library"]
          ))
        }
      }
    }
  }

  guard let webpData = ThumbnailGenerator.generate(from: image, config: config) else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 12,
      userInfo: [NSLocalizedDescriptionKey: "Failed to encode photo thumbnail as WebP"]
    )
  }
  return webpData
}

private func generatePhotoLibraryVideoThumbnail(
  localIdentifier: String,
  maxSize: Int,
  config: ThumbnailGenerator.Config = .medium
) async throws -> Data {
  let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
  guard let phAsset else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 13,
      userInfo: [NSLocalizedDescriptionKey: "Video asset not found in library"]
    )
  }

  let avAsset: AVAsset = try await withCheckedThrowingContinuation { continuation in
    let options = PHVideoRequestOptions()
    options.version = .original
    options.isNetworkAccessAllowed = true
    PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { asset, _, info in
      beebeebCryptoPHKitCallbackQueue.async {
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let asset {
          continuation.resume(returning: asset)
        } else {
          continuation.resume(throwing: NSError(
            domain: "BeebeebThumbnail",
            code: 14,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load video asset from library"]
          ))
        }
      }
    }
  }

  let generator = AVAssetImageGenerator(asset: avAsset)
  generator.appliesPreferredTrackTransform = true
  generator.maximumSize = CGSize(width: maxSize, height: maxSize)

  let time = CMTime(seconds: 1.0, preferredTimescale: 600)
  let cgImage: CGImage
  do {
    cgImage = try generator.copyCGImage(at: time, actualTime: nil)
  } catch {
    cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
  }

  guard let webpData = ThumbnailGenerator.generate(from: UIImage(cgImage: cgImage), config: config) else {
    throw NSError(
      domain: "BeebeebThumbnail",
      code: 15,
      userInfo: [NSLocalizedDescriptionKey: "Failed to encode video thumbnail as WebP"]
    )
  }
  return webpData
}

private final class PreviewDownloadProgress: DownloadProgressCallback, FileProgressCallback, @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private weak var task: URLSessionTask?
  private let requestId: String?
  private let fileId: String
  private let emit: ([String: Any]) -> Void

  init(requestId: String?, fileId: String, emit: @escaping ([String: Any]) -> Void) {
    self.requestId = requestId
    self.fileId = fileId
    self.emit = emit
  }

  func setTask(_ task: URLSessionTask) {
    lock.lock()
    self.task = task
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let task = task
    lock.unlock()
    task?.cancel()
  }

  func isCancelled() -> Bool {
    lock.lock()
    let value = cancelled
    lock.unlock()
    return value
  }

  func onChunkDecrypted(chunkIndex: UInt32, totalChunks: UInt32) {
    if chunkIndex == 1 || chunkIndex == totalChunks || chunkIndex % 10 == 0 {
      RuntimeTrace.event("preview.native_download.chunk_decrypted", [
        "fileId": fileId,
        "chunkIndex": Int(chunkIndex),
        "totalChunks": Int(totalChunks)
      ])
    }
    emitProgress(stage: "decrypting", chunksCompleted: Int(chunkIndex), chunksTotal: Int(totalChunks))
  }

  func onProgress(chunksCompleted: UInt32, chunksTotal: UInt32) {
    if chunksCompleted == 1 || chunksCompleted == chunksTotal || chunksCompleted % 10 == 0 {
      RuntimeTrace.event("preview.native_download.progress", [
        "fileId": fileId,
        "chunksCompleted": Int(chunksCompleted),
        "chunksTotal": Int(chunksTotal)
      ])
    }
    emitProgress(stage: "decrypting", chunksCompleted: Int(chunksCompleted), chunksTotal: Int(chunksTotal))
  }

  func onComplete(outputPath: String) {
    RuntimeTrace.event("preview.native_download.callback_complete", ["fileId": fileId])
    emitProgress(stage: "complete")
  }

  func onError(error: String) {
    RuntimeTrace.event("preview.native_download.callback_error", [
      "fileId": fileId,
      "error": error
    ])
    emitProgress(stage: "error", extra: ["error": error])
  }

  func emitDownload(bytesWritten: Int64, bytesExpected: Int64) {
    emitProgress(
      stage: "downloading",
      bytesDownloaded: max(0, bytesWritten),
      bytesTotal: bytesExpected > 0 ? bytesExpected : 0
    )
  }

  func emitProgress(
    stage: String,
    bytesDownloaded: Int64? = nil,
    bytesTotal: Int64? = nil,
    chunksCompleted: Int? = nil,
    chunksTotal: Int? = nil,
    extra: [String: Any] = [:]
  ) {
    var body: [String: Any] = [
      "requestId": requestId ?? "",
      "fileId": fileId,
      "stage": stage,
    ]
    if let bytesDownloaded { body["bytesDownloaded"] = bytesDownloaded }
    if let bytesTotal { body["bytesTotal"] = bytesTotal }
    if let chunksCompleted { body["chunksCompleted"] = chunksCompleted }
    if let chunksTotal { body["chunksTotal"] = chunksTotal }
    for (key, value) in extra { body[key] = value }
    emit(body)
  }
}

private final class PreviewEncryptedDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private var continuation: CheckedContinuation<(URL, HTTPURLResponse), Error>?
  private var response: HTTPURLResponse?
  private var session: URLSession?
  private let progress: PreviewDownloadProgress

  init(progress: PreviewDownloadProgress) {
    self.progress = progress
  }

  func download(request: URLRequest) async throws -> (URL, HTTPURLResponse) {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
      self.session = session
      let task = session.downloadTask(with: request)
      progress.setTask(task)
      task.resume()
    }
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    progress.emitDownload(bytesWritten: totalBytesWritten, bytesExpected: totalBytesExpectedToWrite)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    response = downloadTask.response as? HTTPURLResponse
    guard let response else {
      continuation?.resume(throwing: NSError(
        domain: "BeebeebPreviewDownload",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Missing download response"]
      ))
      continuation = nil
      return
    }

    let target = FileManager.default.temporaryDirectory
      .appendingPathComponent("beebeeb-preview-\(UUID().uuidString).enc")
    do {
      try FileManager.default.moveItem(at: location, to: target)
      continuation?.resume(returning: (target, response))
    } catch {
      continuation?.resume(throwing: error)
    }
    continuation = nil
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    defer {
      session.invalidateAndCancel()
      self.session = nil
    }
    if let error, continuation != nil {
      continuation?.resume(throwing: error)
      continuation = nil
    }
  }

}

@available(iOS 16.0, *)
private func beebeebFileProviderDomain() -> NSFileProviderDomain {
  NSFileProviderDomain(identifier: fileProviderDomainIdentifier, displayName: fileProviderDisplayName)
}

@available(iOS 16.0, *)
private func getFileProviderDomains() async throws -> [NSFileProviderDomain] {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[NSFileProviderDomain], Error>) in
    NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: domains)
      }
    }
  }
}

@available(iOS 16.0, *)
private func addFileProviderDomain(_ domain: NSFileProviderDomain) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    NSFileProviderManager.add(domain) { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

@available(iOS 16.0, *)
private func removeFileProviderDomain(_ domain: NSFileProviderDomain) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    NSFileProviderManager.remove(domain) { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

@available(iOS 16.0, *)
private func signalFileProviderEnumerator(
  domain: NSFileProviderDomain,
  itemIdentifier: NSFileProviderItemIdentifier
) async -> String? {
  guard let manager = NSFileProviderManager(for: domain) else {
    return "File Provider manager unavailable"
  }

  return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
    manager.signalEnumerator(for: itemIdentifier) { error in
      continuation.resume(returning: error?.localizedDescription)
    }
  }
}

@available(iOS 16.0, *)
private func signalBeebeebFileProviderEnumerators() async {
  let domain = beebeebFileProviderDomain()
  let domains = (try? await getFileProviderDomains()) ?? []
  guard domains.contains(where: { $0.identifier == domain.identifier }) else {
    return
  }

  _ = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
  _ = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
}

@available(iOS 16.0, *)
private func fileProviderDomainStatus(
  domain: NSFileProviderDomain,
  registered: Bool,
  added: Bool,
  removedBeforeAdd: Bool = false,
  domainCount: Int,
  cacheDatabaseReady: Bool = fileProviderCacheDatabaseExists(),
  documentStorageURL: String? = nil,
  userVisibleRootURL: String? = nil,
  userVisibleRootError: String? = nil,
  rootEnumerationError: String? = nil,
  workingSetEnumerationError: String? = nil
) -> [String: Any] {
  [
    "supported": true,
    "identifier": domain.identifier.rawValue,
    "displayName": domain.displayName,
    "registered": registered,
    "added": added,
    "removedBeforeAdd": removedBeforeAdd,
    "domainCount": domainCount,
    "cacheDatabaseReady": cacheDatabaseReady,
    "documentStorageURL": documentStorageURL ?? NSNull(),
    "userVisibleRootURL": userVisibleRootURL ?? NSNull(),
    "userVisibleRootError": userVisibleRootError ?? NSNull(),
    "rootEnumerationSignaled": rootEnumerationError == nil,
    "workingSetEnumerationSignaled": workingSetEnumerationError == nil,
    "rootEnumerationError": rootEnumerationError ?? NSNull(),
    "workingSetEnumerationError": workingSetEnumerationError ?? NSNull(),
  ]
}

@available(iOS 16.0, *)
private func fileProviderRootVisibility(domain: NSFileProviderDomain) async -> (String?, String?) {
  guard let manager = NSFileProviderManager(for: domain) else {
    return (nil, "File Provider manager unavailable")
  }

  return await withCheckedContinuation { (continuation: CheckedContinuation<(String?, String?), Never>) in
    manager.getUserVisibleURL(for: .rootContainer) { url, error in
      continuation.resume(returning: (url?.absoluteString, error?.localizedDescription))
    }
  }
}

private func sharedDefaults() -> UserDefaults? {
  UserDefaults(suiteName: appGroupIdentifier)
}

private func sharedBoolDefaultTrue(_ defaults: UserDefaults?, key: String) -> Bool {
  guard let defaults else { return true }
  if defaults.object(forKey: key) == nil {
    return true
  }
  return defaults.bool(forKey: key)
}

private func clearFileProviderSharedState(defaults: UserDefaults?) -> Int {
  defaults?.set(false, forKey: fileProviderEnabledKey)
  defaults?.set(false, forKey: fileProviderTrustedMountKey)
  defaults?.set(true, forKey: fileProviderAuthRequiredKey)
  defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
  // Session token + apiBaseUrl live in the shared Keychain (task 0447),
  // not in App Group UserDefaults. `deleteString` also clears any legacy
  // UserDefaults entries at the same keys so a stale token from a
  // pre-0447 install can't survive a sign-out.
  BeebeebKeychainCore.deleteString(key: sharedSessionTokenKey)
  BeebeebKeychainCore.deleteString(key: sharedAPIBaseURLKey)
  defaults?.removeObject(forKey: simulatorFileProviderMasterKeyKey)
  let removed = clearFileProviderCacheState(defaults: defaults)
  return removed
}

private let fileProviderCacheSchemaStatements = [
  """
  CREATE TABLE IF NOT EXISTS file_cache (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name_encrypted TEXT,
    name_decrypted TEXT,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    is_folder INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    has_thumbnail INTEGER NOT NULL DEFAULT 0,
    thumbnail_data BLOB,
    thumbnail_nonce BLOB,
    created_at TEXT,
    updated_at TEXT,
    sync_anchor INTEGER NOT NULL DEFAULT 0,
    is_materialized INTEGER NOT NULL DEFAULT 0
  );
  """,
  "CREATE INDEX IF NOT EXISTS idx_file_cache_parent ON file_cache(parent_id);",
  "CREATE INDEX IF NOT EXISTS idx_file_cache_anchor ON file_cache(sync_anchor);",
  """
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  """,
  """
  CREATE TABLE IF NOT EXISTS upload_queue (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    local_path TEXT,
    file_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  """,
]

private func fileProviderCacheDatabaseUrl() -> URL? {
  FileManager.default
    .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
    .appendingPathComponent("file-provider-cache.sqlite")
}

private func ensureFileProviderCacheDatabase() -> Bool {
  guard let url = fileProviderCacheDatabaseUrl() else {
    return false
  }

  var db: OpaquePointer?
  guard sqlite3_open_v2(
    url.path,
    &db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
    nil
  ) == SQLITE_OK, let db else {
    sqlite3_close(db)
    return false
  }
  defer {
    sqlite3_close(db)
  }

  for statement in fileProviderCacheSchemaStatements {
    sqlite3_exec(db, statement, nil, nil, nil)
  }
  return true
}

private func fileProviderCacheDatabaseExists() -> Bool {
  guard let url = fileProviderCacheDatabaseUrl() else {
    return false
  }
  return FileManager.default.fileExists(atPath: url.path)
}

private func resetFileProviderCacheDatabase(at url: URL) -> Bool {
  let fileManager = FileManager.default
  guard fileManager.fileExists(atPath: url.path) else {
    return false
  }

  var db: OpaquePointer?
  guard sqlite3_open_v2(
    url.path,
    &db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
    nil
  ) == SQLITE_OK, let db else {
    sqlite3_close(db)
    try? fileManager.removeItem(at: url)
    return true
  }
  defer {
    sqlite3_close(db)
  }

  // Keep the SQLite file inode stable. The File Provider extension may already
  // have this database open; unlinking it can leave the app writing to one DB
  // while the extension opens another at the same path.
  sqlite3_exec(db, "BEGIN", nil, nil, nil)
  sqlite3_exec(db, "DELETE FROM file_cache", nil, nil, nil)
  sqlite3_exec(db, "DELETE FROM sync_state", nil, nil, nil)
  sqlite3_exec(db, "DELETE FROM upload_queue", nil, nil, nil)
  sqlite3_exec(db, "COMMIT", nil, nil, nil)
  sqlite3_exec(db, "PRAGMA wal_checkpoint(TRUNCATE)", nil, nil, nil)
  return true
}

private func clearFileProviderCacheState(defaults: UserDefaults?) -> Int {
  defaults?.dictionaryRepresentation().keys
    .filter { $0.hasPrefix(fileProviderEnumeratorStatePrefix) }
    .forEach { defaults?.removeObject(forKey: $0) }

  var removed = 0
  let fileManager = FileManager.default
  if let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
    for name in ["BeebeebFileProvider", "FileProviderCache", "file-provider-cache.sqlite"] {
      let url = container.appendingPathComponent(name)
      if name == "file-provider-cache.sqlite" {
        if resetFileProviderCacheDatabase(at: url) {
          removed += 1
        }
        continue
      }
      if fileManager.fileExists(atPath: url.path) {
        try? fileManager.removeItem(at: url)
        removed += 1
      }
    }
  }
  return removed
}

private func fileProviderPrivacyState(defaults: UserDefaults? = sharedDefaults()) -> [String: Any] {
  let trustedMountEnabled = defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false
  let showInFiles = trustedMountEnabled && sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
  let requireDeviceAuth = defaults?.bool(forKey: fileProviderAuthRequiredKey) ?? true
  let unlockedUntilMs = defaults?.double(forKey: fileProviderUnlockedUntilKey) ?? 0
  let cacheDatabaseReady = fileProviderCacheDatabaseExists()
  let locked = !showInFiles

  return [
    "supported": true,
    "showInFiles": showInFiles,
    "trustedMountEnabled": trustedMountEnabled,
    "mounted": showInFiles && cacheDatabaseReady,
    "cacheDatabaseReady": cacheDatabaseReady,
    "requireDeviceAuth": requireDeviceAuth,
    "unlockedUntilMs": unlockedUntilMs,
    "unlockWindowSeconds": 0,
    "locked": locked,
  ]
}

@available(iOS 16.0, *)
private func fileProviderPrivacyState(defaults: UserDefaults?, domains: [NSFileProviderDomain]) -> [String: Any] {
  var state = fileProviderPrivacyState(defaults: defaults)
  let registered = domains.contains { $0.identifier == fileProviderDomainIdentifier }
  let showInFiles = state["showInFiles"] as? Bool ?? false
  state["registered"] = registered
  state["domainCount"] = domains.count
  let cacheDatabaseReady = state["cacheDatabaseReady"] as? Bool ?? false
  state["mounted"] = showInFiles && registered && cacheDatabaseReady
  state["locked"] = !showInFiles || !registered || !cacheDatabaseReady
  return state
}

@available(iOS 16.0, *)
private func currentFileProviderDomainStatus() async -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domains = (try? await getFileProviderDomains()) ?? []
  let registered = domains.contains { $0.identifier == domain.identifier }
  return fileProviderDomainStatus(
    domain: domain,
    registered: registered,
    added: false,
    domainCount: domains.count
  )
}

@available(iOS 16.0, *)
private func registerMountedFileProviderDomain(
  defaults: UserDefaults?,
  forceReset: Bool = false
) async throws -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domainsBefore = try await getFileProviderDomains()
  let existed = domainsBefore.contains { $0.identifier == domain.identifier }
  let needsLegacyMigration = existed && defaults?.string(forKey: fileProviderDomainSchemaKey) != fileProviderDomainSchemaVersion

  if forceReset || needsLegacyMigration {
    if existed {
      try await removeFileProviderDomain(domain)
    }
    _ = clearFileProviderCacheState(defaults: defaults)
  }
  if !existed || forceReset || needsLegacyMigration {
    try await addFileProviderDomain(domain)
  }
  let cacheReady = ensureFileProviderCacheDatabase()
  defaults?.set(fileProviderDomainSchemaVersion, forKey: fileProviderDomainSchemaKey)
  defaults?.synchronize()

  let rootError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
  let workingSetError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
  let manager = NSFileProviderManager(for: domain)
  let documentStorageURL = manager?.documentStorageURL.absoluteString
  let (userVisibleRootURL, userVisibleRootError) = await fileProviderRootVisibility(domain: domain)
  let domainsAfter = try await getFileProviderDomains()
  let registered = domainsAfter.contains { $0.identifier == domain.identifier }

  return fileProviderDomainStatus(
    domain: domain,
    registered: registered,
    added: !existed || forceReset || needsLegacyMigration,
    removedBeforeAdd: (forceReset && existed) || needsLegacyMigration,
    domainCount: domainsAfter.count,
    cacheDatabaseReady: cacheReady,
    documentStorageURL: documentStorageURL,
    userVisibleRootURL: userVisibleRootURL,
    userVisibleRootError: userVisibleRootError,
    rootEnumerationError: rootError,
    workingSetEnumerationError: workingSetError
  )
}

@available(iOS 16.0, *)
private func removeMountedFileProviderDomain(defaults: UserDefaults?) async throws -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domainsBefore = try await getFileProviderDomains()
  let existed = domainsBefore.contains { $0.identifier == domain.identifier }
  if existed {
    try await removeFileProviderDomain(domain)
  }
  _ = clearFileProviderSharedState(defaults: defaults)
  defaults?.synchronize()
  let domainsAfter = try await getFileProviderDomains()

  return fileProviderDomainStatus(
    domain: domain,
    registered: false,
    added: false,
    removedBeforeAdd: existed,
    domainCount: domainsAfter.count
  )
}

// All crypto runs through `BeebeebCryptoBridge`, which wraps the UniFFI
// bindings shipped in `BeebeebCore.xcframework` (linked via the
// `withUniffiBridge` config plugin).
public class BeebeebCryptoModule: Module {
  // ── Opaque master key handle registry ──────────────────────────────────
  //
  // JS holds only a numeric handle ID. All crypto operations pass the handle
  // to native, which resolves it to the real MasterKeyHandle. Raw key bytes
  // never cross the bridge after initial keychain load.
  private var masterKeyHandles: [Int: MasterKeyHandle] = [:]
  private var nextHandleId: Int = 1
  private let previewDownloadLock = NSLock()
  private var previewDownloadCancellations: [String: PreviewDownloadProgress] = [:]

  /// Store a MasterKeyHandle and return its opaque numeric ID.
  private func storeHandle(_ handle: MasterKeyHandle) -> Int {
    let id = nextHandleId
    nextHandleId += 1
    masterKeyHandles[id] = handle
    return id
  }

  /// Retrieve a MasterKeyHandle by its opaque ID.
  private func getHandle(_ id: Int) throws -> MasterKeyHandle {
    guard let handle = masterKeyHandles[id] else {
      throw NSError(
        domain: "BeebeebCrypto",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Invalid master key handle ID: \(id)"]
      )
    }
    return handle
  }

  private func storePreviewDownloadCancellation(
    _ cancellation: PreviewDownloadProgress,
    requestId: String?
  ) {
    guard let requestId, !requestId.isEmpty else { return }
    previewDownloadLock.lock()
    previewDownloadCancellations[requestId] = cancellation
    previewDownloadLock.unlock()
  }

  private func removePreviewDownloadCancellation(requestId: String?) {
    guard let requestId, !requestId.isEmpty else { return }
    previewDownloadLock.lock()
    previewDownloadCancellations.removeValue(forKey: requestId)
    previewDownloadLock.unlock()
  }

  private func cancelPreviewDownload(requestId: String) -> Bool {
    previewDownloadLock.lock()
    let cancellation = previewDownloadCancellations[requestId]
    previewDownloadLock.unlock()
    cancellation?.cancel()
    return cancellation != nil
  }

  private func splitEncryptedPreviewFile(
    encryptedUrl: URL,
    outputDir: URL,
    chunkCount: Int,
    originalSize: Int,
    plaintextChunkSize: Int
  ) throws -> [String] {
    guard chunkCount > 0 else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Invalid chunk count"]
      )
    }
    guard originalSize > 0, plaintextChunkSize > 0 else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Invalid download size metadata"]
      )
    }

    let chunkOverhead = 28
    let handle = try FileHandle(forReadingFrom: encryptedUrl)
    defer {
      try? handle.close()
    }

    var paths: [String] = []
    for index in 0..<chunkCount {
      let isLast = index == chunkCount - 1
      let plaintextSize = chunkCount == 1
        ? originalSize
        : (isLast ? originalSize - plaintextChunkSize * (chunkCount - 1) : plaintextChunkSize)
      guard plaintextSize > 0 else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 4,
          userInfo: [NSLocalizedDescriptionKey: "Invalid chunk size"]
        )
      }
      let encryptedChunkSize = plaintextSize + chunkOverhead
      let data = handle.readData(ofLength: encryptedChunkSize)
      guard data.count == encryptedChunkSize else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 5,
          userInfo: [NSLocalizedDescriptionKey: "Encrypted payload ended before chunk \(index)"]
        )
      }
      let path = outputDir.appendingPathComponent("\(index).enc").path
      try data.write(to: URL(fileURLWithPath: path))
      paths.append(path)
    }

    let remaining = handle.readDataToEndOfFile()
    if !remaining.isEmpty {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 6,
        userInfo: [NSLocalizedDescriptionKey: "Encrypted payload has trailing bytes"]
      )
    }
    return paths
  }

  public func definition() -> ModuleDefinition {
    Name("BeebeebCrypto")
    Events("onPreviewLoadProgress")

    AsyncFunction("logDiagnostic") { (marker: String, payload: String?) in
      if let payload, !payload.isEmpty {
        NSLog("[BeebeebDiagnostics] \(marker) \(payload)")
      } else {
        NSLog("[BeebeebDiagnostics] \(marker)")
      }
    }

    AsyncFunction("generateRandomBytes") { (length: Int) throws -> Data in
      guard length > 0, length <= 4096 else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Invalid random byte length"]
        )
      }

      var bytes = [UInt8](repeating: 0, count: length)
      let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
      guard status == errSecSuccess else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: Int(status),
          userInfo: [NSLocalizedDescriptionKey: "Secure random generator failed"]
        )
      }
      return Data(bytes)
    }

    AsyncFunction("generateRecoveryPhrase") { () throws -> [String: Any] in
      let result = try generateRecoveryPhrase()
      return [
        "phrase": result.phrase,
        "masterKey": result.masterKey,
      ]
    }

    AsyncFunction("recoverFromPhrase") { (phrase: String) throws -> [String: Any] in
      let masterKey = try recoverFromPhrase(phrase: phrase)
      return ["masterKey": masterKey]
    }

    AsyncFunction("computeRecoveryCheck") { (masterKey: Data) throws -> Data in
      try computeRecoveryCheck(masterKey: masterKey)
    }

    AsyncFunction("deriveX25519Private") { (masterKey: Data) throws -> Data in
      try deriveX25519Private(masterKey: masterKey)
    }

    AsyncFunction("deriveX25519Public") { (privateKey: Data) throws -> Data in
      try deriveX25519Public(privateKey: privateKey)
    }

    AsyncFunction("x25519SharedSecret") { (myPrivate: Data, theirPublic: Data) throws -> Data in
      try x25519SharedSecret(myPrivate: myPrivate, theirPublic: theirPublic)
    }

    AsyncFunction("deriveShareKey") { (sharedSecret: Data, fileId: Data) throws -> Data in
      try deriveShareKey(sharedSecret: sharedSecret, fileId: fileId)
    }

    // MARK: - File Requests (0643)
    //
    // Per-request sealed-keypair crypto (ECIES) for file requests. Mirrors the
    // web reference (repos/web/src/lib/crypto.ts) byte-for-byte at the core
    // level: same UniFFI functions, same EMPTY HKDF context, same X25519/HKDF/
    // AES — so links round-trip cross-client.
    //
    // Invariants:
    //  - The MASTER key never crosses to JS (task 0556). wrap/unwrap export the
    //    raw key transiently from the in-memory MasterKeyHandle and zero it.
    //  - R_priv is generated with SecRandomCopyBytes and, on create, never
    //    leaves native — only {publicKey, wrapped, nonce} are returned.
    //  - The HKDF context is EMPTY (`Data()`) for BOTH wrap (requestId) and open
    //    (fileId) — the ratified cross-client contract (decision 0651). The
    //    server-assigned ids are NOT used; uniqueness comes from the random
    //    keypair, ephemeral keypair, content key, and GCM nonce.
    //
    // New tracks (camera-roll 0672, ShareUploader 0673) MUST add their own
    // marked regions and not interleave here.

    AsyncFunction("createRequestKeypairWithHandle") { [self] (handleId: Int) throws -> [String: Any] in
      // 1. Fresh per-request X25519 private key (32 CSPRNG bytes).
      var rPrivBytes = [UInt8](repeating: 0, count: 32)
      let status = SecRandomCopyBytes(kSecRandomDefault, 32, &rPrivBytes)
      guard status == errSecSuccess else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: Int(status),
          userInfo: [NSLocalizedDescriptionKey: "Secure random generator failed"]
        )
      }
      var rPriv = Data(rPrivBytes)
      rPrivBytes.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
      }
      defer { rPriv.resetBytes(in: 0..<rPriv.count) }

      // 2. Derive R_pub (goes in the link fragment, never persisted server-side).
      let rPub = try deriveX25519Public(privateKey: rPriv)

      // 3. Wrap R_priv under the master key (raw bytes stay native, zeroed after).
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      let wrapped = try wrapRequestPrivate(masterKey: masterKeyBytes, requestId: Data(), rPriv: rPriv)
      return [
        "publicKey": rPub,
        "wrapped": wrapped.wrapped,
        "nonce": wrapped.nonce,
      ]
    }

    AsyncFunction("unwrapRequestPrivateWithHandle") { [self] (handleId: Int, wrapped: Data, nonce: Data) throws -> Data in
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      // Returns R_priv to JS; the caller (RequestKeyResolver) caches it and
      // zeroizes on vault lock.
      return try unwrapRequestPrivate(masterKey: masterKeyBytes, requestId: Data(), wrapped: wrapped, nonce: nonce)
    }

    AsyncFunction("openRequestUpload") { (rPriv: Data, ePub: Data, wrappedKey: Data) throws -> Data in
      // Recover the content key C for a request-uploaded file (owner decrypt).
      // No master key needed — R_priv is supplied by the caller.
      try openRequestUpload(rPriv: rPriv, ePub: ePub, fileId: Data(), wrappedKey: wrappedKey)
    }

    AsyncFunction("encryptChunk") { (key: Data, plaintext: Data) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptChunk(key: key, plaintext: plaintext)
      return [
        "cipherSuite": result.cipherSuite,
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptChunk") { (key: Data, nonce: Data, ciphertext: Data) throws -> Data in
      try BeebeebCryptoBridge.decryptChunk(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("encryptMetadata") { (key: Data, metadata: String) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptMetadata(key: key, metadata: metadata)
      return [
        "cipherSuite": result.cipherSuite,
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptMetadata") { (key: Data, nonce: Data, ciphertext: Data) throws -> String in
      try BeebeebCryptoBridge.decryptMetadata(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("renderPdfFirstPage") { (inputUri: String, outputUri: String, maxDimension: Double) throws -> String? in
      let inputURL = fileURL(fromURI: inputUri)
      let outputURL = fileURL(fromURI: outputUri)

      guard let document = PDFDocument(url: inputURL), let page = document.page(at: 0) else {
        return nil
      }

      let pageBounds = page.bounds(for: .mediaBox)
      guard pageBounds.width > 0, pageBounds.height > 0 else {
        return nil
      }

      let safeMaxDimension = max(320, min(maxDimension, 2400))
      let scale = min(safeMaxDimension / pageBounds.width, safeMaxDimension / pageBounds.height)
      let outputSize = CGSize(width: pageBounds.width * scale, height: pageBounds.height * scale)

      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
      let image = renderer.image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: outputSize))
        context.cgContext.saveGState()
        context.cgContext.translateBy(x: 0, y: outputSize.height)
        context.cgContext.scaleBy(x: scale, y: -scale)
        context.cgContext.translateBy(x: -pageBounds.origin.x, y: -pageBounds.origin.y)
        page.draw(with: .mediaBox, to: context.cgContext)
        context.cgContext.restoreGState()
      }

      guard let data = image.pngData() else {
        return nil
      }

      try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: outputURL, options: .atomic)
      return outputURL.absoluteString
    }

    AsyncFunction("opaqueRegistrationStart") { (_ username: String, password: String) throws -> [String: Any] in
      let result = try opaqueRegistrationStart(password: Data(password.utf8))
      return [
        "state": result.state.base64EncodedString(),
        "message": result.message.base64EncodedString(),
      ]
    }

    AsyncFunction("opaqueRegistrationFinish") { (state: String, serverMessage: String, password: String) throws -> [String: Any] in
      let stateData = try decodeBase64(state, field: "state")
      let serverMessageData = try decodeBase64(serverMessage, field: "serverMessage")
      let record = try opaqueRegistrationFinish(clientState: stateData, password: Data(password.utf8), serverResponse: serverMessageData)
      return ["record": record.base64EncodedString()]
    }

    AsyncFunction("opaqueLoginStart") { (username: String, password: String) throws -> [String: Any] in
      let result = try opaqueLoginStart(password: Data(password.utf8))
      return [
        "state": result.state.base64EncodedString(),
        "message": result.message.base64EncodedString(),
      ]
    }

    AsyncFunction("opaqueLoginFinish") { (state: String, serverMessage: String, password: String) throws -> [String: Any] in
      let stateData = try decodeBase64(state, field: "state")
      let serverMessageData = try decodeBase64(serverMessage, field: "serverMessage")
      let result = try opaqueLoginFinish(clientState: stateData, password: Data(password.utf8), serverResponse: serverMessageData)
      return [
        "message": result.message.base64EncodedString(),
        "sessionKey": result.sessionKey.base64EncodedString(),
        "exportKey": result.exportKey.base64EncodedString(),
      ]
    }

    AsyncFunction("deriveFileKey") { (masterKey: Data, fileId: String) throws -> Data in
      try BeebeebCryptoBridge.deriveFileKey(masterKey: masterKey, fileId: fileId)
    }

    // ── Handle-based crypto operations ─────────────────────────────────
    //
    // These accept an opaque handle ID from JS instead of raw key bytes.
    // The handle is resolved to the real MasterKeyHandle on the native
    // side; raw key material never crosses the bridge.

    AsyncFunction("handleEncryptChunk") { [self] (handleId: Int, fileId: String, plaintext: Data) throws -> [String: Any] in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fk.encryptChunk(plaintext: plaintext)
      return [
        "cipherSuite": enc.cipherSuite,
        "nonce": enc.nonce,
        "ciphertext": enc.ciphertext,
      ]
    }

    AsyncFunction("handleDecryptChunk") { [self] (handleId: Int, fileId: String, nonce: Data, ciphertext: Data) throws -> Data in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      return try fk.decryptChunk(nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("handleEncryptMetadata") { [self] (handleId: Int, fileId: String, metadata: String) throws -> [String: Any] in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fk.encryptMetadata(metadata: metadata)
      return [
        "cipherSuite": enc.cipherSuite,
        "nonce": enc.nonce,
        "ciphertext": enc.ciphertext,
      ]
    }

    AsyncFunction("handleDecryptMetadata") { [self] (handleId: Int, fileId: String, nonce: Data, ciphertext: Data) throws -> String in
      let master = try self.getHandle(handleId)
      let fk = try master.deriveFileKey(fileId: Data(fileId.utf8))
      return try fk.decryptMetadata(nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("handleDeriveX25519Private") { [self] (handleId: Int) throws -> Data in
      let master = try self.getHandle(handleId)
      return try master.deriveX25519Private()
    }

    AsyncFunction("handleDeriveFileKey") { [self] (handleId: Int, fileId: String) throws -> Data in
      let master = try self.getHandle(handleId)
      var masterKeyBytes = try master.exportForKeychain()
      defer {
        masterKeyBytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      return try BeebeebCryptoBridge.deriveFileKey(masterKey: masterKeyBytes, fileId: fileId)
    }

    AsyncFunction("handleComputeRecoveryCheck") { [self] (handleId: Int) throws -> Data in
      let master = try self.getHandle(handleId)
      return try master.computeRecoveryCheck()
    }

    AsyncFunction("releaseHandle") { [self] (handleId: Int) in
      self.masterKeyHandles.removeValue(forKey: handleId)
      if self.masterKeyHandles.isEmpty {
        BeebeebCryptoBridge.clearCachedMasterKey()
      }
    }

    AsyncFunction("storeKeyInKeychain") { (masterKeyBytes: Data, label: String) throws in
      RuntimeTrace.event("keychain.bridge.store.request", ["label": label])
      do {
        try KeychainManager.store(masterKeyBytes: masterKeyBytes, label: label)
        RuntimeTrace.event("keychain.bridge.store.success", ["label": label])
      } catch {
        RuntimeTrace.event("keychain.bridge.store.failed", ["label": label, "error": error.localizedDescription])
        throw error
      }
    }

    AsyncFunction("loadKeyFromKeychain") { (label: String) throws -> Data? in
      RuntimeTrace.event("keychain.bridge.load_bytes.request", [
        "label": label,
        "promptMayAppear": true
      ])
      do {
        let key = try KeychainManager.load(label: label)
        RuntimeTrace.event("keychain.bridge.load_bytes.result", [
          "label": label,
          "found": key != nil
        ])
        return key
      } catch {
        RuntimeTrace.event("keychain.bridge.load_bytes.failed", [
          "label": label,
          "error": error.localizedDescription
        ])
        throw error
      }
    }

    // ── Opaque handle-based keychain load ──────────────────────────────
    //
    // Returns an opaque numeric handle ID instead of raw key bytes.
    // The real MasterKeyHandle stays in native memory; JS never sees
    // the key material.

    AsyncFunction("loadKeyFromKeychainAsHandle") { [self] (label: String) throws -> Int? in
      RuntimeTrace.event("keychain.bridge.load_handle.request", [
        "label": label,
        "promptMayAppear": true
      ])
      guard let keyData = try KeychainManager.load(label: label) else {
        RuntimeTrace.event("keychain.bridge.load_handle.miss", ["label": label])
        return nil
      }
      let handle = try MasterKeyHandle.fromKeychainBytes(bytes: keyData)
      // Zero the raw bytes now that the handle owns the key
      var mutableData = keyData
      mutableData.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
      }
      BeebeebCryptoBridge.setCachedMasterKey(handle)
      let handleId = self.storeHandle(handle)
      RuntimeTrace.event("keychain.bridge.load_handle.success", [
        "label": label,
        "handleId": handleId
      ])
      return handleId
    }

    AsyncFunction("createMasterKeyHandle") { [self] (masterKeyBytes: Data) throws -> Int in
      let handle = try MasterKeyHandle.fromKeychainBytes(bytes: masterKeyBytes)
      var mutableData = masterKeyBytes
      mutableData.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
      }
      BeebeebCryptoBridge.setCachedMasterKey(handle)
      let handleId = self.storeHandle(handle)
      RuntimeTrace.event("keychain.bridge.create_handle.success", ["handleId": handleId])
      return handleId
    }

    AsyncFunction("deleteKeyFromKeychain") { () throws -> Bool in
      KeychainManager.delete()
      return true
    }

    AsyncFunction("setRequireBiometric") { (require: Bool) throws -> Bool in
      RuntimeTrace.event("keychain.bridge.set_require_biometric.request", [
        "require": require,
        "promptMayAppear": true
      ])
      try KeychainManager.setAccessControl(requireBiometric: require)
      RuntimeTrace.event("keychain.bridge.set_require_biometric.success", ["require": require])
      return true
    }

    AsyncFunction("replaceKeychainAccessControl") { (require: Bool, masterKeyBytes: Data, label: String) throws -> Bool in
      RuntimeTrace.event("keychain.bridge.replace_access_control.request", [
        "require": require,
        "label": label,
        "source": "raw_bytes"
      ])
      try KeychainManager.replaceAccessControl(requireBiometric: require, masterKeyBytes: masterKeyBytes, label: label)
      RuntimeTrace.event("keychain.bridge.replace_access_control.success", [
        "require": require,
        "label": label,
        "source": "raw_bytes"
      ])
      return true
    }

    // Re-wrap the SE-protected master key under a new access-control policy
    // without re-reading the existing wrapped blob from the Keychain. Reading
    // the existing blob triggers Face ID under the current policy, which is
    // exactly the surprise prompt the user reported when toggling biometrics
    // (task 0556). The cached `MasterKeyHandle` already holds the key in
    // native memory; export it transiently, hand it to `KeychainManager`, and
    // zero the buffer before returning. Raw bytes never cross the JS bridge.
    AsyncFunction("replaceKeychainAccessControlFromHandle") { [self] (handleId: Int, require: Bool, label: String) throws -> Bool in
      RuntimeTrace.event("keychain.bridge.replace_access_control.request", [
        "require": require,
        "label": label,
        "handleId": handleId,
        "source": "handle"
      ])
      let master = try self.getHandle(handleId)
      var bytes = try master.exportForKeychain()
      defer {
        bytes.withUnsafeMutableBytes { ptr in
          if let base = ptr.baseAddress { memset(base, 0, ptr.count) }
        }
      }
      try KeychainManager.replaceAccessControl(requireBiometric: require, masterKeyBytes: bytes, label: label)
      RuntimeTrace.event("keychain.bridge.replace_access_control.success", [
        "require": require,
        "label": label,
        "handleId": handleId,
        "source": "handle"
      ])
      return true
    }

    AsyncFunction("mirrorSessionToAppGroup") { (token: String?, baseUrl: String?) -> Bool in
      // Session token + apiBaseUrl go to the SHARED Keychain
      // (`BeebeebKeychainCore` with the App Group access group +
      // `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) so the File
      // Provider extension + Share Extension can read them after first
      // unlock, and so they're EXCLUDED from unencrypted iCloud / iTunes
      // device backups. This replaces the previous App-Group UserDefaults
      // path that leaked the bearer in plaintext (task 0447). The
      // per-app KeychainManager copy for the backup engine
      // (`io.beebeeb.backupToken` / `io.beebeeb.serverURL`) stays — it's
      // a separate keychain item used only by `NativeBackupEngine`
      // running in the main app address space (task 0430).
      if let token, !token.isEmpty {
        try? BeebeebKeychainCore.storeString(token, key: sharedSessionTokenKey)
        try? KeychainManager.storeString(token, key: "io.beebeeb.backupToken")
      } else {
        BeebeebKeychainCore.deleteString(key: sharedSessionTokenKey)
        KeychainManager.deleteString(key: "io.beebeeb.backupToken")
      }
      if let baseUrl, !baseUrl.isEmpty {
        try? BeebeebKeychainCore.storeString(baseUrl, key: sharedAPIBaseURLKey)
        try? KeychainManager.storeString(baseUrl, key: "io.beebeeb.serverURL")
      } else {
        BeebeebKeychainCore.deleteString(key: sharedAPIBaseURLKey)
        KeychainManager.deleteString(key: "io.beebeeb.serverURL")
      }
      return true
    }

    AsyncFunction("mirrorSimulatorFileProviderMasterKey") { (masterKeyBase64: String?) -> Bool in
      guard let defaults = sharedDefaults() else {
        return false
      }
      _ = masterKeyBase64
      defaults.removeObject(forKey: simulatorFileProviderMasterKeyKey)
      defaults.synchronize()
      return false
    }

    AsyncFunction("registerFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let defaults = sharedDefaults()
      guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false),
            sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
      else {
        return await currentFileProviderDomainStatus()
      }

      return try await registerMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("listFileProviderDomains") { () async throws -> [[String: Any]] in
      guard #available(iOS 16.0, *) else {
        return []
      }

      let domains = try await getFileProviderDomains()
      return domains.map { domain in
        [
          "identifier": domain.identifier.rawValue,
          "displayName": domain.displayName,
          "isBeebeeb": domain.identifier == fileProviderDomainIdentifier,
        ]
      }
    }

    AsyncFunction("resetFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let domain = beebeebFileProviderDomain()
      let domainsBefore = try await getFileProviderDomains()
      let existed = domainsBefore.contains { $0.identifier == domain.identifier }
      if existed {
        try await removeFileProviderDomain(domain)
      }
      _ = clearFileProviderCacheState(defaults: sharedDefaults())
      try await addFileProviderDomain(domain)
      let cacheReady = ensureFileProviderCacheDatabase()
      let defaults = sharedDefaults()
      defaults?.set(fileProviderDomainSchemaVersion, forKey: fileProviderDomainSchemaKey)
      defaults?.synchronize()

      let rootError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
      let workingSetError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
      let manager = NSFileProviderManager(for: domain)
      let documentStorageURL = manager?.documentStorageURL.absoluteString
      let (userVisibleRootURL, userVisibleRootError) = await fileProviderRootVisibility(domain: domain)
      let domainsAfter = try await getFileProviderDomains()

      return fileProviderDomainStatus(
        domain: domain,
        registered: true,
        added: true,
        removedBeforeAdd: existed,
        domainCount: domainsAfter.count,
        cacheDatabaseReady: cacheReady,
        documentStorageURL: documentStorageURL,
        userVisibleRootURL: userVisibleRootURL,
        userVisibleRootError: userVisibleRootError,
        rootEnumerationError: rootError,
        workingSetEnumerationError: workingSetError
      )
    }

    AsyncFunction("unregisterFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let defaults = sharedDefaults()
      return try await removeMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("setFileProviderEnabled") { (enabled: Bool) async throws -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(enabled, forKey: fileProviderEnabledKey)
      if !enabled {
        _ = clearFileProviderSharedState(defaults: defaults)
      }
      defaults?.synchronize()

      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      if enabled {
        guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false) else {
          return try await removeMountedFileProviderDomain(defaults: defaults)
        }
        return try await registerMountedFileProviderDomain(defaults: defaults)
      }

      return try await removeMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("mountFileProviderAccess") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        let defaults = sharedDefaults()
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let defaults = sharedDefaults()
      defaults?.set(true, forKey: fileProviderEnabledKey)
      defaults?.set(true, forKey: fileProviderTrustedMountKey)
      defaults?.set(true, forKey: fileProviderAuthRequiredKey)
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()

      return try await registerMountedFileProviderDomain(defaults: defaults, forceReset: true)
    }

    AsyncFunction("removeFileProviderAccess") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        let defaults = sharedDefaults()
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      return try await removeMountedFileProviderDomain(defaults: sharedDefaults())
    }

    AsyncFunction("getFileProviderPrivacyState") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      guard #available(iOS 16.0, *) else {
        var state = fileProviderPrivacyState(defaults: defaults)
        state["supported"] = false
        state["showInFiles"] = false
        state["mounted"] = false
        state["locked"] = true
        state["registered"] = false
        state["domainCount"] = 0
        return state
      }

      let domains = (try? await getFileProviderDomains()) ?? []
      return fileProviderPrivacyState(defaults: defaults, domains: domains)
    }

    AsyncFunction("setFileProviderAuthRequired") { (required: Bool) async -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(required, forKey: fileProviderAuthRequiredKey)
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("unlockFileProviderAccess") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("lockFileProviderAccess") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      _ = clearFileProviderSharedState(defaults: defaults)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    // ── File Provider cache pre-population ──────────────────────────────
    //
    // The File Provider extension cannot decrypt filenames when BeebeebCore
    // xcframework is not linked to the extension target. As a workaround the
    // main app decrypts names on the JS side and writes them to the shared
    // SQLite cache here.

    AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]]) -> Int in
      guard let containerUrl = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      ) else {
        return 0
      }
      let dbPath = containerUrl.appendingPathComponent("file-provider-cache.sqlite").path
      var db: OpaquePointer?
      guard sqlite3_open_v2(
        dbPath,
        &db,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        nil
      ) == SQLITE_OK, let db else {
        sqlite3_close(db)
        return 0
      }
      defer { sqlite3_close(db) }

      // Ensure the table exists (idempotent)
      let createSql = """
      CREATE TABLE IF NOT EXISTS file_cache (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_encrypted TEXT,
        name_decrypted TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        is_folder INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        has_thumbnail INTEGER NOT NULL DEFAULT 0,
        thumbnail_data BLOB,
        thumbnail_nonce BLOB,
        created_at TEXT,
        updated_at TEXT,
        sync_anchor INTEGER NOT NULL DEFAULT 0,
        is_materialized INTEGER NOT NULL DEFAULT 0
      );
      """
      sqlite3_exec(db, createSql, nil, nil, nil)

      let upsertSql = """
      INSERT INTO file_cache(
        id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
        is_folder, is_pinned, has_thumbnail, created_at, updated_at, sync_anchor, is_materialized
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        name_encrypted = excluded.name_encrypted,
        name_decrypted = COALESCE(excluded.name_decrypted, file_cache.name_decrypted),
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        is_folder = excluded.is_folder,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        sync_anchor = excluded.sync_anchor;
      """

      sqlite3_exec(db, "BEGIN", nil, nil, nil)
      var count = 0
      let now = Int64(Date().timeIntervalSince1970 * 1000)
      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
      var touchedParentIdentifiers = Set<String>()

      for entry in entries {
        guard let id = entry["id"] as? String else { continue }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, upsertSql, -1, &stmt, nil) == SQLITE_OK else { continue }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, transient)
        if let parentId = entry["parent_id"] as? String {
          sqlite3_bind_text(stmt, 2, (parentId as NSString).utf8String, -1, transient)
          touchedParentIdentifiers.insert(parentId)
        } else { sqlite3_bind_null(stmt, 2) }
        if entry["parent_id"] == nil || entry["parent_id"] is NSNull {
          touchedParentIdentifiers.insert(NSFileProviderItemIdentifier.rootContainer.rawValue)
        }
        if let nameEnc = entry["name_encrypted"] as? String {
          sqlite3_bind_text(stmt, 3, (nameEnc as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 3) }
        if let nameDec = entry["name_decrypted"] as? String, !nameDec.isEmpty {
          sqlite3_bind_text(stmt, 4, (nameDec as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 4) }
        if let mime = entry["mime_type"] as? String {
          sqlite3_bind_text(stmt, 5, (mime as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 5) }
        sqlite3_bind_int64(stmt, 6, Int64(entry["size_bytes"] as? Int ?? 0))
        sqlite3_bind_int(stmt, 7, (entry["is_folder"] as? Bool ?? false) ? 1 : 0)
        if let createdAt = entry["created_at"] as? String {
          sqlite3_bind_text(stmt, 8, (createdAt as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 8) }
        if let updatedAt = entry["updated_at"] as? String {
          sqlite3_bind_text(stmt, 9, (updatedAt as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 9) }
        sqlite3_bind_int64(stmt, 10, now)

        if sqlite3_step(stmt) == SQLITE_DONE { count += 1 }
      }
      sqlite3_exec(db, "COMMIT", nil, nil, nil)

      // Signal the File Provider to re-enumerate so it picks up fresh names.
      if #available(iOS 16.0, *), count > 0 {
        let domain = beebeebFileProviderDomain()
        for rawIdentifier in touchedParentIdentifiers {
          let itemIdentifier: NSFileProviderItemIdentifier = rawIdentifier == NSFileProviderItemIdentifier.rootContainer.rawValue
            ? .rootContainer
            : NSFileProviderItemIdentifier(rawIdentifier)
          NSFileProviderManager(for: domain)?.signalEnumerator(for: itemIdentifier) { _ in }
        }
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
      }

      return count
    }

    // ── Backup management ──────────────────────────────────────────────

    AsyncFunction("configureBackupFolder") { (category: String, parentFolderId: String?) in
      RuntimeTrace.event("backup.configure_folder", [
        "category": category,
        "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
      ])
      switch category {
      case "camera_roll":
        PhotoBackupManager.shared.configure(parentFolderId: parentFolderId)
        NativeBackupEngine.shared.parentFolderId = parentFolderId
      case "contacts":
        ContactsBackupManager.shared.configure(parentFolderId: parentFolderId)
      case "calendar":
        CalendarBackupManager.shared.configure(parentFolderId: parentFolderId)
      default:
        break
      }
    }

    AsyncFunction("enablePhotoBackup") { (authToken: String) in
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      if engine.apiBaseUrl == nil {
        engine.apiBaseUrl = KeychainManager.loadString(key: "io.beebeeb.serverURL")
      }
      engine.start()
    }

    AsyncFunction("disablePhotoBackup") { () in
      NativeBackupEngine.shared.stop()
    }

    AsyncFunction("enableContactsBackup") { (authToken: String) in
      ContactsBackupManager.shared.enable(authToken: authToken, runNow: true)
    }

    AsyncFunction("resumeContactsBackup") { (authToken: String) in
      ContactsBackupManager.shared.enable(authToken: authToken, runNow: false)
    }

    AsyncFunction("disableContactsBackup") { () in
      ContactsBackupManager.shared.disable()
    }

    AsyncFunction("getContactsBackupStatus") { () -> [String: Any] in
      return ContactsBackupManager.shared.status()
    }

    AsyncFunction("enableCalendarBackup") { (authToken: String) in
      CalendarBackupManager.shared.enable(authToken: authToken, runNow: true)
    }

    AsyncFunction("resumeCalendarBackup") { (authToken: String) in
      CalendarBackupManager.shared.enable(authToken: authToken, runNow: false)
    }

    AsyncFunction("disableCalendarBackup") { () in
      CalendarBackupManager.shared.disable()
    }

    AsyncFunction("getCalendarBackupStatus") { () -> [String: Any] in
      return CalendarBackupManager.shared.status()
    }

    AsyncFunction("getBackupProgress") { () -> [String: Any] in
      return NativeBackupEngine.shared.currentProgress()
    }

    // ── 0437 single-owner bridge (Swift drives, TS reads) ─────────────
    //
    // Match the contract in `src/lib/backup-bridge.ts`. `getBackupStatus`
    // returns a `BackupStatusSnapshot`-shaped dictionary; `getAssetStatus`
    // returns the per-asset 4-state string or `nil`. The event channel
    // (`addBackupStatusListener` → `backup-status-changed`) and the
    // `migrateLegacyBackupState` ingest path land in the 0437 (b)
    // checkpoint — this is the read-side slice.

    AsyncFunction("getBackupStatus") { () -> [String: Any] in
      return NativeBackupEngine.shared.snapshotForBridge()
    }

    AsyncFunction("getAssetStatus") { (localId: String) -> String? in
      return NativeBackupEngine.shared.assetStatusForBridge(localId: localId)
    }

    // ── 0438 Expo wrapper for the Rust-side fast-path decrypt ─────────
    //
    // rust-engineer shipped `decryptContiguousToFile` in core (commit
    // `c5335ff`); ts-engineer wired the JS side (`src/lib/decrypt-to-file.ts`
    // and `src/lib/native-decrypt.ts`, gated by `isDecryptToFileReady()`
    // runtime probe). This 5-line wrapper exposes the UniFFI binding to JS
    // so the probe flips and the fast path takes over (Rust slices, decrypts
    // and writes in one call — no per-chunk JSI round-trips). The per-chunk
    // JS loop stays in place as the fallback path.
    AsyncFunction("decryptContiguousToFile") {
      (fileKey: Data, body: Data, chunkSize: UInt64, outputPath: String) throws -> UInt64 in
      // UniFFI emits this as a top-level function in `beebeeb_uniffi.swift`,
      // not under a namespace — call it directly.
      return try decryptContiguousToFile(
        fileKey: fileKey, body: body, chunkSize: chunkSize, outputPath: outputPath
      )
    }

    AsyncFunction("triggerImmediateBackup") { (authToken: String) async throws -> [String: Any] in
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      if engine.apiBaseUrl == nil {
        engine.apiBaseUrl = KeychainManager.loadString(key: "io.beebeeb.serverURL")
      }
      return try await engine.triggerManualBackup(limit: 50)
    }

    // ── Share Extension: pending shares dropped by BeebeebShare ────────
    //
    // The iOS Share Extension writes files into the App Group container at
    // group.io.beebeeb.shared/IncomingShares/. The main app picks them up
    // here, copies each into its own sandbox so the JS side can fetch a
    // file:// URI, and removes the App Group copy on `consume`.

    AsyncFunction("listPendingShares") { () throws -> [[String: Any]] in
      try PendingSharesAccess.list()
    }

    AsyncFunction("consumePendingShare") { (id: String) throws -> [String: Any] in
      try PendingSharesAccess.consume(id: id)
    }

    AsyncFunction("acknowledgePendingShare") { (id: String) throws -> Bool in
      try PendingSharesAccess.acknowledge(id: id)
    }

    AsyncFunction("clearAllPendingShares") { () throws -> Int in
      try PendingSharesAccess.clearAll()
    }

    // ── Backup progress notification ─────────────────────────────────────

    AsyncFunction("configureBackupNotificationSettings") { (backupSummaries: Bool, noChangeCheckins: Bool, actionNeeded: Bool) in
      let defaults = UserDefaults.standard
      defaults.set(backupSummaries, forKey: "io.beebeeb.backupNotifications.backupSummaries")
      defaults.set(noChangeCheckins, forKey: "io.beebeeb.backupNotifications.noChangeCheckins")
      defaults.set(actionNeeded, forKey: "io.beebeeb.backupNotifications.actionNeeded")
    }

    AsyncFunction("updateBackupNotification") { (uploaded: Int, total: Int, throughputMBps: Double, isComplete: Bool, completionBody: String?) in
      let appIsActive = await MainActor.run {
        UIApplication.shared.applicationState == .active
      }
      if appIsActive {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
        return
      }

      let content = UNMutableNotificationContent()
      content.title = "Beebeeb Backup"
      guard isComplete else { return }
      content.body = completionBody ?? "\(total) photos secured"
      content.sound = nil

      let request = UNNotificationRequest(
        identifier: "io.beebeeb.backup-progress",
        content: content,
        trigger: nil
      )
      try? await UNUserNotificationCenter.current().add(request)

      if isComplete {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
          UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: ["io.beebeeb.backup-progress"]
          )
        }
      }
    }

    AsyncFunction("clearBackupNotification") { () in
      UNUserNotificationCenter.current().removeDeliveredNotifications(
        withIdentifiers: ["io.beebeeb.backup-progress"]
      )
    }

    // ── Native Backup Engine ──────────────────────────────────────────────

    AsyncFunction("startNativeBackup") { (authToken: String, apiBaseUrl: String, parentFolderId: String?) in
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      engine.apiBaseUrl = apiBaseUrl
      engine.parentFolderId = parentFolderId
      engine.start()
    }

    AsyncFunction("stopNativeBackup") { () in
      NativeBackupEngine.shared.stop()
    }

    AsyncFunction("pauseNativeBackup") { () in
      NativeBackupEngine.shared.pause()
    }

    AsyncFunction("resumeNativeBackup") { () in
      NativeBackupEngine.shared.resume()
    }

    AsyncFunction("getNativeBackupProgress") { () -> [String: Any] in
      return NativeBackupEngine.shared.currentProgress()
    }

    AsyncFunction("getNativeBackupDiagnostics") { () -> [String: Any] in
      return NativeBackupEngine.shared.diagnosticSnapshot()
    }

    AsyncFunction("triggerNativeBackupBatch") { () async throws -> [String: Any] in
      let uploaded = try await NativeBackupEngine.shared.processBatch(limit: 12)
      return NativeBackupEngine.shared.currentProgress().merging(
        ["batchUploaded": uploaded],
        uniquingKeysWith: { _, new in new }
      )
    }

    // ── Rust upload bridge for manual (non-backup) uploads ────────────
    //
    // Calls the Rust `uploadEncryptedFile()` from the beebeeb-upload crate.
    // The caller (JS) provides pre-encrypted chunk file paths. The Rust
    // function handles init → chunk upload → complete in one blocking call.

    AsyncFunction("uploadEncryptedFileNative") { (params: [String: Any]) throws -> [String: Any] in
      guard let apiUrl = params["apiUrl"] as? String,
            let token = params["token"] as? String,
            let fileId = params["fileId"] as? String,
            let nameEncrypted = params["nameEncrypted"] as? String,
            let chunkPaths = params["chunkPaths"] as? [String],
            let originalSize = params["originalSize"] as? Int
      else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Missing required parameters for uploadEncryptedFileNative"]
        )
      }
      let parentId = params["parentId"] as? String
      let mimeType = params["mimeType"] as? String
      let isMediaFlag = params["isMedia"] as? Bool ?? false
      let createdAt = params["createdAt"] as? String

      let result = try uploadEncryptedFile(
        apiUrl: apiUrl,
        token: token,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        parentId: parentId,
        mimeType: mimeType,
        isMedia: isMediaFlag,
        chunkPaths: chunkPaths,
        originalSize: UInt64(originalSize),
        createdAt: createdAt,
        callback: nil
      )
      return [
        "fileId": result.fileId,
        "uploadSessionId": result.uploadSessionId,
        "chunksUploaded": result.chunksUploaded,
        "totalBytes": result.totalBytes,
      ]
    }

    // ── Rust download + decrypt bridge for previews ───────────────────
    //
    // Downloads the encrypted file and writes decrypted plaintext directly to
    // disk through Rust/Swift. JS receives only the output file URI and never
    // holds encrypted bytes, decrypted bytes, or base64 copies in its heap.

    AsyncFunction("downloadAndDecryptFileNative") { [self] (
      handleId: Int,
      apiUrl: String,
      token: String,
      fileId: String,
      outputUri: String,
      requestId: String?
    ) async throws -> [String: Any] in
      RuntimeTrace.event("preview.native_download.request", [
        "fileId": fileId,
        "hasRequestId": requestId != nil
      ])
      let master = try self.getHandle(handleId)
      let outputURL = fileURL(fromURI: outputUri)
      let outputPath = outputURL.path
      let progress = PreviewDownloadProgress(requestId: requestId, fileId: fileId) { [weak self] body in
        DispatchQueue.main.async {
          self?.sendEvent("onPreviewLoadProgress", body)
        }
      }
      self.storePreviewDownloadCancellation(progress, requestId: requestId)
      if Task.isCancelled {
        progress.cancel()
      }
      defer {
        self.removePreviewDownloadCancellation(requestId: requestId)
      }

      let tempDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("beebeeb-preview-\(fileId)-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
      defer {
        try? FileManager.default.removeItem(at: tempDir)
      }

      let downloadUrl = URL(string: "\(apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/v1/files/\(fileId)/download")!
      var request = URLRequest(url: downloadUrl)
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

      progress.emitProgress(stage: "downloading", bytesDownloaded: 0, bytesTotal: 0)
      let delegate = PreviewEncryptedDownloadDelegate(progress: progress)
      let (encryptedUrl, response) = try await delegate.download(request: request)
      RuntimeTrace.event("preview.native_download.response", [
        "fileId": fileId,
        "status": response.statusCode,
        "contentLength": Int(response.value(forHTTPHeaderField: "Content-Length") ?? "") ?? 0,
        "chunkCountHeader": Int(response.value(forHTTPHeaderField: "X-Chunk-Count") ?? "") ?? 0,
        "originalSizeHeader": Int(response.value(forHTTPHeaderField: "X-Original-Size") ?? "") ?? 0,
        "chunkSizeHeader": Int(response.value(forHTTPHeaderField: "X-Chunk-Size") ?? "") ?? 0
      ])
      defer {
        try? FileManager.default.removeItem(at: encryptedUrl)
      }

      guard response.statusCode >= 200 && response.statusCode < 300 else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: response.statusCode,
          userInfo: [NSLocalizedDescriptionKey: "Download failed with HTTP \(response.statusCode)"]
        )
      }

      let encryptedSize = Int((try FileManager.default.attributesOfItem(atPath: encryptedUrl.path)[.size] as? NSNumber)?.intValue ?? 0)
      let chunkCount = Int(response.value(forHTTPHeaderField: "X-Chunk-Count") ?? "")
        ?? 1
      let originalSize = Int(response.value(forHTTPHeaderField: "X-Original-Size") ?? "")
        ?? max(0, encryptedSize - 28)
      let headerChunkSize = Int(response.value(forHTTPHeaderField: "X-Chunk-Size") ?? "")
      let plaintextChunkSize = chunkCount <= 1
        ? originalSize
        : (headerChunkSize ?? (4 * 1024 * 1024))
      RuntimeTrace.event("preview.native_download.chunk_metadata", [
        "fileId": fileId,
        "encryptedSize": encryptedSize,
        "originalSize": originalSize,
        "chunkCount": chunkCount,
        "plaintextChunkSize": plaintextChunkSize,
        "hasHeaderChunkSize": headerChunkSize != nil
      ])

      let chunkPaths = try self.splitEncryptedPreviewFile(
        encryptedUrl: encryptedUrl,
        outputDir: tempDir,
        chunkCount: chunkCount,
        originalSize: originalSize,
        plaintextChunkSize: plaintextChunkSize
      )
      RuntimeTrace.event("preview.native_download.split_complete", [
        "fileId": fileId,
        "chunks": chunkPaths.count
      ])

      progress.emitProgress(stage: "decrypting", chunksCompleted: 0, chunksTotal: chunkPaths.count)
      RuntimeTrace.event("preview.native_download.decrypt_start", [
        "fileId": fileId,
        "chunks": chunkPaths.count
      ])
      let result = try master.decryptFile(
        fileId: fileId,
        chunkPaths: chunkPaths,
        outputPath: outputPath,
        callback: progress
      )
      progress.emitProgress(stage: "complete")
      RuntimeTrace.event("preview.native_download.decrypt_complete", [
        "fileId": fileId,
        "totalBytes": result.totalBytes,
        "chunksProcessed": result.chunksProcessed
      ])

      return [
        "outputPath": result.outputPath,
        "outputUri": URL(fileURLWithPath: result.outputPath).absoluteString,
        "plaintextSize": result.totalBytes,
        "chunksDecrypted": result.chunksProcessed,
      ]
    }

    AsyncFunction("cancelDownloadAndDecryptFileNative") { [self] (requestId: String) -> Bool in
      self.cancelPreviewDownload(requestId: requestId)
    }

    // ── Local thumbnail generation for video and RAW (DNG) files ────────
    //
    // generateVideoThumbnail: Uses AVAssetImageGenerator to extract a frame
    // from a local video file (MP4/MOV) and writes a WebP thumbnail to disk.
    //
    // generateDngThumbnail: Loads a DNG via UIImage (which uses CoreImage
    // under the hood to decode the embedded preview) and resizes to WebP.

    AsyncFunction("generateVideoThumbnail") { (localUri: String, maxSize: Int) throws -> String in
      let url = fileURL(fromURI: localUri)
      let asset = AVAsset(url: url)
      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: maxSize, height: maxSize)

      let time = CMTime(seconds: 1.0, preferredTimescale: 600)
      let cgImage: CGImage
      do {
        cgImage = try generator.copyCGImage(at: time, actualTime: nil)
      } catch {
        // Fall back to time 0 if time 1s is beyond duration
        cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
      }
      let image = UIImage(cgImage: cgImage)

      guard let webpData = ThumbnailGenerator.generate(from: image, config: .medium) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Failed to encode video thumbnail as WebP"]
        )
      }

      let outputPath = NSTemporaryDirectory() + "video-thumb-\(UUID().uuidString).webp"
      try webpData.write(to: URL(fileURLWithPath: outputPath))
      return outputPath
    }

    AsyncFunction("generateDngThumbnail") { (localUri: String, maxSize: Int) throws -> String in
      let url = fileURL(fromURI: localUri)

      guard let image = UIImage(contentsOfFile: url.path) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Failed to load DNG image"]
        )
      }

      guard let webpData = ThumbnailGenerator.generate(from: image, config: .medium) else {
        throw NSError(
          domain: "BeebeebThumbnail",
          code: 3,
          userInfo: [NSLocalizedDescriptionKey: "Failed to encode DNG thumbnail as WebP"]
        )
      }

      let outputPath = NSTemporaryDirectory() + "dng-thumb-\(UUID().uuidString).webp"
      try webpData.write(to: URL(fileURLWithPath: outputPath))
      return outputPath
    }

    // ── Native thumbnail pipeline ────────────────────────────────────────
    //
    // Downloads the full encrypted file via URLSession, decrypts to disk via
    // Rust, resizes with UIImage (no JS heap), encrypts the thumbnail WebP
    // as a single AES-256-GCM chunk, and uploads via PUT. Zero JS memory.

    AsyncFunction("generateAndUploadThumbnailNative") { [self] (
      handleId: Int, apiUrl: String, token: String,
      fileId: String, maxSize: Int
    ) async throws -> Bool in
      let masterKey = try self.getHandle(handleId)

      let tempDir = NSTemporaryDirectory() + "thumb-\(fileId)-\(UUID().uuidString)/"
      try FileManager.default.createDirectory(
        atPath: tempDir, withIntermediateDirectories: true
      )
      defer { try? FileManager.default.removeItem(atPath: tempDir) }

      // 1. Fetch file metadata to learn chunk_count and size_bytes
      let metaUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)")!
      var metaReq = URLRequest(url: metaUrl)
      metaReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (metaData, metaResp) = try await URLSession.shared.data(for: metaReq)
      guard let httpMeta = metaResp as? HTTPURLResponse, httpMeta.statusCode == 200 else {
        return false
      }
      guard let meta = try? JSONSerialization.jsonObject(with: metaData) as? [String: Any],
            let chunkCount = meta["chunk_count"] as? Int,
            let sizeBytes = meta["size_bytes"] as? Int,
            chunkCount > 0, sizeBytes > 0
      else { return false }

      // 2. Download the full encrypted blob to a temp file
      let downloadUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/download")!
      var dlReq = URLRequest(url: downloadUrl)
      dlReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (dlData, dlResp) = try await URLSession.shared.data(for: dlReq)
      guard let httpDl = dlResp as? HTTPURLResponse, httpDl.statusCode == 200 else {
        return false
      }
      guard dlData.count > 0 else { return false }

      // 3. Split the concatenated blob into individual chunk files
      //    Each encrypted chunk = nonce(12) + ciphertext(plaintext_chunk + 16 tag)
      //    so overhead per chunk = 28 bytes.
      let nonceLen = 12
      let tagLen = 16
      let chunkOverhead = nonceLen + tagLen
      let encryptedSize = dlData.count
      // Default plaintext chunk size = 4 MB (matches beebeeb-types plan_chunks)
      let defaultPlaintextChunkSize = 4 * 1024 * 1024
      // Infer chunk size from total: plaintext per chunk = (sizeBytes / chunkCount) rounded up
      let plaintextChunkSize: Int
      if chunkCount == 1 {
        plaintextChunkSize = sizeBytes
      } else {
        // Use header hint if available, else compute from total size
        let headerChunkSize = (httpDl.value(forHTTPHeaderField: "X-Chunk-Size")).flatMap { Int($0) }
        plaintextChunkSize = headerChunkSize ?? defaultPlaintextChunkSize
      }

      var chunkPaths: [String] = []
      var offset = 0
      for i in 0..<chunkCount {
        let isLastChunk = (i == chunkCount - 1)
        let thisPlaintextSize = isLastChunk
          ? sizeBytes - (plaintextChunkSize * (chunkCount - 1))
          : plaintextChunkSize
        let thisEncryptedSize = thisPlaintextSize + chunkOverhead
        guard offset + thisEncryptedSize <= encryptedSize else { return false }

        let chunkData = dlData[offset..<(offset + thisEncryptedSize)]
        let chunkPath = tempDir + "\(i).enc"
        try Data(chunkData).write(to: URL(fileURLWithPath: chunkPath))
        chunkPaths.append(chunkPath)
        offset += thisEncryptedSize
      }

      // 4. Decrypt via Rust to a temp file
      let decryptedPath = tempDir + "decrypted"
      let _ = try masterKey.decryptFile(
        fileId: fileId, chunkPaths: chunkPaths,
        outputPath: decryptedPath, callback: nil
      )

      // 5. Resize via Rust + encode WebP
      guard let image = UIImage(contentsOfFile: decryptedPath) else { return false }
      guard let webpData = ThumbnailGenerator.generate(from: image, config: .medium)
      else { return false }

      // 6. Encrypt thumbnail as a single AES-256-GCM chunk via Rust
      let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fileKey.encryptChunk(plaintext: webpData)

      // Wire format: nonce(12) || ciphertext — matches the web client
      var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
      wire.append(enc.nonce)
      wire.append(enc.ciphertext)
      guard wire.count <= ThumbnailGenerator.Config.medium.maxBytes + 28 else {
        return false
      }

      // 7. Upload encrypted thumbnail via PUT
      let thumbUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/thumbnail")!
      var thumbReq = URLRequest(url: thumbUrl)
      thumbReq.httpMethod = "PUT"
      thumbReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      thumbReq.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      thumbReq.httpBody = wire

      let (_, thumbResp) = try await URLSession.shared.data(for: thumbReq)
      guard let httpThumb = thumbResp as? HTTPURLResponse,
            httpThumb.statusCode >= 200, httpThumb.statusCode < 300
      else { return false }

      return true
    }

    AsyncFunction("generateAndUploadPhotoLibraryThumbnailNative") { [self] (
      handleId: Int, apiUrl: String, token: String,
      fileId: String, localIdentifier: String,
      mediaTypeHint: String?, maxSize: Int,
      variant: String?
    ) async throws -> Bool in
      let masterKey = try self.getHandle(handleId)
      let config = ThumbnailGenerator.config(for: variant)
      let variantLabel = variant ?? "medium"

      let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
      guard let phAsset else { return false }

      let thumbnailData: Data
      if phAsset.mediaType == .video || isVideoMediaHint(mediaTypeHint) {
        thumbnailData = try await generatePhotoLibraryVideoThumbnail(
          localIdentifier: localIdentifier,
          maxSize: maxSize,
          config: config
        )
      } else {
        thumbnailData = try await generatePhotoLibraryImageThumbnail(
          localIdentifier: localIdentifier,
          maxSize: maxSize,
          config: config
        )
      }

      let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
      let enc = try fileKey.encryptChunk(plaintext: thumbnailData)

      var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
      wire.append(enc.nonce)
      wire.append(enc.ciphertext)
      // maxBytes already accounts for encryption overhead (28 bytes)
      guard wire.count <= config.maxBytes + 28 else {
        NSLog("[BeebeebCrypto] Photo-library \(variantLabel) thumbnail skipped: encrypted payload too large (\(wire.count) bytes)")
        return false
      }

      let suffix = variantLabel == "medium" ? "" : "/\(variantLabel)"
      guard let thumbUrl = URL(string: "\(apiUrl)/api/v1/files/\(fileId)/thumbnail\(suffix)") else {
        return false
      }
      var request = URLRequest(url: thumbUrl)
      request.httpMethod = "PUT"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      request.httpBody = wire

      let (_, response) = try await URLSession.shared.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(statusCode) {
        NSLog("[BeebeebCrypto] Photo-library \(variantLabel) thumbnail uploaded")
        return true
      }
      NSLog("[BeebeebCrypto] Photo-library \(variantLabel) thumbnail upload HTTP \(statusCode)")
      return false
    }
  }
}
