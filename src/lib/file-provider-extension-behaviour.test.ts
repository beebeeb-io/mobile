// @ts-nocheck — compiles the shipped File Provider extension sources against in-memory doubles (macOS).
/**
 * Task 1722 (2026-10-14) — behavioural harness for the iOS File Provider extension.
 *
 * Compiles the REAL extension sources (FileProviderExtension, FileProviderItem,
 * FileProviderEnumerator, SyncEngine, CachedHandleIdentity, CryptoBridge) together with
 * in-memory doubles for the parts that need a device: the shared SQLite cache
 * (CacheManager), the network (ApiClient), the Secure Enclave keychain
 * (BeebeebKeychainCore.loadMasterKeyThrowing) and the Rust key handles (CryptoKit AES-GCM
 * fixtures, as in file-provider-content-codec.test.ts). Declarations the doubles must agree
 * with (CachedItem, the API DTOs and errors, LoadError) are extracted from the shipped files,
 * so a change to them reaches this harness instead of drifting from a re-typed copy.
 *
 * What the doubles cannot show: real Secure Enclave policy, fileproviderd behaviour, jetsam.
 * Those stay simulator/device rungs (task 1722 evidence).
 *
 * Imports no app module (fs + child_process only), so it needs no `mock.module` calls.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const EXT = join(ROOT, 'targets', 'file-provider');
const read = (path: string) => readFileSync(path, 'utf8');
const REQUIRE_NATIVE_SWIFT_HARNESSES = process.env.BB_REQUIRE_NATIVE_SWIFT_HARNESSES === '1';

function nativeSwiftHarnessTest(name: string, fn: () => void, timeout?: number): void {
  if (process.platform === 'darwin') {
    test(name, fn, timeout);
    return;
  }
  if (REQUIRE_NATIVE_SWIFT_HARNESSES) {
    test(name, () => {
      throw new Error('native Swift harnesses require macOS; run this in CI swift-gate');
    }, timeout);
    return;
  }
  test.skip(`${name} [macOS Swift harness; required in CI swift-gate]`, fn, timeout);
}

/** Brace-matched declaration starting at `signature` (signature through its closing brace). */
function declaration(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated declaration for ${signature}`);
}

function line(source: string, prefix: string): string {
  const found = source.split('\n').find((l) => l.startsWith(prefix));
  if (!found) throw new Error(`line not found: ${prefix}`);
  return found;
}

const apiClient = read(join(EXT, 'ApiClient.swift'));
const cacheManager = read(join(EXT, 'CacheManager.swift'));
const keychainCore = read(join(ROOT, 'modules', 'beebeeb-crypto', 'ios', 'Shared', 'BeebeebKeychainCore.swift'));

const doubles = String.raw`
import Foundation
import FileProvider
import CryptoKit

enum BeebeebConstants {
  static let rootContainerIdentifier = "io.beebeeb.root"
  static let trashContainerIdentifier = "io.beebeeb.trash"
  static let trashItemPrefix = "trash:"
  static let masterKeyLabel = "io.beebeeb.master-key"
  static let fileProviderDomainIdentifier = NSFileProviderDomainIdentifier("io.beebeeb.files.harness")
  static var fileProviderDomain: NSFileProviderDomain {
    NSFileProviderDomain(identifier: fileProviderDomainIdentifier, displayName: "Harness")
  }
}

enum PlaintextStorageProtection {
  static var protected: [String] = []
  @discardableResult static func protect(_ url: URL) -> Bool { protected.append(url.lastPathComponent); return true }
}

enum AppGroupContainer {
  static let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
  static func directory(_ name: String) -> URL {
    let url = root.appendingPathComponent(name, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
  static var temporaryContentDirectory: URL { directory("app-group-temp") }
  static var pinnedContentDirectory: URL { directory("app-group-pinned") }
}

// ---- File Provider manager: shadows the framework class for the extension sources ----
// Task 1722 review I1: makes a call to temporaryDirectoryURL() observable. On a simulator it
// resolved to <device>/data/tmp, outside every app container, where the sign-out purge cannot
// reach; the extension must write plaintext only into the registered App Group temp directory.
final class NSFileProviderManager {
  private static let lock = NSLock()
  private static var _temporaryDirectoryCalls = 0
  static var temporaryDirectoryCalls: Int { lock.lock(); defer { lock.unlock() }; return _temporaryDirectoryCalls }
  static var systemTemporaryDirectory: URL { AppGroupContainer.directory("system-temp") }
  // Task 1722 round 4: what the system reports as materialized, and every signal sent.
  private static var _materialized: [NSFileProviderItem] = []
  private static var _signals: [String] = []
  private static var _resolvedErrors: [Int] = []
  static var signalDelay: TimeInterval = 0
  static func setMaterialized(_ items: [NSFileProviderItem]) { lock.lock(); _materialized = items; lock.unlock() }
  static var signals: [String] { lock.lock(); defer { lock.unlock() }; return _signals }
  static var resolvedErrors: [Int] { lock.lock(); defer { lock.unlock() }; return _resolvedErrors }
  static func resetRecords() { lock.lock(); _materialized = []; _signals = []; _resolvedErrors = []; lock.unlock() }
  init?(for domain: NSFileProviderDomain) {}
  func temporaryDirectoryURL() throws -> URL {
    Self.lock.lock(); Self._temporaryDirectoryCalls += 1; Self.lock.unlock()
    return Self.systemTemporaryDirectory
  }
  func signalEnumerator(for container: NSFileProviderItemIdentifier, completionHandler: @escaping (Error?) -> Void) {
    Thread.sleep(forTimeInterval: Self.signalDelay)
    Self.lock.lock(); Self._signals.append(container.rawValue); Self.lock.unlock()
    completionHandler(nil)
  }
  func signalErrorResolved(_ error: NSError, completionHandler: @escaping (Error?) -> Void) {
    Self.lock.lock(); Self._resolvedErrors.append(error.code); Self.lock.unlock()
    completionHandler(nil)
  }
  func enumeratorForMaterializedItems() -> NSFileProviderEnumerator {
    Self.lock.lock(); defer { Self.lock.unlock() }
    return ScriptedEnumerator(items: Self._materialized)
  }
}

/// The system's materialized set enumerator: one page, delivered off the caller's thread.
final class ScriptedEnumerator: NSObject, NSFileProviderEnumerator {
  let items: [NSFileProviderItem]
  init(items: [NSFileProviderItem]) { self.items = items }
  func invalidate() {}
  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    DispatchQueue.global().async {
      observer.didEnumerate(self.items)
      observer.finishEnumerating(upTo: nil)
    }
  }
}

// ---- keychain: the Files key load is the only call the extension makes ----
enum BeebeebKeychainCore {
  enum LoadMode { case primaryOnly, extensionOnly, extensionThenPrimary, fileProviderOnly }
  __LOAD_ERROR__
  static let masterKeyOwnerKey = "owner"
  static let sessionUserIdKey = "user"
  static var strings: [String: String] = ["owner": "user-1", "user": "user-1"]
  static let goodKey = Data((0..<32).map { UInt8($0) })
  static var keyResult: Result<Data, Error> = .success(goodKey)
  static var keyLoads = 0
  static func loadString(key: String) -> String? { strings[key] }
  static func loadMasterKeyThrowing(label: String, mode: LoadMode) throws -> Data {
    precondition(mode == .fileProviderOnly, "Files must only ever load its own key")
    keyLoads += 1
    return try keyResult.get()
  }
}

// ---- Rust key handles: CryptoKit fixtures (no Rust derivation, no SE) ----
struct EncryptedData { let nonce: Data; let ciphertext: Data }
struct DecryptedNameWithMime { let name: String; let mimeType: String? }
struct FixtureCryptoError: Error {}

final class MasterKeyHandle {
  let key: Data
  init(key: Data) { self.key = key }
  /// SF-0002 part 1: every id string the extension hands to key derivation.
  static var derivedFileIds: [String] = []
  static func fromKeychainBytes(bytes: Data) throws -> MasterKeyHandle {
    guard bytes.count == 32 else { throw FixtureCryptoError() }
    return MasterKeyHandle(key: bytes)
  }
  func deriveFileKey(fileId: Data) throws -> FileKeyHandle {
    MasterKeyHandle.derivedFileIds.append(String(data: fileId, encoding: .utf8) ?? "<non-utf8-id>")
    return FileKeyHandle(key: Data(SHA256.hash(data: key + fileId)))
  }
  func encryptName(fileId: String, filename: String, mimeType: String?) throws -> String {
    let blob = try deriveFileKey(fileId: Data(fileId.utf8)).encryptMetadata(metadata: filename)
    let payload: [String: Any] = [
      "cipher_suite": "V1Aes256Gcm",
      "nonce": Array(blob.nonce),
      "ciphertext": Array(blob.ciphertext),
    ]
    return String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
  }
  // Forces CryptoBridge onto its JSON-envelope path, which encryptFilename produces.
  func decryptNameWithMime(fileId: String, nameEncrypted: String) throws -> DecryptedNameWithMime {
    throw FixtureCryptoError()
  }
}

final class FileKeyHandle {
  let key: SymmetricKey
  static var nonceCounter: UInt64 = 1
  init(key: Data) { self.key = SymmetricKey(data: key) }
  private func nonce() throws -> AES.GCM.Nonce {
    defer { Self.nonceCounter += 1 }
    var bytes = Data(count: 4)
    withUnsafeBytes(of: Self.nonceCounter.bigEndian) { bytes.append(contentsOf: $0) }
    return try AES.GCM.Nonce(data: bytes)
  }
  func encryptChunk(plaintext: Data) throws -> EncryptedData {
    let sealed = try AES.GCM.seal(plaintext, using: key, nonce: try nonce())
    return EncryptedData(nonce: Data(sealed.nonce), ciphertext: sealed.ciphertext + sealed.tag)
  }
  func decryptChunk(nonce: Data, ciphertext: Data) throws -> Data {
    guard ciphertext.count >= 16 else { throw FixtureCryptoError() }
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
    return try AES.GCM.open(box, using: key)
  }
  func encryptMetadata(metadata: String) throws -> EncryptedData { try encryptChunk(plaintext: Data(metadata.utf8)) }
  func decryptMetadata(nonce: Data, ciphertext: Data) throws -> String {
    guard let text = String(data: try decryptChunk(nonce: nonce, ciphertext: ciphertext), encoding: .utf8) else { throw FixtureCryptoError() }
    return text
  }
}

// ---- core chunk ladder: beebeeb-types plan_chunks (4 MiB floor, 32 chunks, "mobile" cap 32 MiB) ----
struct ChunkPlanResult { let chunkSizeBytes: UInt64; let chunkCount: UInt64 }
func planChunks(fileSizeBytes: UInt64, profile: String) throws -> ChunkPlanResult {
  precondition(profile == "mobile", "Files plans with the mobile profile")
  let mib: UInt64 = 1024 * 1024
  let target = max(1, (fileSizeBytes + 31) / 32)
  var size: UInt64 = 1
  while size < target { size <<= 1 }
  size = min(max(size, 4 * mib), 32 * mib)
  return ChunkPlanResult(chunkSizeBytes: size, chunkCount: max(1, (fileSizeBytes + size - 1) / size))
}

// ---- shared metadata cache: in-memory, records every write ----
__CACHED_ITEM__
__DISPLAY_NAMES__

final class CacheManager {
  static let shared = CacheManager()
  private let lock = NSLock()
  var rows: [String: CachedItem] = [:]
  var state: [String: String] = [:]
  var epoch = 7
  private(set) var writes: [String] = []
  /// Scenario hook: runs on the Nth purgeEpochUnchanged call (a purge or a cancel landing mid-stream).
  var onEpochCheck: (count: Int, action: () -> Void)?
  private(set) var epochChecks = 0
  private(set) var siblingAliasQueries = 0

  /// Task 1722 round 4: the folders the system has materialized (not counted in writes).
  var materialized: Set<String> = []

  func reset() {
    lock.lock(); defer { lock.unlock() }
    rows = [:]; state = [:]; epoch = 7; writes = []; onEpochCheck = nil; epochChecks = 0; siblingAliasQueries = 0; materialized = []
  }
  func materializedContainerIds() -> [String] { lock.lock(); defer { lock.unlock() }; return materialized.sorted() }
  @discardableResult
  func noteContainerMaterialized(_ containerId: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    materialized.insert(containerId)
    return true
  }
  func replaceMaterializedContainers(_ ids: Set<String>, expectedEpoch: Int) -> Bool? {
    lock.lock(); defer { lock.unlock() }
    guard expectedEpoch == epoch else { return nil }
    defer { materialized = ids }
    return materialized != ids
  }
  private func repairedChildren(parent: String?) -> [CachedItem] {
    siblingAliasQueries += 1
    let current = rows.values.filter { $0.parentId == parent }.sorted { $0.id < $1.id }
    let repaired = FileProviderDisplayNames.assign(current)
    for item in repaired { rows[item.id] = item }
    return repaired
  }
  func item(id: String) -> CachedItem? {
    lock.lock(); defer { lock.unlock() }
    guard let row = rows[id] else { return nil }
    if FileProviderDisplayNames.hasValidAlias(row) { return row }
    return repairedChildren(parent: row.parentId).first { $0.id == id }
  }
  func children(parent: String?) -> [CachedItem] {
    lock.lock(); defer { lock.unlock() }
    return repairedChildren(parent: parent)
  }
  @discardableResult
  func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int, pruningNamespacePrefix: String? = nil) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard expectedEpoch == epoch else { return false }
    writes.append("replaceChildren")
    for (id, row) in rows where row.parentId == parent && !items.contains(where: { $0.id == id }) { rows[id] = nil }
    for item in items { rows[item.id] = item }
    if let prefix = pruningNamespacePrefix, let parent {
      var reachable = Set(rows.values.filter { $0.parentId == parent }.map(\.id))
      var changed = true
      while changed {
        let before = reachable.count
        for row in rows.values where row.parentId.map(reachable.contains) == true { reachable.insert(row.id) }
        changed = reachable.count != before
      }
      for id in rows.keys where id.hasPrefix(prefix) && !reachable.contains(id) { rows[id] = nil }
    }
    return true
  }
  @discardableResult
  func upsert(_ item: CachedItem, expectedEpoch: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard expectedEpoch == epoch else { return false }
    writes.append("upsert")
    rows[item.id] = item
    return true
  }
  @discardableResult
  func delete(id: String, expectedEpoch: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard expectedEpoch == epoch else { return false }
    writes.append("delete")
    rows[id] = nil
    return true
  }
  func currentPurgeEpoch() -> Int { lock.lock(); defer { lock.unlock() }; return epoch }
  func purgeEpochUnchanged(since captured: Int) -> Bool {
    lock.lock()
    epochChecks += 1
    let hook = onEpochCheck?.count == epochChecks ? onEpochCheck?.action : nil
    lock.unlock()
    hook?()
    lock.lock(); defer { lock.unlock() }
    return captured == epoch
  }
  func setMaterialized(id: String, value: Bool) { lock.lock(); defer { lock.unlock() }; rows[id]?.isMaterialized = value }
  func setSyncState(key: String, value: String) { lock.lock(); defer { lock.unlock() }; state[key] = value }
  func syncState(key: String) -> String? { lock.lock(); defer { lock.unlock() }; return state[key] }
}

// ---- network: scripted responses, every call recorded ----
__API_ERROR__
__DOWNLOADED_FILE__
__DEFAULT_CHUNK_SIZE__

final class ApiClient {
  static let shared = ApiClient()
  __FILE_ENTRY_DTO__
  __FOLDER_CREATE_RESPONSE_DTO__
  __UPLOAD_RESPONSE_DTO__
  __UPLOAD_COMPLETE_RESPONSE_DTO__
  __UPLOAD_INIT_DTO__

  var listings: [String: Result<[FileEntryDto], Error>] = [:]
  var downloadResult: Result<DownloadedEncryptedFile, Error> = .failure(ApiError.invalidResponse)
  private let callsLock = NSLock()
  private var recordedCalls: [String] = []
  var calls: [String] { callsLock.lock(); defer { callsLock.unlock() }; return recordedCalls }
  private func record(_ call: String) { callsLock.lock(); recordedCalls.append(call); callsLock.unlock() }
  private(set) var patchedNames: [String?] = []
  private(set) var createdFolderNames: [String] = []
  private(set) var uploadInitNames: [String] = []
  private(set) var listLimits: [Int?] = []
  private(set) var listExpectedUsers: [String?] = []
  struct ListingReply {
    let delayNanoseconds: UInt64
    let result: Result<[FileEntryDto], Error>
  }
  private let listingRepliesLock = NSLock()
  private var listingReplies: [String: [ListingReply]] = [:]
  private var activeListings = 0
  private(set) var maximumConcurrentListings = 0
  /// SF-0002 part 1: the file_id the real ApiClient puts in the upload-init
  /// body (it sends fileId.lowercased(), ApiClient.swift).
  private(set) var uploadInitFileIds: [String] = []
  /// Scenario hook: each chunk PUT throws the next queued error, then succeeds.
  var chunkFailures: [Error] = []
  var initFailures: [Error] = []
  var completeFailures: [Error] = []
  private(set) var serverFileRows = Set<String>()
  private var activeUploadFileIds = Set<String>()
  private var uploadSessionSequence = 0
  /// SF-0001 round 2: the init answer names this id instead of the requested one.
  var initEchoOverride: String?
  var completeReplyData: Data?
  var completeAsIdempotentRetry = false
  var deleteFailure: Error?

  func reset() { listings = [:]; downloadResult = .failure(ApiError.invalidResponse); callsLock.lock(); recordedCalls = []; callsLock.unlock(); patchedNames = []; createdFolderNames = []; uploadInitNames = []; listLimits = []; listExpectedUsers = []; listingRepliesLock.lock(); listingReplies = [:]; activeListings = 0; maximumConcurrentListings = 0; listingRepliesLock.unlock(); createdFolderIds = []; createFolderFailure = nil; failCreateAfterServerWrite = false; folderEchoOverride = nil; uploadInitFileIds = []; chunkFailures = []; initFailures = []; completeFailures = []; serverFileRows = []; activeUploadFileIds = []; uploadSessionSequence = 0; initEchoOverride = nil; completeReplyData = nil; completeAsIdempotentRetry = false; deleteFailure = nil; chunkTimeoutsLock.lock(); recordedChunkTimeouts = []; chunkTimeoutsLock.unlock() }
  func count(_ prefix: String) -> Int { calls.filter { $0.hasPrefix(prefix) }.count }
  func scriptListings(_ key: String, _ replies: [ListingReply]) {
    listingRepliesLock.lock(); listingReplies[key] = replies; listingRepliesLock.unlock()
  }

  func listFiles(parentId: String?, trashed: Bool = false, maxEntries: Int? = nil, expectedUser: String? = nil) async throws -> [FileEntryDto] {
    record("\(trashed ? "list-trashed" : "list") \(parentId ?? "root")")
    listLimits.append(maxEntries)
    listExpectedUsers.append(expectedUser)
    let key = (trashed ? "trashed:" : "") + (parentId ?? "root")
    listingRepliesLock.lock()
    let scripted = listingReplies[key]?.isEmpty == false ? listingReplies[key]?.removeFirst() : nil
    activeListings += 1
    maximumConcurrentListings = max(maximumConcurrentListings, activeListings)
    listingRepliesLock.unlock()
    defer {
      listingRepliesLock.lock()
      activeListings -= 1
      listingRepliesLock.unlock()
    }
    if let delay = scripted?.delayNanoseconds, delay > 0 { try? await Task.sleep(nanoseconds: delay) }
    let rows = try (scripted?.result ?? listings[key] ?? .success([])).get()
    return maxEntries.map { Array(rows.prefix($0)) } ?? rows
  }
  func downloadEncrypted(fileId: String) async throws -> DownloadedEncryptedFile {
    record("download \(fileId)")
    return try downloadResult.get()
  }
  func patchFile(fileId: String, nameEncrypted: String? = nil, parentId: String? = nil, expectedUser: String?) async throws -> FileEntryDto {
    record("patch \(fileId) parent=\(parentId ?? "root")")
    patchedNames.append(nameEncrypted)
    return FileEntryDto(id: fileId, parent_id: parentId, name_encrypted: nameEncrypted, name_nonce: nil, mime_type: nil,
                        size_bytes: 0, is_folder: false, chunk_count: 1, created_at: nil, updated_at: "2026-10-14T00:00:00Z")
  }
  func deleteFile(fileId: String, expectedUser: String?) async throws {
    record("delete \(fileId)")
    if let deleteFailure { throw deleteFailure }
  }
  private(set) var createdFolderIds: [String] = []
  var createFolderFailure: Error?
  var failCreateAfterServerWrite = false
  var folderEchoOverride: String?
  func createFolder(folderId: String, nameEncrypted: String, parentId: String?, expectedUser: String?) async throws -> FolderCreateResponseDto {
    record("create-folder \(folderId) parent=\(parentId ?? "root")")
    createdFolderIds.append(folderId)
    createdFolderNames.append(nameEncrypted)
    let listingKey = parentId ?? "root"
    var rows = try (listings[listingKey] ?? .success([])).get()
    rows.append(FileEntryDto(id: folderId, parent_id: parentId, name_encrypted: nameEncrypted, name_nonce: nil, mime_type: nil,
                             size_bytes: 0, is_folder: true, chunk_count: 0, created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z"))
    listings[listingKey] = .success(rows)
    if failCreateAfterServerWrite {
      failCreateAfterServerWrite = false
      throw createFolderFailure ?? URLError(.networkConnectionLost)
    }
    if let createFolderFailure { throw createFolderFailure }
    let escapedName = nameEncrypted.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    let echoedId = folderEchoOverride ?? folderId
    let data = Data("{\"id\":\"\(echoedId)\",\"name_encrypted\":\"\(escapedName)\",\"is_folder\":true,\"created_at\":\"2026-10-14T00:00:00Z\"}".utf8)
    return try FolderCreateResponseDto.decode(data)
  }
  func initUploadV2(fileId: String, nameEncrypted: String, fileSizeBytes: Int64, mimeType: String?, parentId: String?,
                    isMedia: Bool, chunkSizeBytes: Int, chunkCount: Int, isReplacement: Bool, expectedUser: String?) async throws -> UploadV2InitResponse {
    record("upload-init \(fileId)")
    if !initFailures.isEmpty { throw initFailures.removeFirst() }
    if activeUploadFileIds.contains(fileId) { throw ApiError.retryableConflict }
    // Mirror the shipped ApiClient: the server body's file_id is the
    // lowercased argument, and the completion row carries the server id.
    uploadInitFileIds.append(fileId.lowercased())
    serverFileRows.insert(fileId)
    activeUploadFileIds.insert(fileId)
    uploadInitNames.append(nameEncrypted)
    uploadSessionSequence += 1
    return UploadV2InitResponse(file_id: initEchoOverride ?? fileId.lowercased(), upload_session_id: "session-\(uploadSessionSequence)", chunk_size_bytes: chunkSizeBytes, chunk_count: chunkCount)
  }
  func abandonUploadBestEffort(fileId: String, expectedUser: String?) async {
    record("upload-abandon \(fileId)")
    activeUploadFileIds.remove(fileId)
    serverFileRows.remove(fileId)
  }
  func abandonUploadForRestart(fileId: String, expectedUser: String?) async throws {
    record("upload-abandon-for-restart \(fileId)")
    activeUploadFileIds.remove(fileId)
    serverFileRows.remove(fileId)
  }
  /// Task 260 (P2-3): every chunk attempt names its OWN request timeout, so the
  /// extension never inherits the session's 60 s one. Recorded for the budget checks.
  private let chunkTimeoutsLock = NSLock()
  private var recordedChunkTimeouts: [TimeInterval] = []
  var chunkTimeouts: [TimeInterval] { chunkTimeoutsLock.lock(); defer { chunkTimeoutsLock.unlock() }; return recordedChunkTimeouts }
  func uploadChunkV2(uploadSessionId: String, index: Int, encryptedChunk: Data, expectedUser: String?, timeout: TimeInterval) async throws {
    record("upload-chunk \(index)")
    chunkTimeoutsLock.lock(); recordedChunkTimeouts.append(timeout); chunkTimeoutsLock.unlock()
    if !chunkFailures.isEmpty { throw chunkFailures.removeFirst() }
  }
  func completeUploadV2(uploadSessionId: String, expectedUser: String?) async throws -> UploadCompleteResponseDto {
    record("upload-complete")
    if !completeFailures.isEmpty { throw completeFailures.removeFirst() }
    let id = uploadInitFileIds.last ?? "uploaded"
    activeUploadFileIds.remove(id)
    let fallback = completeAsIdempotentRetry
      ? Data("{\"id\":\"\(id)\",\"status\":\"completed\",\"already_completed\":true}".utf8)
      : Data("{\"id\":\"\(id)\",\"name_encrypted\":null,\"size_bytes\":0,\"chunk_count\":1}".utf8)
    return try UploadCompleteResponseDto.decode(completeReplyData ?? fallback)
  }
}
`
  .replace('__LOAD_ERROR__', declaration(keychainCore, 'enum LoadError: Error {'))
  .replace('__CACHED_ITEM__', declaration(cacheManager, 'struct CachedItem {'))
  .replace('__DISPLAY_NAMES__', declaration(cacheManager, 'enum FileProviderDisplayNames {'))
  .replace('__API_ERROR__', declaration(apiClient, 'enum ApiError: Error {'))
  .replace('__DOWNLOADED_FILE__', declaration(apiClient, 'struct DownloadedEncryptedFile {'))
  .replace('__DEFAULT_CHUNK_SIZE__', line(apiClient, 'let defaultPlaintextChunkSize'))
  .replace('__FILE_ENTRY_DTO__', declaration(apiClient, 'struct FileEntryDto: Decodable {'))
  .replace('__FOLDER_CREATE_RESPONSE_DTO__', declaration(apiClient, 'struct FolderCreateResponseDto: Decodable {'))
  .replace('__UPLOAD_RESPONSE_DTO__', declaration(apiClient, 'struct UploadResponseDto: Decodable {'))
  .replace('__UPLOAD_COMPLETE_RESPONSE_DTO__', declaration(apiClient, 'struct UploadCompleteResponseDto: Decodable {'))
  .replace('__UPLOAD_INIT_DTO__', declaration(apiClient, 'struct UploadV2InitResponse: Decodable {'));

const scenarios = String.raw`
import Foundation
import FileProvider
import UniformTypeIdentifiers

var passed = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  if !condition() {
    print("FAIL: \(label)")
    fflush(stdout)
    exit(1)
  }
  passed += 1
}

func describe(_ error: NSError?) -> String { error.map { "\($0.domain) \($0.code)" } ?? "nil" }
func isProviderError(_ error: NSError?, _ code: NSFileProviderError.Code) -> Bool {
  error?.domain == NSFileProviderErrorDomain && error?.code == code.rawValue
}

func row(_ id: String, parent: String? = nil, name: String? = nil, encrypted: String? = nil, folder: Bool = false, size: Int = 0,
         mime: String? = "text/plain") -> CachedItem {
  CachedItem(id: id, parentId: parent, nameEncrypted: encrypted, nameDecrypted: name, mimeType: folder ? nil : mime,
             sizeBytes: size, isFolder: folder, isPinned: false, hasThumbnail: false, thumbnailData: nil, thumbnailNonce: nil,
             createdAt: nil, updatedAt: "2026-10-14T00:00:00Z", syncAnchor: 1, isMaterialized: false)
}

/// What the app's native write-through used to do before aliases carried provenance: replace the real server name
/// and/or parent while leaving the File Provider-only alias untouched.
func appWriteThrough(_ id: String, parent: String?, name: String) {
  let old = CacheManager.shared.rows[id]!
  CacheManager.shared.rows[id] = CachedItem(
    id: old.id,
    parentId: parent,
    nameEncrypted: encryptedName(id, name),
    nameDecrypted: name,
    mimeType: old.mimeType,
    sizeBytes: old.sizeBytes,
    isFolder: old.isFolder,
    isPinned: old.isPinned,
    hasThumbnail: old.hasThumbnail,
    thumbnailData: old.thumbnailData,
    thumbnailNonce: old.thumbnailNonce,
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
    syncAnchor: old.syncAnchor + 1,
    isMaterialized: old.isMaterialized,
    displayName: old.displayName,
    displayNameSourceName: old.displayNameSourceName,
    displayNameSourceParent: old.displayNameSourceParent
  )
}

func reset() {
  CacheManager.shared.reset()
  ApiClient.shared.reset()
  MasterKeyHandle.derivedFileIds = []
  BeebeebKeychainCore.strings = ["owner": "user-1", "user": "user-1"]
  BeebeebKeychainCore.keyResult = .success(BeebeebKeychainCore.goodKey)
  BeebeebKeychainCore.keyLoads = 0
}

func fetch(_ id: String) async -> (URL?, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    _ = ext.fetchContents(for: NSFileProviderItemIdentifier(id), version: nil, request: NSFileProviderRequest()) { url, _, error in
      continuation.resume(returning: (url, error as NSError?))
    }
  }
}

// (c) Every way the Files key can be unavailable is "Authentication Required" (-1000),
// which Files retries after signalErrorResolved. -2005 is a dead end.
func keyFailuresAreAuthenticationRequired() async {
  let failures: [(String, Error)] = [
    ("LoadError.notFound", BeebeebKeychainCore.LoadError.notFound),
    ("LoadError.seKeyNotFound", BeebeebKeychainCore.LoadError.seKeyNotFound),
    ("LoadError.decryptFailed", BeebeebKeychainCore.LoadError.decryptFailed),
    ("LoadError.readFailed(-25308)", BeebeebKeychainCore.LoadError.readFailed(-25308)),
    ("OSStatus -25308 (device locked)", NSError(domain: NSOSStatusErrorDomain, code: -25308)),
    ("LoadError.fileProviderKeyUnavailable", BeebeebKeychainCore.LoadError.fileProviderKeyUnavailable(step: "unwrap", domain: NSOSStatusErrorDomain, code: -25308)),
  ]
  for (label, failure) in failures {
    reset()
    CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
    BeebeebKeychainCore.keyResult = .failure(failure)
    let (url, error) = await fetch("f1")
    check(url == nil, "\(label): no content URL")
    check(isProviderError(error, .notAuthenticated), "\(label): expected NSFileProviderErrorDomain -1000, got \(describe(error))")
    check(ApiClient.shared.count("download") == 0, "\(label): nothing downloaded without a key")
  }

  reset()
  CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
  BeebeebKeychainCore.keyResult = .success(Data(repeating: 7, count: 3))
  let (_, badBytes) = await fetch("f1")
  check(isProviderError(badBytes, .notAuthenticated), "unusable key bytes: expected -1000, got \(describe(badBytes))")

  reset()
  CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
  BeebeebKeychainCore.strings["user"] = "user-2"
  let (_, foreign) = await fetch("f1")
  check(isProviderError(foreign, .notAuthenticated), "owner not proven: expected -1000, got \(describe(foreign))")
  check(BeebeebKeychainCore.keyLoads == 0, "owner not proven: the key is never loaded")
}

// Errors that are not about the key keep their existing meaning.
func otherFailuresKeepTheirMeaning() async {
  reset()
  CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
  ApiClient.shared.downloadResult = .failure(ApiError.statusCode(503))
  let (_, server) = await fetch("f1")
  check(isProviderError(server, .serverUnreachable), "HTTP 503: expected -1004, got \(describe(server))")

  reset()
  CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
  ApiClient.shared.downloadResult = .failure(ApiError.notAuthenticated)
  let (_, session) = await fetch("f1")
  check(isProviderError(session, .notAuthenticated), "HTTP 401: expected -1000, got \(describe(session))")

  reset()
  let (_, missing) = await fetch("not-in-cache")
  check(isProviderError(missing, .noSuchItem), "unknown item: expected -1005, got \(describe(missing))")
}

// ---- (d) listings never vend placeholder names ----
final class ListingObserver: NSObject, NSFileProviderEnumerationObserver {
  private let lock = NSLock()
  private let done = DispatchSemaphore(value: 0)
  private var collected: [NSFileProviderItem] = []
  private var failure: NSError?
  var items: [NSFileProviderItem] { lock.lock(); defer { lock.unlock() }; return collected }
  var error: NSError? { lock.lock(); defer { lock.unlock() }; return failure }
  func didEnumerate(_ updatedItems: [NSFileProviderItem]) { lock.lock(); collected += updatedItems; lock.unlock() }
  func finishEnumerating(upTo nextPage: NSFileProviderPage?) { done.signal() }
  func finishEnumeratingWithError(_ error: Error) { lock.lock(); failure = error as NSError; lock.unlock(); done.signal() }
  func wait() -> Bool { done.wait(timeout: .now() + 10) == .success }
}

func list(_ container: String) async -> ListingObserver {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  let observer = ListingObserver()
  guard let enumerator = try? ext.enumerator(for: NSFileProviderItemIdentifier(container), request: NSFileProviderRequest()) else {
    check(false, "enumerator(for: \(container)) threw")
    return observer
  }
  enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
  let finished = await withCheckedContinuation { continuation in
    DispatchQueue.global().async { continuation.resume(returning: observer.wait()) }
  }
  check(finished, "listing of \(container) finished")
  enumerator.invalidate()
  return observer
}

let fixtureMaster = try! MasterKeyHandle.fromKeychainBytes(bytes: BeebeebKeychainCore.goodKey)
func encryptedName(_ id: String, _ name: String) -> String {
  try! CryptoBridge.encryptFilename(masterKeyHandle: fixtureMaster, fileId: id, filename: "{\"name\":\"\(name)\"}")
}
func legacyEncryptedName(_ id: String, _ name: String) -> String {
  let key = try! fixtureMaster.deriveFileKey(fileId: Data(id.utf8))
  let blob = try! key.encryptMetadata(metadata: name)
  let payload = [
    "nonce": blob.nonce.base64EncodedString(),
    "ciphertext": blob.ciphertext.base64EncodedString(),
  ]
  return String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
}
func serverAcceptsNamePayload(_ raw: String?) -> Bool {
  guard let raw, let data = raw.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data),
        let payload = object as? [String: Any],
        payload["cipher_suite"] as? String == "V1Aes256Gcm",
        let nonce = payload["nonce"] as? [Any], nonce.count == 12,
        let ciphertext = payload["ciphertext"] as? [Any] else { return false }
  func bytes(_ values: [Any]) -> Bool {
    values.allSatisfy { value in
      guard let number = value as? NSNumber else { return false }
      let int = number.intValue
      return int >= 0 && int <= 255 && number.doubleValue == Double(int)
    }
  }
  return bytes(nonce) && bytes(ciphertext)
}
/// A well-formed envelope this account's key cannot open.
let undecryptable = #"{"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#

func dto(_ id: String, parent: String?, name: String?, folder: Bool = false, created: String? = nil) -> ApiClient.FileEntryDto {
  ApiClient.FileEntryDto(id: id, parent_id: parent, name_encrypted: name, name_nonce: nil, mime_type: folder ? nil : "text/plain",
                         size_bytes: folder ? 0 : 5, is_folder: folder, chunk_count: 1, created_at: created, updated_at: "2026-10-14T00:00:00Z")
}

func noKeyRefusesListingInsteadOfPlaceholders() async {
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  ApiClient.shared.listings["F"] = .success([
    dto("c1", parent: "F", name: encryptedName("c1", "Taxes"), folder: true),
    dto("c2", parent: "F", name: encryptedName("c2", "Photos"), folder: true),
    dto("c3", parent: "F", name: encryptedName("c3", "notes.txt")),
  ])
  let observer = await list("F")
  check(isProviderError(observer.error, .notAuthenticated), "no key: listing ends with -1000, got \(describe(observer.error))")
  check(observer.items.isEmpty, "no key: 0 items vended, got \(observer.items.map(\.filename))")
  check(CacheManager.shared.writes.isEmpty, "no key: nothing written to the cache, got \(CacheManager.shared.writes)")
  check(CacheManager.shared.syncState(key: "container.F.anchor") == nil, "no key: the folder is not marked as listed")
}

func noKeyStillRefreshesKnownNames() async {
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  CacheManager.shared.rows["k1"] = row("k1", parent: "G", name: "Budget.xlsx", encrypted: encryptedName("k1", "Budget.xlsx"))
  ApiClient.shared.listings["G"] = .success([
    dto("k1", parent: "G", name: encryptedName("k1", "Budget.xlsx")),
    dto("k2", parent: "G", name: "legacy-plain.txt"),
  ])
  let outcome = await SyncEngine.refreshContainer(containerId: "G")
  check(outcome == .success, "no key, all names known: refresh succeeds, got \(outcome)")
  check(CacheManager.shared.item(id: "k1").map { FileProviderItem(cached: $0).filename } == "Budget.xlsx", "app-decrypted name kept")
  check(CacheManager.shared.item(id: "k2").map { FileProviderItem(cached: $0).filename } == "legacy-plain.txt", "legacy plaintext name kept")
}

// Task 1722 review M2-A: one name the key must open is enough to refuse the whole listing, even
// when its siblings are already known. A folder that is only partly decryptable without the key
// must not be written with placeholder rows for the rest.
func noKeyRefusesAMixedFolder() async {
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  CacheManager.shared.rows["k1"] = row("k1", parent: "M", name: "Budget.xlsx", encrypted: encryptedName("k1", "Budget.xlsx"))
  ApiClient.shared.listings["M"] = .success([
    dto("k1", parent: "M", name: encryptedName("k1", "Budget.xlsx")),
    dto("k2", parent: "M", name: "legacy-plain.txt"),
    dto("n1", parent: "M", name: encryptedName("n1", "Taxes 2026.pdf")),
  ])
  let outcome = await SyncEngine.refreshContainer(containerId: "M")
  check(outcome == .notAuthenticated, "no key, one name needs the key: refresh refused, got \(outcome)")
  check(CacheManager.shared.writes.isEmpty, "no key, mixed folder: nothing written, got \(CacheManager.shared.writes)")
  check(CacheManager.shared.item(id: "n1") == nil, "no key, mixed folder: no placeholder row for the undecrypted name")

  // Review round 2, item 3 (mutation C): the upgrade from TestFlight 236, which cached rows with
  // no decrypted name (Files showed "Open Beebeeb to Decrypt N"). Such a row is not a known name:
  // without the key the listing is refused, not written again with "Encrypted item" labels.
  for (label, cachedName) in [("no", nil), ("an empty", "")] as [(String, String?)] {
    reset()
    BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
    CacheManager.shared.rows["t1"] = row("t1", parent: "U", name: cachedName, encrypted: encryptedName("t1", "Taxes"), folder: true)
    ApiClient.shared.listings["U"] = .success([dto("t1", parent: "U", name: encryptedName("t1", "Taxes"), folder: true)])
    let upgraded = await SyncEngine.refreshContainer(containerId: "U")
    check(upgraded == .notAuthenticated, "no key, a TF 236 row cached with \(label) name: refresh refused, got \(upgraded)")
    check(CacheManager.shared.writes.isEmpty, "no key, a TF 236 row cached with \(label) name: nothing written, got \(CacheManager.shared.writes)")
  }
}

func undecryptableNameGetsUniqueLabelWithoutRename() async {
  reset()
  ApiClient.shared.listings["H"] = .success([
    dto("aaaaaaaa-1111-4000-8000-000000000001", parent: "H", name: undecryptable, folder: true),
    dto("bbbbbbbb-2222-4000-8000-000000000002", parent: "H", name: undecryptable, folder: true),
    dto("cccccccc-3333-4000-8000-000000000003", parent: "H", name: undecryptable),
    dto("r1", parent: "H", name: encryptedName("r1", "readable.txt")),
  ])
  let observer = await list("H")
  check(observer.error == nil, "key available: listing succeeds, got \(describe(observer.error))")
  let names = observer.items.map(\.filename).sorted()
  check(names.count == 4, "4 items listed, got \(names)")
  check(Set(names).count == names.count, "sibling names are unique (no Folder 2 / Folder 3 bounce), got \(names)")
  check(names.contains("readable.txt"), "readable name decrypted, got \(names)")
  for prefix in ["aaaaaaaa", "bbbbbbbb", "cccccccc"] {
    check(names.contains("Encrypted item \u{00B7} \(prefix)"), "undecryptable item labelled by id, got \(names)")
  }
  for item in observer.items {
    let canRename = (item.capabilities ?? []).contains(.allowsRenaming)
    check(canRename == (item.filename == "readable.txt"), "\(item.filename): renaming allowed only for a decrypted name")
  }
}

// The API permits same-name siblings, while File Provider requires every child
// of a directory to have a distinct filename. The displayed aliases are stable across server
// reorder/removal, and the real decrypted name remains the one used for server writes.
func duplicateSiblingNamesGetStableDisplayAliases() async {
  reset()
  let rows = [
    dto("c", parent: "D", name: encryptedName("c", "report.txt"), created: "2026-03-03T00:00:00Z"),
    dto("a", parent: "D", name: encryptedName("a", "report.txt"), created: "2026-03-01T00:00:00Z"),
    dto("b", parent: "D", name: encryptedName("b", "report.txt"), created: "2026-03-02T00:00:00Z"),
  ]
  ApiClient.shared.listings["D"] = .success(rows)
  let first = await list("D")
  let firstById = Dictionary(uniqueKeysWithValues: first.items.map { ($0.itemIdentifier.rawValue, $0.filename) })
  check(first.error == nil && Set(firstById.values).count == 3,
        "normal-folder duplicate names are made unique, got \(firstById)")
  check(firstById == ["a": "report.txt", "b": "report (2).txt", "c": "report (3).txt"],
        "aliases follow stable created-at/id order, got \(firstById)")
  check(["a", "b", "c"].allSatisfy { CacheManager.shared.item(id: $0)?.nameDecrypted == "report.txt" },
        "display aliases never replace the real cached server name")

  ApiClient.shared.listings["D"] = .success([rows[1], rows[2], rows[0]])
  _ = await SyncEngine.refreshContainer(containerId: "D")
  let reorderedById = Dictionary(uniqueKeysWithValues: CacheManager.shared.children(parent: "D").map {
    ($0.id, FileProviderItem(cached: $0).filename)
  })
  check(reorderedById == firstById, "aliases survive server reorder, got \(reorderedById)")

  ApiClient.shared.listings["D"] = .success([rows[1], rows[2]])
  _ = await SyncEngine.refreshContainer(containerId: "D")
  let removedById = Dictionary(uniqueKeysWithValues: CacheManager.shared.children(parent: "D").map {
    ($0.id, FileProviderItem(cached: $0).filename)
  })
  check(removedById == ["a": "report.txt", "b": "report (2).txt"],
        "removing a sibling does not rename the survivors, got \(removedById)")

  let version = FileProviderItem(cached: CacheManager.shared.item(id: "a")!).itemVersion.metadataVersion
  check(String(data: version, encoding: .utf8)?.contains("display-name-v2") == true,
        "even the unsuffixed sibling carries the display-name version marker")

  reset()
  CacheManager.shared.setSyncState(key: FileProviderItem.protectedBackupsRootKey, value: "backups-root")
  ApiClient.shared.listings["trashed:root"] = .success([
    dto("d2", parent: nil, name: encryptedName("d2", ".device.json"), created: "2026-03-02T00:00:00Z"),
    dto("d1", parent: nil, name: encryptedName("d1", ".device.json"), created: "2026-03-01T00:00:00Z"),
  ])
  let trash = await list(trashId)
  check(Set(trash.items.map(\.filename)) == [".device.json", ".device (2).json"],
        "Trash duplicate dotfiles are unique, got \(trash.items.map(\.filename))")
}

// Aliases are valid only for the real name and parent from which they were
// derived. The app can update the shared cache before the extension's next server refresh, so
// cache-only enumeration must also repair new or invalid aliases.
func appWritesCannotLeaveStaleOrCollidingAliases() async {
  reset()
  var stable = row("stable", parent: "D", name: "photo.jpg", encrypted: encryptedName("stable", "photo.jpg"))
  stable.displayName = "photo.jpg"
  stable.displayNameSourceName = "photo.jpg"
  stable.displayNameSourceParent = "D"
  CacheManager.shared.rows["stable"] = stable
  CacheManager.shared.rows["other"] = row("other", parent: "D", name: "other.jpg", encrypted: encryptedName("other", "other.jpg"))
  let queriesBefore = CacheManager.shared.siblingAliasQueries
  check(CacheManager.shared.item(id: "stable")?.displayName == "photo.jpg",
        "a valid alias is returned directly")
  check(CacheManager.shared.siblingAliasQueries == queriesBefore,
        "a valid item lookup does not read or resolve its siblings")

  reset()
  ApiClient.shared.listings["D"] = .success([
    dto("rename", parent: "D", name: encryptedName("rename", "a.txt"), created: "2026-03-01T00:00:00Z"),
  ])
  _ = await SyncEngine.refreshContainer(containerId: "D")
  appWriteThrough("rename", parent: "D", name: "b.txt")
  ApiClient.shared.listings["D"] = .success([
    dto("rename", parent: "D", name: encryptedName("rename", "b.txt"), created: "2026-03-01T00:00:00Z"),
  ])
  _ = await SyncEngine.refreshContainer(containerId: "D")
  check(FileProviderItem(cached: CacheManager.shared.item(id: "rename")!).filename == "b.txt",
        "an app rename followed by refresh cannot preserve the old alias")

  reset()
  ApiClient.shared.listings["P"] = .success([
    dto("stay", parent: "P", name: encryptedName("stay", "report.txt"), created: "2026-03-01T00:00:00Z"),
    dto("move", parent: "P", name: encryptedName("move", "report.txt"), created: "2026-03-02T00:00:00Z"),
  ])
  _ = await SyncEngine.refreshContainer(containerId: "P")
  check(CacheManager.shared.item(id: "move")?.displayName == "report (2).txt", "setup: the moved row starts with an old-parent alias")
  appWriteThrough("move", parent: "Q", name: "report.txt")
  ApiClient.shared.listings["Q"] = .success([
    dto("move", parent: "Q", name: encryptedName("move", "report.txt"), created: "2026-03-02T00:00:00Z"),
  ])
  _ = await SyncEngine.refreshContainer(containerId: "Q")
  check(FileProviderItem(cached: CacheManager.shared.item(id: "move")!).filename == "report.txt",
        "an app move followed by refresh cannot preserve an alias from the old parent")

  reset()
  CacheManager.shared.rows["first"] = row("first", parent: "D", name: "report.txt", encrypted: encryptedName("first", "report.txt"))
  CacheManager.shared.rows["app-new"] = row("app-new", parent: "D", name: "report.txt", encrypted: encryptedName("app-new", "report.txt"))
  let appWritten = CacheManager.shared.item(id: "app-new")
  check(appWritten?.displayName != CacheManager.shared.item(id: "first")?.displayName,
        "an app-written duplicate is unique through item(id:), got \(String(describing: appWritten?.displayName))")
  let cacheOnly = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("D"), cache: CacheManager.shared, refresher: NoRefresh())
  let cacheOnlyNames = await enumerateOnce(cacheOnly).items.map(\.filename)
  check(cacheOnlyNames.count == 2 && Set(cacheOnlyNames).count == 2,
        "an app-written duplicate is unique on cache-only enumeration, got \(cacheOnlyNames)")

  reset()
  CacheManager.shared.rows["a"] = row("a", parent: "D", name: "report.txt", encrypted: encryptedName("a", "report.txt"))
  CacheManager.shared.rows["b"] = row("b", parent: "D", name: "draft.txt", encrypted: encryptedName("b", "draft.txt"))
  let renameOutcome = await modify(Template("b", parent: "D", filename: "report.txt"), [.filename])
  let afterRename = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("D"), cache: CacheManager.shared, refresher: NoRefresh())
  let renamedItems = await enumerateOnce(afterRename).items
  let renamedNames = renamedItems.map(\.filename)
  check(renameOutcome.1 == nil && renamedNames.count == 2 && Set(renamedNames).count == 2,
        "the extension's own rename cannot store a typed name that collides with a sibling alias, got \(renamedNames)")
  check(CacheManager.shared.item(id: "b")?.nameDecrypted == "report.txt"
          && CacheManager.shared.item(id: "b")?.displayName == "report (2).txt",
        "the typed server name stays real while only its display alias is disambiguated")
}

final class Template: NSObject, NSFileProviderItem {
  let itemIdentifier: NSFileProviderItemIdentifier
  let parentItemIdentifier: NSFileProviderItemIdentifier
  let filename: String
  var contentType: UTType { .data }
  init(_ id: String, parent: String, filename: String) {
    itemIdentifier = NSFileProviderItemIdentifier(id)
    parentItemIdentifier = NSFileProviderItemIdentifier(parent)
    self.filename = filename
  }
}

/// modifyItem's completion: the returned item, the fields left still pending, whether Files
/// should refetch content, and the error.
func modifyOutcome(_ template: NSFileProviderItem, _ fields: NSFileProviderItemFields, contents: URL? = nil) async -> (NSFileProviderItem?, NSFileProviderItemFields, Bool, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    _ = ext.modifyItem(template, baseVersion: NSFileProviderItemVersion(contentVersion: Data(), metadataVersion: Data()),
                       changedFields: fields, contents: contents, options: [], request: NSFileProviderRequest()) { item, pending, shouldFetch, error in
      continuation.resume(returning: (item, pending, shouldFetch, error as NSError?))
    }
  }
}

func modifyReturningPending(_ template: NSFileProviderItem, _ fields: NSFileProviderItemFields, contents: URL? = nil) async -> (NSFileProviderItem?, NSFileProviderItemFields, NSError?) {
  let (item, pending, _, error) = await modifyOutcome(template, fields, contents: contents)
  return (item, pending, error)
}

func modify(_ template: NSFileProviderItem, _ fields: NSFileProviderItemFields) async -> (NSFileProviderItem?, NSError?) {
  let (item, _, error) = await modifyReturningPending(template, fields)
  return (item, error)
}

func renameOfUndecryptedItemNeverReachesTheServer() async {
  reset()
  CacheManager.shared.rows["u1"] = row("u1", parent: "H", name: nil, encrypted: undecryptable)
  let placeholder = FileProviderItem(cached: CacheManager.shared.rows["u1"]!).filename
  let (renamed, renamePending, renameError) = await modifyReturningPending(Template("u1", parent: "H", filename: "Folder 2"), [.filename])
  check(renameError == nil, "rename of an undecrypted item: no error, got \(describe(renameError))")
  check(ApiClient.shared.count("patch") == 0, "rename of an undecrypted item: 0 server writes, got \(ApiClient.shared.calls)")
  check(renamed?.filename == placeholder, "rename of an undecrypted item: the label is kept (\(placeholder)), got \(renamed?.filename ?? "nil")")
  check(renamePending.isEmpty, "rename of an undecrypted item: the name is not left pending (the label goes back on disk), got \(renamePending.rawValue)")
  check(CacheManager.shared.item(id: "u1")?.nameEncrypted == undecryptable, "the server name is untouched in the cache")

  // Review round 2, item 6: with lastUsedDate riding along, the name is still put back and only
  // lastUsedDate stays pending.
  reset()
  CacheManager.shared.rows["u1"] = row("u1", parent: "H", name: nil, encrypted: undecryptable)
  let (_, mixedPending, mixedError) = await modifyReturningPending(Template("u1", parent: "H", filename: "Folder 2"), [.filename, .lastUsedDate])
  check(mixedError == nil && ApiClient.shared.calls.isEmpty, "rename + lastUsedDate of an undecrypted item: no error, no server call, got \(ApiClient.shared.calls)")
  check(mixedPending == .lastUsedDate, "rename + lastUsedDate of an undecrypted item: only lastUsedDate stays pending, got \(mixedPending.rawValue)")

  reset()
  CacheManager.shared.rows["u1"] = row("u1", parent: "H", name: nil, encrypted: undecryptable)
  let (_, movePending, moveError) = await modifyReturningPending(Template("u1", parent: "K", filename: "Folder 2"), [.filename, .parentItemIdentifier])
  check(moveError == nil, "move of an undecrypted item: no error, got \(describe(moveError))")
  check(ApiClient.shared.calls == ["patch u1 parent=K"], "move: one PATCH for the new parent, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.patchedNames == [undecryptable], "move: carries the existing ciphertext name, never a new one")
  check(movePending.isEmpty, "move: nothing left pending, got \(movePending.rawValue)")

  reset()
  CacheManager.shared.rows["r1"] = row("r1", parent: "H", name: "old.txt", encrypted: encryptedName("r1", "old.txt"))
  let (readable, readablePending, readableError) = await modifyReturningPending(Template("r1", parent: "H", filename: "new.txt"), [.filename])
  check(readableError == nil && readable?.filename == "new.txt", "a decrypted item still renames, got \(describe(readableError))")
  let sent = ApiClient.shared.patchedNames.first ?? nil
  let sentName = sent.flatMap { try? CryptoBridge.decryptFilename(masterKeyHandle: fixtureMaster, fileId: "r1", nameEncrypted: $0) }
  check(ApiClient.shared.count("patch") == 1 && sentName == "new.txt", "the rename sends one ciphertext of the new name, got \(sentName ?? "nil")")
  check(readablePending.isEmpty, "rename: nothing left pending, got \(readablePending.rawValue)")

  // Review round 2, item 6: a rename that carries lastUsedDate renames on the server and leaves
  // lastUsedDate pending (the system then asks for it alone, and it is declined as unsupported).
  reset()
  CacheManager.shared.rows["r1"] = row("r1", parent: "H", name: "old.txt", encrypted: encryptedName("r1", "old.txt"))
  let (_, renamedPending, renamedError) = await modifyReturningPending(Template("r1", parent: "H", filename: "new.txt"), [.filename, .lastUsedDate])
  check(renamedError == nil && ApiClient.shared.count("patch") == 1, "rename + lastUsedDate: one PATCH, got \(ApiClient.shared.calls)")
  check(renamedPending == .lastUsedDate, "rename + lastUsedDate: lastUsedDate stays pending, got \(renamedPending.rawValue)")
}

// Task 1722 (review round 1, found on the simulator log): opening a file makes Files send
// modifyItem(changedFields: lastUsedDate). That used to stamp updatedAt = now and the system's
// content type into the row, so the item came back with a NEW content version: fileproviderd
// fetched (downloaded, decrypted, wrote) the same file a second time 7 s later, and the
// snapshot anchor changed. A change Beebeeb does not store must leave the item as it was.
func metadataOnlyModifyKeepsTheItem() async {
  let changes: [(String, NSFileProviderItemFields)] = [
    ("lastUsedDate", .lastUsedDate), ("contentModificationDate", .contentModificationDate),
    ("tagData", .tagData), ("lastUsedDate+favoriteRank", [.lastUsedDate, .favoriteRank]),
  ]
  for (label, fields) in changes {
    reset()
    CacheManager.shared.rows["r1"] = row("r1", name: "notes.md", encrypted: encryptedName("r1", "notes.md"), size: 207, mime: nil)
    // Observe the same repaired cache row that item(for:) / enumeration gives fileproviderd.
    let before = FileProviderItem(cached: CacheManager.shared.item(id: "r1")!)
    let (after, pending, error) = await modifyReturningPending(Template("r1", parent: NSFileProviderItemIdentifier.rootContainer.rawValue, filename: "notes.md"), fields)
    check(error == nil, "\(label): no error, got \(describe(error))")
    check(after?.itemVersion?.contentVersion == before.itemVersion.contentVersion, "\(label): the content version is unchanged (no re-download)")
    check(after?.itemVersion?.metadataVersion == before.itemVersion.metadataVersion, "\(label): the metadata version is unchanged")
    // Review round 2, item 6: what Beebeeb does not store goes back still pending, so the system
    // keeps the value on disk (Files builds Recents from lastUsedDate) instead of taking ours,
    // which is nil. A set equal to changedFields marks those fields unsupported for this item.
    check(pending == fields, "\(label): the declined fields come back still pending, got \(pending.rawValue)")
    check(CacheManager.shared.writes.isEmpty, "\(label): nothing written to the cache, got \(CacheManager.shared.writes)")
    check(ApiClient.shared.calls.isEmpty, "\(label): no server call, got \(ApiClient.shared.calls)")
  }
}

// ---- (e) Beebeeb has no Files trash ----
func lookup(_ identifier: NSFileProviderItemIdentifier) async -> (NSFileProviderItem?, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    _ = ext.item(for: identifier, request: NSFileProviderRequest()) { item, error in
      continuation.resume(returning: (item, error as NSError?))
    }
  }
}

func isFeatureUnsupported(_ error: NSError?) -> Bool {
  error?.domain == NSCocoaErrorDomain && error?.code == NSFeatureUnsupportedError
}

func trashIsUnsupportedNotTheRoot() async {
  reset()
  let (trash, trashError) = await lookup(.trashContainer)
  check(trash == nil, "item(for: .trashContainer) must not vend an item, got \(trash.map { $0.itemIdentifier.rawValue } ?? "nil")")
  check(isFeatureUnsupported(trashError), "item(for: .trashContainer): NSFeatureUnsupportedError, got \(describe(trashError))")

  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  var enumeratorError: NSError?
  do {
    _ = try ext.enumerator(for: .trashContainer, request: NSFileProviderRequest())
  } catch {
    enumeratorError = error as NSError
  }
  check(isFeatureUnsupported(enumeratorError), "enumerator(for: .trashContainer): NSFeatureUnsupportedError, got \(describe(enumeratorError))")

  let (root, rootError) = await lookup(.rootContainer)
  check(rootError == nil && root?.itemIdentifier == .rootContainer, "the root item is unchanged")
  let (workingSet, workingSetError) = await lookup(.workingSet)
  check(workingSetError == nil && workingSet?.itemIdentifier == .rootContainer, "the working set lookup is unchanged")
  check(ApiClient.shared.calls.isEmpty && CacheManager.shared.writes.isEmpty, "trash lookups touch neither the server nor the cache")
}

// ---- Task 1722 review M4: the snapshot anchor ignores the MIME type ----
final class ChangeObserver: NSObject, NSFileProviderChangeObserver {
  var finished: NSFileProviderSyncAnchor?
  var error: NSError?
  func didUpdate(_ updatedItems: [NSFileProviderItem]) {}
  func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {}
  func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) { finished = anchor }
  func finishEnumeratingWithError(_ error: Error) { self.error = error as NSError }
}

// The two cache writers disagree on mime_type: the app writes the server's (often null), the
// extension the decrypted one. Every flip changed the content type and so the anchor, and each
// changed anchor costs "a very expensive scan of all the items known by the system". A MIME-only
// change keeps the anchor; identity, parent, name and versions still move it.
func snapshotIgnoresTheMimeType() async {
  reset()
  CacheManager.shared.rows["m1"] = row("m1", name: "notes.md", size: 207, mime: "text/plain")
  let enumerator = FileProviderEnumerator(containerIdentifier: .rootContainer)
  var anchor: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { anchor = $0 }
  guard let anchor else { check(false, "no anchor"); return }
  for mime in [nil, "text/markdown", "application/octet-stream"] as [String?] {
    CacheManager.shared.rows["m1"] = row("m1", name: "notes.md", size: 207, mime: mime)
    let observer = ChangeObserver()
    enumerator.enumerateChanges(for: observer, from: anchor)
    check(observer.error == nil && observer.finished == anchor, "mime \(mime ?? "nil"): the anchor is unchanged (no full rescan), got \(describe(observer.error))")
  }
  CacheManager.shared.rows["m1"] = row("m1", name: "renamed.md", size: 207, mime: "text/plain")
  let renamed = ChangeObserver()
  enumerator.enumerateChanges(for: renamed, from: anchor)
  check(isProviderError(renamed.error, .syncAnchorExpired), "a rename still rebuilds, got \(describe(renamed.error))")
  enumerator.invalidate()
}

// ---- (G4/G5) content streams, chunk by chunk, into the registered App Group temp directory ----
import CryptoKit

func footprint() -> (current: UInt64, peak: UInt64) {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  return result == KERN_SUCCESS ? (info.phys_footprint, UInt64(max(0, info.ledger_phys_footprint_peak))) : (0, 0)
}

/// Writes \(size) bytes of a deterministic payload as upload-format ciphertext, one chunk at a time,
/// and returns the payload's SHA-256 so the decrypted file can be compared without holding either.
func writeCiphertext(fileId: String, size: Int, chunkSize: Int, to url: URL) -> (chunks: Int, digest: SHA256.Digest) {
  FileManager.default.createFile(atPath: url.path, contents: nil)
  let handle = try! FileHandle(forWritingTo: url)
  defer { try? handle.close() }
  var hash = SHA256()
  var offset = 0
  var chunks = 0
  repeat {
    let length = min(chunkSize, size - offset)
    let plaintext = Data((0..<length).map { UInt8(truncatingIfNeeded: (offset + $0) &* 31 &+ 7) })
    hash.update(data: plaintext)
    try! handle.write(contentsOf: CryptoBridge.encryptChunkForUpload(masterKeyHandle: fixtureMaster, fileId: fileId, plaintext: plaintext))
    offset += length
    chunks += 1
  } while offset < size
  return (chunks, hash.finalize())
}

func digest(of url: URL) -> SHA256.Digest? {
  guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
  defer { try? handle.close() }
  var hash = SHA256()
  while let next = try? handle.read(upToCount: 1 << 20), !next.isEmpty { hash.update(data: next) }
  return hash.finalize()
}

func stage(_ id: String, size: Int, chunkSize: Int, pinned: Bool = false) -> (download: URL, digest: SHA256.Digest) {
  var cachedRow = row(id, name: "\(id).dng", size: size)
  cachedRow.isPinned = pinned
  CacheManager.shared.rows[id] = cachedRow
  let download = AppGroupContainer.root.appendingPathComponent("download-\(id).bin")
  let written = writeCiphertext(fileId: id, size: size, chunkSize: chunkSize, to: download)
  ApiClient.shared.downloadResult = .success(DownloadedEncryptedFile(url: download, chunkCount: written.chunks, chunkSize: chunkSize))
  return (download, written.digest)
}

func leftovers(_ id: String) -> [String] {
  let directories = [AppGroupContainer.temporaryContentDirectory, AppGroupContainer.pinnedContentDirectory,
                     NSFileProviderManager.systemTemporaryDirectory]
  return directories.flatMap { (try? FileManager.default.contentsOfDirectory(atPath: $0.path)) ?? [] }.filter { $0.hasPrefix(id) }
}

func entries(_ directory: URL) -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
}

func contentStreamsIntoATemporaryFile() async {
  reset()
  let size = 6 * 1_048_576 + 12_345
  let staged = stage("big", size: size, chunkSize: 1_048_576)
  let (url, error) = await fetch("big")
  check(error == nil, "streamed fetch: no error, got \(describe(error))")
  check(url.flatMap(digest(of:)) == staged.digest, "streamed fetch: the plaintext matches byte for byte (\(size) bytes, 7 chunks)")
  check(!FileManager.default.fileExists(atPath: staged.download.path), "streamed fetch: the downloaded ciphertext file is deleted")

  reset()
  let pinned = stage("pin", size: 70_000, chunkSize: 16_384, pinned: true)
  let (pinnedURL, pinnedError) = await fetch("pin")
  let pinnedCopy = AppGroupContainer.pinnedContentDirectory.appendingPathComponent("pin")
  check(pinnedError == nil && pinnedURL.flatMap(digest(of:)) == pinned.digest, "pinned fetch: returned content matches")
  check(digest(of: pinnedCopy) == pinned.digest, "pinned fetch: the pinned copy matches")
  check(PlaintextStorageProtection.protected.contains("pin"), "pinned fetch: the pinned copy is protected")
  check(CacheManager.shared.item(id: "pin")?.isMaterialized == true, "pinned fetch: marked materialized")
}

func contentStreamingStaysWithinTheExtensionBudget() async {
  reset()
  let size = 48 * 1_048_576
  let staged = stage("dng", size: size, chunkSize: 4 * 1_048_576)
  let before = footprint()
  let (url, error) = await fetch("dng")
  let after = footprint()
  check(error == nil && url.flatMap(digest(of:)) == staged.digest, "48 MiB fetch decrypts correctly, got \(describe(error))")
  check(before.peak > 0 && after.peak > 0, "footprint is measurable")
  let grown = after.peak > before.current ? after.peak - before.current : 0
  check(grown < 24 * 1_048_576, "48 MiB fetch peak growth is under 24 MiB (two 4 MiB chunks + overhead), got \(grown / 1_048_576) MiB")
  print("streamed-memory: 48 MiB fetched, peak footprint grew \(grown / 1_048_576) MiB")
}

// Task 1722 review I1: plaintext goes only into the registered App Group temp directory
// (excluded from backup, protected, swept by every sign-out purge), never into the system
// temporary directory, which on a simulator resolved to <device>/data/tmp.
func contentLandsInTheRegisteredTempDirectory() async {
  reset()
  let staged = stage("small", size: 207, chunkSize: 1_048_576)
  let (url, error) = await fetch("small")
  check(error == nil && url.flatMap(digest(of:)) == staged.digest, "fetch succeeds, got \(describe(error))")
  let directory = url?.deletingLastPathComponent().standardizedFileURL.path
  check(directory == AppGroupContainer.temporaryContentDirectory.standardizedFileURL.path, "content is in the App Group temp directory, got \(directory ?? "nil")")
  check(NSFileProviderManager.temporaryDirectoryCalls == 0, "temporaryDirectoryURL() is never asked, got \(NSFileProviderManager.temporaryDirectoryCalls) calls")
  check(entries(NSFileProviderManager.systemTemporaryDirectory).isEmpty, "nothing written to the system temporary directory, got \(entries(NSFileProviderManager.systemTemporaryDirectory))")
}

/// Flips one byte in chunk number "index" (0-based) of upload-format ciphertext with "chunkSize" plaintext chunks.
func tamper(_ url: URL, chunk index: Int, chunkSize: Int) {
  let handle = try! FileHandle(forUpdating: url)
  defer { try? handle.close() }
  let offset = UInt64(index * (12 + chunkSize + 16) + 12 + 100)
  try! handle.seek(toOffset: offset)
  let byte = try! handle.read(upToCount: 1)!
  try! handle.seek(toOffset: offset)
  try! handle.write(contentsOf: Data([byte[0] ^ 0xFF]))
}

// Task 1722 review I1 / mutation B: a chunk that fails part-way (tampered, or the file ends
// early) must not leave the chunks already written. The partial file is observed existing
// before the failing chunk, so the check below proves a real cleanup, not an empty directory.
func badChunkLeavesNoPlaintext() async {
  let chunk = 16_384
  let cases: [(id: String, label: String, damage: (URL) -> Void)] = [
    ("tampered", "tampered chunk 3 of 5", { url in tamper(url, chunk: 2, chunkSize: chunk) }),
    ("truncated", "truncated in chunk 4 of 5", { url in
      let handle = try! FileHandle(forWritingTo: url)
      try! handle.truncate(atOffset: UInt64(3 * (12 + chunk + 16) + 8_000))
      try! handle.close()
    }),
  ]
  for (id, label, damage) in cases {
    reset()
    let staged = stage(id, size: 5 * chunk, chunkSize: chunk)
    damage(staged.download)
    var partialBeforeFailure: [String] = []
    // Epoch checks: before the first byte (1), then before chunks 1, 2, 3 (2, 3, 4).
    CacheManager.shared.onEpochCheck = (4, { partialBeforeFailure = leftovers(id) })
    let (url, error) = await fetch(id)
    check(url == nil && isProviderError(error, .cannotSynchronize), "\(label): content that does not decode is -2005, got \(describe(error))")
    check(partialBeforeFailure.count == 1, "\(label): a partial plaintext file existed before the bad chunk, got \(partialBeforeFailure)")
    check(leftovers(id).isEmpty, "\(label): no partial plaintext left, got \(leftovers(id))")
    check(!FileManager.default.fileExists(atPath: staged.download.path), "\(label): the ciphertext file is deleted")
  }
}

// Task 1722 review I1: a decrypt that was killed (jetsam, crash, or the extension stopped when
// sign-out removes the domain) leaves its partial plaintext in temp/. Apple: such a file "may
// unexpectedly still be on disk the next time an instance of the extension is created. The
// extension is then responsible for deleting that file." The first instance in a process sweeps
// temp/ (nothing of this process can be in flight yet); later instances leave it alone, so they
// never delete another instance's in-flight output. pinned/ is kept on purpose.
func leftoversFromAKilledExtensionAreDeletedAtStart() async {
  reset()
  let temp = AppGroupContainer.temporaryContentDirectory
  for name in ["f1-11111111-2222-3333-4444-555555555555", "f2-66666666-7777-8888-9999-000000000000"] {
    FileManager.default.createFile(atPath: temp.appendingPathComponent(name).path, contents: Data(repeating: 7, count: 4_096))
  }
  let pinnedCopy = AppGroupContainer.pinnedContentDirectory.appendingPathComponent("kept")
  FileManager.default.createFile(atPath: pinnedCopy.path, contents: Data(repeating: 1, count: 16))
  check(entries(temp).count == 2, "two leftovers staged")

  _ = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  check(entries(temp).isEmpty, "the first extension instance deletes leftover plaintext, got \(entries(temp))")
  check(FileManager.default.fileExists(atPath: pinnedCopy.path), "pinned content is kept")

  let inFlight = temp.appendingPathComponent("f3-in-flight")
  FileManager.default.createFile(atPath: inFlight.path, contents: Data(repeating: 3, count: 16))
  _ = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  check(FileManager.default.fileExists(atPath: inFlight.path), "a later instance never deletes another instance's in-flight output")
}

var pendingProgress: Progress?
let pendingLock = NSLock()

func fetchKeepingProgress(_ id: String) async -> (URL?, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    let progress = ext.fetchContents(for: NSFileProviderItemIdentifier(id), version: nil, request: NSFileProviderRequest()) { url, _, error in
      continuation.resume(returning: (url, error as NSError?))
    }
    pendingLock.lock(); pendingProgress = progress; pendingLock.unlock()
  }
}

func midStreamStopsDeleteThePartialFile() async {
  // A sign-out purge landing on the 4th epoch check: before write (1), chunks 1-2 (2, 3), chunk 3 (4).
  reset()
  let purged = stage("purged", size: 5 * 16_384, chunkSize: 16_384)
  CacheManager.shared.onEpochCheck = (4, { CacheManager.shared.epoch += 1 })
  let (purgedURL, purgedError) = await fetch("purged")
  check(purgedURL == nil && isProviderError(purgedError, .noSuchItem), "purge mid-stream: -1005, got \(describe(purgedError))")
  check(leftovers("purged").isEmpty, "purge mid-stream: no partial plaintext left, got \(leftovers("purged"))")
  check(!FileManager.default.fileExists(atPath: purged.download.path), "purge mid-stream: the ciphertext file is deleted")

  // The system cancelling the progress mid-stream: NSUserCancelledError, nothing left behind.
  reset()
  pendingProgress = nil
  _ = stage("cancelled", size: 5 * 16_384, chunkSize: 16_384)
  CacheManager.shared.onEpochCheck = (3, {
    // Runs inside the fetch task: cancel its progress (as the system would) and wait until the
    // cancellation handler has reached this task, so the next chunk check sees it.
    for _ in 0..<5_000 {
      pendingLock.lock(); let progress = pendingProgress; pendingLock.unlock()
      if let progress { progress.cancel(); break }
      usleep(1_000)
    }
    for _ in 0..<5_000 where !Task.isCancelled { usleep(1_000) }
  })
  let (cancelledURL, cancelledError) = await fetchKeepingProgress("cancelled")
  check(cancelledURL == nil && cancelledError?.domain == NSCocoaErrorDomain && cancelledError?.code == NSUserCancelledError, "cancel mid-stream: NSUserCancelledError, got \(describe(cancelledError))")
  check(leftovers("cancelled").isEmpty, "cancel mid-stream: no partial plaintext left, got \(leftovers("cancelled"))")
}

// ---- Task 1722 round 4 (review round 2, minor 6): the working set covers the folders Files listed ----
// In the replicated model iOS never lists a materialized folder again and ignores signals for any
// container but the working set: a web-side change in such a folder, or a TestFlight 236 row cached
// without a name, reaches Files only through the working set.
var keepGoing = false
var softFailures = 0
func soft(_ condition: @autoclosure () -> Bool, _ label: String) {
  if condition() { passed += 1 } else { softFailures += 1; print("FAIL: \(label)"); fflush(stdout) }
}
func waitUntil(_ seconds: Double = 6, _ condition: () -> Bool) async -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 20_000_000)
  }
  return condition()
}
func materializedItems(_ ids: [String]) -> [NSFileProviderItem] {
  ids.map { id in
    id == "root" ? FileProviderItem(cached: .rootContainer()) as NSFileProviderItem
                 : FileProviderItem(cached: CacheManager.shared.rows[id]!) as NSFileProviderItem
  }
}
func callMaterializedItemsDidChange(_ ext: FileProviderExtension) -> Bool {
  let replicated: NSFileProviderReplicatedExtension = ext
  var returned = false
  replicated.materializedItemsDidChange? { returned = true }
  return returned
}

func materializedSetFollowsTheSystem() async {
  reset()
  NSFileProviderManager.resetRecords()
  NSFileProviderManager.signalDelay = 0.15
  CacheManager.shared.rows["F"] = row("F", name: "Taxes", folder: true)
  CacheManager.shared.rows["G"] = row("G", name: "Photos", folder: true)
  CacheManager.shared.rows["x"] = row("x", name: "notes.txt")
  NSFileProviderManager.setMaterialized(materializedItems(["F", "x", "G", "root"]))
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  soft(callMaterializedItemsDidChange(ext), "materializedItemsDidChange is implemented and returns at once")
  let stored = await waitUntil { CacheManager.shared.materializedContainerIds() == ["F", "G"] }
  soft(stored, "the system's materialized folders are stored (not its files, not the root), got \(CacheManager.shared.materializedContainerIds())")
  let signalled = await waitUntil { NSFileProviderManager.signals.contains(NSFileProviderItemIdentifier.workingSet.rawValue) }
  soft(signalled, "the working set is signalled when the stored set changes, got \(NSFileProviderManager.signals)")
  NSFileProviderManager.setMaterialized(materializedItems(["F"]))
  _ = callMaterializedItemsDidChange(ext)
  let shrunk = await waitUntil { CacheManager.shared.materializedContainerIds() == ["F"] }
  soft(shrunk, "a folder made dataless again leaves the set, got \(CacheManager.shared.materializedContainerIds())")
}

// Task 2215: observe completion, not intermediate cache writes or unrelated signals.
// The deadline resolves independently of the refresh, so a broken pass fails here rather
// than hanging until Bun's outer timeout. No retry or scheduler-dependent settling sleep.
actor RefreshCompletions {
  private var completed = 0
  private var waiters: [UUID: (Int, CheckedContinuation<Bool, Never>)] = [:]

  func finish() {
    completed += 1
    for (id, waiter) in waiters where waiter.0 <= completed {
      waiters.removeValue(forKey: id)
      waiter.1.resume(returning: true)
    }
  }

  func wait(for target: Int, timeout: TimeInterval = 6) async -> Bool {
    if completed >= target { return true }
    let id = UUID()
    return await withCheckedContinuation { continuation in
      waiters[id] = (target, continuation)
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
        Task { await self.expire(id) }
      }
    }
  }

  private func expire(_ id: UUID) {
    waiters.removeValue(forKey: id)?.1.resume(returning: false)
  }
}

struct ObservedWorkingSetRefresher: FileProviderContainerRefreshing {
  let completions = RefreshCompletions()
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    await SyncEngine.refreshContainer(containerId: containerId)
  }
  func refreshMaterializedContainers() async {
    _ = await SyncEngine.refreshMaterializedContainers()
    await completions.finish()
  }
  func waitForPass(_ number: Int) async {
    let finished = await completions.wait(for: number)
    if !finished { check(false, "materialized refresh pass \(number) missed its deadline") }
  }
}

func listWorkingSetNames(_ enumerator: FileProviderEnumerator) async -> [String] {
  let observer = ListingObserver()
  enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
  let finished = await withCheckedContinuation { continuation in
    DispatchQueue.global().async { continuation.resume(returning: observer.wait()) }
  }
  if !finished { check(false, "working-set listing missed its deadline") }
  return observer.items.map(\.filename).sorted()
}

func staleMaterializedFoldersAreRefreshed() async {
  reset()
  NSFileProviderManager.resetRecords()
  // TestFlight 236 cached this folder's row without a name (Files showed "Open Beebeeb to Decrypt N").
  CacheManager.shared.rows["F"] = row("F", name: "Taxes", folder: true)
  CacheManager.shared.rows["t1"] = row("t1", parent: "F", name: nil, encrypted: encryptedName("t1", "2026 return.pdf"))
  CacheManager.shared.rows["G"] = row("G", name: "Photos", folder: true)
  CacheManager.shared.rows["g1"] = row("g1", parent: "G", name: nil, encrypted: encryptedName("g1", "beach.jpg"))
  // A working-set listing also refreshes root. Keep its folders intact: the default empty
  // response otherwise deletes F/G and can expire the anchor independently of the name fix.
  ApiClient.shared.listings["root"] = .success([
    dto("F", parent: nil, name: "Taxes", folder: true),
    dto("G", parent: nil, name: "Photos", folder: true),
  ])
  ApiClient.shared.listings["F"] = .success([dto("t1", parent: "F", name: encryptedName("t1", "2026 return.pdf"))])
  ApiClient.shared.listings["G"] = .success([dto("g1", parent: "G", name: encryptedName("g1", "beach.jpg"))])
  NSFileProviderManager.setMaterialized(materializedItems(["F", "root"]))
  // Callback scheduling is covered by materializedSetFollowsTheSystem. Await setup itself.
  _ = await MaterializedSetTracker.shared.syncNow()
  soft(CacheManager.shared.materializedContainerIds() == ["F"], "setup: F is materialized, got \(CacheManager.shared.materializedContainerIds())")

  let refresher = ObservedWorkingSetRefresher()
  func workingSet() -> FileProviderEnumerator {
    FileProviderEnumerator(containerIdentifier: .workingSet, cache: CacheManager.shared, refresher: refresher)
  }
  let ws = workingSet()
  var anchor: NSFileProviderSyncAnchor?
  // Capture BEFORE enumerateItems starts the detached refresh. Capturing after it returned
  // raced the name update and sometimes compared the refreshed anchor to itself.
  ws.currentSyncAnchor { anchor = $0 }
  let before = await listWorkingSetNames(ws)
  soft(before.contains("Encrypted item \u{00B7} t1"), "before: the working set carries F's cached row, got \(before)")
  await refresher.waitForPass(1)
  soft(ApiClient.shared.count("list F") == 1, "the stale materialized folder is listed again, calls \(ApiClient.shared.calls)")
  soft(CacheManager.shared.item(id: "t1").map { FileProviderItem(cached: $0).filename } == "2026 return.pdf", "its TestFlight 236 row gets its real name")
  soft(ApiClient.shared.count("list G") == 0, "a folder Files never listed is not refreshed, calls \(ApiClient.shared.calls)")
  let currentWS = workingSet()
  let after = await listWorkingSetNames(currentWS)
  await refresher.waitForPass(2)
  soft(after.contains("2026 return.pdf") && !after.contains("beach.jpg"), "the working set now carries the real name and nothing from G, got \(after)")
  var current: NSFileProviderSyncAnchor?
  currentWS.currentSyncAnchor { current = $0 }
  soft(current != anchor, "the refresh invalidates the prior working-set anchor")
  let changed = ChangeObserver()
  ws.enumerateChanges(for: changed, from: anchor!)
  await refresher.waitForPass(3)
  soft(isProviderError(changed.error, .syncAnchorExpired), "Files is told the working set changed, got \(describe(changed.error))")
  soft(NSFileProviderManager.signals.contains("F") && NSFileProviderManager.signals.contains(NSFileProviderItemIdentifier.workingSet.rawValue), "the refresh signalled F and the working set, got \(NSFileProviderManager.signals)")
  let listCount = ApiClient.shared.count("list F")
  ws.enumerateChanges(for: ChangeObserver(), from: anchor!)
  await refresher.waitForPass(4)
  currentWS.invalidate()
  soft(ApiClient.shared.count("list F") == listCount, "a folder refreshed a moment ago is not listed again (no loop), got \(ApiClient.shared.count("list F"))")
  ws.invalidate()
}

func staleTrashIsRefreshedOutsideTheWorkingSet() async {
  reset()
  NSFileProviderManager.resetRecords()
  CacheManager.shared.rows["trash:t1"] = row("trash:t1", parent: trashId, name: "gone.txt")
  CacheManager.shared.setSyncState(key: "container.\(trashId).anchor", value: "1")
  ApiClient.shared.listings["trashed:root"] = .success([])
  _ = await SyncEngine.refreshMaterializedContainers(now: Date())
  check(ApiClient.shared.count("list-trashed root") == 1, "the rate-limited refresh lists Trash")
  check(CacheManager.shared.item(id: "trash:t1") == nil, "an emptied Trash prunes its cached rows")
  check(NSFileProviderManager.signals.contains(trashId), "the Trash enumerator is signalled, got \(NSFileProviderManager.signals)")
  check(!NSFileProviderManager.signals.contains(NSFileProviderItemIdentifier.workingSet.rawValue),
        "a Trash-only refresh does not signal the working set")

  reset()
  NSFileProviderManager.resetRecords()
  let changed = dtoUpdated("changed", parent: nil, name: encryptedName("changed", "changed.txt"), updated: "2026-10-15T00:00:00Z")
  ApiClient.shared.listings["trashed:root"] = .success([changed])
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  let cached = CacheManager.shared.item(id: "trash:changed")!
  let contentPayload = "\(cached.updatedAt ?? "")|\(cached.sizeBytes)"
  let preCapabilityVersion = Data("\(contentPayload)|\(cached.nameDecrypted ?? "")|\(cached.nameEncrypted ?? "")|\(cached.parentId ?? "")".utf8)
  let delivered = await list(trashId)
  let deliveredVersion = delivered.items.first { $0.itemIdentifier.rawValue == "trash:changed" }?.itemVersion?.metadataVersion
  check(deliveredVersion == FileProviderItem(cached: cached).itemVersion.metadataVersion
          && deliveredVersion != preCapabilityVersion,
        "the signalled Trash listing re-delivers the row with a capability-version marker")
  check(NSFileProviderManager.signals.contains(trashId), "the versioned Trash row was signalled to its enumerator")
}

func newerTrashRefreshWinsAfterTheAppSignal() async {
  reset()
  NSFileProviderManager.resetRecords()
  CacheManager.shared.rows["trash:old"] = row("trash:old", parent: trashId, name: "old.txt")
  CacheManager.shared.setSyncState(key: "container.\(trashId).anchor", value: "1")
  let oldPage = [dto("old", parent: nil, name: encryptedName("old", "old.txt"))]
  let freshPage = oldPage + [dto("new", parent: nil, name: encryptedName("new", "newly trashed.txt"))]
  ApiClient.shared.listings["trashed:root"] = .success(freshPage)
  ApiClient.shared.scriptListings("trashed:root", [
    .init(delayNanoseconds: 150_000_000, result: .success(freshPage)),
    .init(delayNanoseconds: 150_000_000, result: .success(freshPage)),
  ])
  ApiClient.shared.scriptListings("trashed:root", [
    .init(delayNanoseconds: 250_000_000, result: .success(oldPage)),
    .init(delayNanoseconds: 10_000_000, result: .success(freshPage)),
  ])

  let staleRefresh = Task { await SyncEngine.refreshContainer(containerId: trashId) }
  let olderStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 1 }
  check(olderStarted, "the older Trash request started")
  let signalEnumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: SyncEngineContainerRefresher()
  )
  var anchor: NSFileProviderSyncAnchor?
  signalEnumerator.currentSyncAnchor { anchor = $0 }
  let before = await enumerateOnce(FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: NoRefresh()
  ))
  check(before.items.map(\.filename) == ["old.txt"], "the signal first delivers the cached Trash listing")
  let change = ChangeObserver()
  signalEnumerator.enumerateChanges(for: change, from: anchor!)
  let newerStarted = await waitUntil { ApiClient.shared.count("list-trashed root") >= 2 }
  check(newerStarted, "enumerateChanges after the app signal triggered a fresh Trash listing")
  let changeFinished = await waitUntil { change.error != nil || change.finished != nil }
  check(changeFinished && isProviderError(change.error, .syncAnchorExpired),
        "the real change-enumeration path reports the refreshed Trash snapshot")
  _ = await staleRefresh.value
  signalEnumerator.invalidate()

  let stableEnumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: NoRefresh()
  )
  let after = await enumerateOnce(stableEnumerator)
  stableEnumerator.invalidate()
  check(after.items.map(\.filename).sorted() == ["newly trashed.txt", "old.txt"],
        "the newly trashed file remains in the listing after the older response finishes")
  check(!NSFileProviderManager.signals.contains(trashId),
        "the observer receives the fresh snapshot without recursively signaling its own enumerator")
}

func idleTrashBurstDeliversEveryNewRow() async {
  reset()
  NSFileProviderManager.resetRecords()
  CacheManager.shared.rows["trash:known"] = row("trash:known", parent: trashId, name: "known.txt")
  CacheManager.shared.setSyncState(key: "container.\(trashId).anchor", value: "1")

  let listedEnumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: NoRefresh()
  )
  let known = await enumerateOnce(listedEnumerator)
  check(known.items.map(\.filename) == ["known.txt"], "Files first knows the existing Trash listing")
  var anchor: NSFileProviderSyncAnchor?
  listedEnumerator.currentSyncAnchor { anchor = $0 }
  listedEnumerator.invalidate()

  let freshPage = [
    dto("known", parent: nil, name: encryptedName("known", "known.txt")),
    dto("burst-one", parent: nil, name: encryptedName("burst-one", "burst one.txt")),
    dto("burst-two", parent: nil, name: encryptedName("burst-two", "burst two.txt")),
    dto("burst-three", parent: nil, name: encryptedName("burst-three", "burst three.txt")),
  ]
  ApiClient.shared.listings["trashed:root"] = .success(freshPage)
  let signalEnumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: SyncEngineContainerRefresher()
  )
  let observers = [ChangeObserver(), ChangeObserver(), ChangeObserver()]
  for observer in observers {
    signalEnumerator.enumerateChanges(for: observer, from: anchor!)
  }
  let reopened = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: SyncEngineContainerRefresher()
  )
  _ = await enumerateOnce(reopened)
  let allFinished = await waitUntil {
    observers.allSatisfy { $0.error != nil || $0.finished != nil }
  }
  check(allFinished, "every observer in the three-signal burst settles")
  check(observers.allSatisfy { isProviderError($0.error, .syncAnchorExpired) },
        "every burst observer sees that the delivered Trash snapshot changed")
  check(ApiClient.shared.count("list-trashed root") == 2,
        "the idle signal starts one pass and the burst queues exactly one later pass")
  check(ApiClient.shared.maximumConcurrentListings == 1,
        "signal, reopen, and queued Trash passes never publish against overlapping server snapshots")

  let delivered = await enumerateOnce(FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: NoRefresh()
  ))
  check(delivered.items.map(\.filename).sorted() == ["burst one.txt", "burst three.txt", "burst two.txt", "known.txt"],
        "all three newly trashed rows are delivered after the burst")
  check(["trash:burst-one", "trash:burst-two", "trash:burst-three"].allSatisfy { CacheManager.shared.item(id: $0) != nil },
        "all three newly trashed rows were published into the namespaced cache")
  signalEnumerator.invalidate()
  reopened.invalidate()
}

func supersededTrashChangeStillPublishesBeforeReplying() async {
  reset()
  CacheManager.shared.rows["trash:known"] = row("trash:known", parent: trashId, name: "known.txt")
  CacheManager.shared.setSyncState(key: "container.\(trashId).anchor", value: "1")
  let freshPage = [
    dto("known", parent: nil, name: encryptedName("known", "known.txt")),
    dto("new", parent: nil, name: encryptedName("new", "new.txt")),
  ]
  ApiClient.shared.listings["trashed:root"] = .success(freshPage)
  ApiClient.shared.scriptListings("trashed:root", [
    .init(delayNanoseconds: 200_000_000, result: .success(freshPage)),
    .init(delayNanoseconds: 10_000_000, result: .failure(URLError(.timedOut))),
    .init(delayNanoseconds: 10_000_000, result: .success(freshPage)),
  ])

  let enumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: SyncEngineContainerRefresher()
  )
  var anchor: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { anchor = $0 }
  let observer = ChangeObserver()
  enumerator.enumerateChanges(for: observer, from: anchor!)
  let changeStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 1 }
  check(changeStarted, "the signal-driven Trash listing started from an idle coordinator")

  let periodic = Task { await SyncEngine.refreshContainer(containerId: trashId) }
  let periodicOutcome = await periodic.value
  check(periodicOutcome == .serverUnreachable, "the superseding periodic listing exposed its failure")
  let finished = await waitUntil { observer.error != nil || observer.finished != nil }
  check(finished && isProviderError(observer.error, .syncAnchorExpired),
        "the change observer replies only after a successful listing publishes")
  check(ApiClient.shared.count("list-trashed root") == 3,
        "a superseded change listing retries after the newer direct listing fails")
  check(CacheManager.shared.item(id: "trash:new") != nil,
        "the retried listing publishes the newly trashed row before the observer replies")
  enumerator.invalidate()
}

func repeatedSupersessionStopsAfterTheRetryLimit() async {
  reset()
  CacheManager.shared.rows["trash:known"] = row("trash:known", parent: trashId, name: "known.txt")
  CacheManager.shared.setSyncState(key: "container.\(trashId).anchor", value: "1")
  let freshPage = [
    dto("known", parent: nil, name: encryptedName("known", "known.txt")),
    dto("bounded", parent: nil, name: encryptedName("bounded", "bounded.txt")),
  ]
  ApiClient.shared.listings["trashed:root"] = .failure(URLError(.timedOut))
  ApiClient.shared.scriptListings("trashed:root", [
    .init(delayNanoseconds: 150_000_000, result: .success(freshPage)),
    .init(delayNanoseconds: 10_000_000, result: .failure(URLError(.timedOut))),
    .init(delayNanoseconds: 150_000_000, result: .success(freshPage)),
    .init(delayNanoseconds: 10_000_000, result: .failure(URLError(.timedOut))),
    .init(delayNanoseconds: 150_000_000, result: .success(freshPage)),
    .init(delayNanoseconds: 10_000_000, result: .failure(URLError(.timedOut))),
  ])

  let enumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: SyncEngineContainerRefresher()
  )
  var anchor: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { anchor = $0 }
  let observer = ChangeObserver()
  enumerator.enumerateChanges(for: observer, from: anchor!)
  let firstStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 1 }
  check(firstStarted,
        "the bounded change refresh starts its first pass")

  let firstSuperseder = Task { await SyncEngine.refreshContainer(containerId: trashId) }
  let firstOutcome = await firstSuperseder.value
  check(firstOutcome == .serverUnreachable,
        "the first superseding pass fails without publishing")
  let secondStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 3 }
  check(secondStarted,
        "the change refresh starts its second pass")

  let secondSuperseder = Task { await SyncEngine.refreshContainer(containerId: trashId) }
  let secondOutcome = await secondSuperseder.value
  check(secondOutcome == .serverUnreachable,
        "the second superseding pass fails without publishing")
  let finalStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 5 }
  check(finalStarted,
        "the change refresh starts its final allowed pass")

  let thirdSuperseder = Task { await SyncEngine.refreshContainer(containerId: trashId) }
  let thirdOutcome = await thirdSuperseder.value
  check(thirdOutcome == .serverUnreachable,
        "the third superseding pass fails without publishing")
  let finished = await waitUntil { observer.error != nil || observer.finished != nil }
  check(finished && isProviderError(observer.error, .serverUnreachable),
        "an observer with no published replacement receives a retryable error")
  check(ApiClient.shared.count("list-trashed root") == 6,
        "three change passes and their superseders are the complete bounded listing set")
  check(CacheManager.shared.item(id: "trash:bounded") == nil,
        "no discarded response is mistaken for a published snapshot")
  try? await Task.sleep(nanoseconds: 100_000_000)
  check(ApiClient.shared.count("list-trashed root") == 6,
        "no listing continues after the retry bound is exhausted")
  enumerator.invalidate()
}

func permanentDeleteSignalQueuesANewerTrashRefresh() async {
  reset()
  NSFileProviderManager.resetRecords()
  CacheManager.shared.rows["trash:deleted"] = row("trash:deleted", parent: trashId, name: "delete me.txt")
  CacheManager.shared.setSyncState(key: "container.\(trashId).anchor", value: "1")
  let stalePage = [dto("deleted", parent: nil, name: encryptedName("deleted", "delete me.txt"))]
  ApiClient.shared.scriptListings("trashed:root", [
    .init(delayNanoseconds: 250_000_000, result: .success(stalePage)),
    .init(delayNanoseconds: 10_000_000, result: .success([])),
  ])

  let enumerator = FileProviderEnumerator(
    containerIdentifier: NSFileProviderItemIdentifier(trashId),
    cache: CacheManager.shared,
    refresher: SyncEngineContainerRefresher()
  )
  var anchor: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { anchor = $0 }

  // A prior signal is already listing the server when the permanent-delete signal arrives.
  let prior = ChangeObserver()
  enumerator.enumerateChanges(for: prior, from: anchor!)
  let priorStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 1 }
  check(priorStarted, "the pre-delete Trash refresh started")

  let deletion = ChangeObserver()
  enumerator.enumerateChanges(for: deletion, from: anchor!)
  let postDeleteStarted = await waitUntil { ApiClient.shared.count("list-trashed root") == 2 }
  check(postDeleteStarted, "a permanent-delete signal queues a listing that starts after the older one")
  let deletionFinished = await waitUntil { deletion.error != nil || deletion.finished != nil }
  check(deletionFinished && isProviderError(deletion.error, .syncAnchorExpired),
        "the permanent-delete observer reports the removed row")
  check(CacheManager.shared.item(id: "trash:deleted") == nil,
        "the post-delete listing prunes the namespaced Trash row")
  let priorFinished = await waitUntil { prior.error != nil || prior.finished != nil }
  check(priorFinished, "the older change observer also settles")
  enumerator.invalidate()
}

func firstSuccessfulListingSurvivesANewerFailure() async {
  reset()
  ApiClient.shared.scriptListings("F", [
    .init(delayNanoseconds: 150_000_000, result: .success([dto("one", parent: "F", name: "one.txt")])),
    .init(delayNanoseconds: 10_000_000, result: .failure(URLError(.timedOut))),
  ])
  let first = Task { await SyncEngine.refreshContainer(containerId: "F") }
  let firstStarted = await waitUntil { ApiClient.shared.count("list F") == 1 }
  check(firstStarted, "the first listing started")
  let newer = Task { await SyncEngine.refreshContainer(containerId: "F") }
  let newerOutcome = await newer.value
  let firstOutcome = await first.value
  check(newerOutcome == .serverUnreachable && firstOutcome == .success,
        "the newer failure is reported while the successful fallback remains usable")
  check(CacheManager.shared.children(parent: "F").map(\.id) == ["one"],
        "a never-listed folder is not left permanently empty")
  check(CacheManager.shared.syncState(key: "container.F.anchor") != nil,
        "the provisional first listing is marked as published")
}

func workingSetScenariosFinish() {
  check(softFailures == 0, "\(softFailures) working set check(s) failed")
}

// ---- SF-0002 part 1: the id a Files-app create mints is lowercase everywhere ----
// UUID().uuidString is uppercase. The extension seals the name and every chunk
// under deriveFileKey(fileId: Data(fileId.utf8)) while ApiClient posts
// fileId.lowercased() as file_id; a reader derives from the stored lowercase
// id and so never opens a file created this way. The id minted for a create must
// therefore be lowercase ONCE, and everything downstream must use that string.
func createMintsALowercaseFileIdUsedForDerivation() async {
  reset()
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  let template = Template("template", parent: "root", filename: "Notes.txt")
  let source = AppGroupContainer.directory("create-source").appendingPathComponent("Notes.txt")
  try! Data("hello from the Files app".utf8).write(to: source)

  let result: (NSFileProviderItem?, NSError?) = await withCheckedContinuation { continuation in
    _ = ext.createItem(basedOn: template, fields: [], contents: source, options: [],
                       request: NSFileProviderRequest()) { item, _, _, error in
      continuation.resume(returning: (item, error as NSError?))
    }
  }

  check(result.0 != nil && result.1 == nil, "createItem finished with an item and no error, got \(describe(result.1))")

  let bodyIds = ApiClient.shared.uploadInitFileIds
  check(bodyIds.count == 1, "exactly one upload-init, got \(bodyIds)")
  let bodyId = bodyIds.first ?? ""
  check(!bodyId.isEmpty, "the upload-init carries a file_id")
  check(bodyId == bodyId.lowercased(), "the upload-init file_id is lowercase, got \(bodyId)")

  let derived = MasterKeyHandle.derivedFileIds
  check(derived.count == 2, "the name and the single chunk each derive a file key, got \(derived)")
  check(derived.allSatisfy { $0 == $0.lowercased() }, "every deriveFileKey id is lowercase, got \(derived)")
  check(derived.allSatisfy { $0 == bodyId }, "every deriveFileKey id equals the upload-init file_id, got \(derived) vs \(bodyId)")

  check(result.0?.itemIdentifier.rawValue == bodyId, "the created item's identifier is that same id, got \(result.0?.itemIdentifier.rawValue ?? "nil")")
  check(result.0?.filename == "Notes.txt", "the created item keeps its name, got \(result.0?.filename ?? "nil")")
}

// ---- SF-0001 round 2 (mobile#259 review M3/M5): another item's echo ----
// The init answers with an id the extension did not propose: nothing is sealed
// or PUT under it, and the REQUESTED id's session is abandoned.
// Round 3: Files gets the dead end -2005 carrying the mismatch sentence. Round
// 2 chose -1000 on the premise that -2005 is retried; that was wrong. Apple's
// signalErrorResolved retries only -1000 / insufficientQuota / serverUnreachable,
// the app signals -1000 on every key provisioning, and Files shows -1000 as a
// false "Authentication Required" alert.
func createAbortsOnAnotherItemsEcho() async {
  reset()
  ApiClient.shared.initEchoOverride = "server-chosen-id"
  let result = await createItemFromFilesApp("Echo.txt", bytes: 64)
  let requested = ApiClient.shared.uploadInitFileIds.first ?? ""
  check(result.0 == nil, "a mismatched echo creates no item")
  check(isProviderError(result.1, .cannotSynchronize) && result.1?.localizedDescription == UploadItemIdEcho.message,
        "a mismatched echo is the dead-end -2005 with the mismatch sentence, got \(describe(result.1)) \(result.1?.localizedDescription ?? "")")
  check(ApiClient.shared.count("upload-chunk") == 0, "no chunk PUT after a mismatched echo, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.count("upload-complete") == 0, "no complete after a mismatched echo, got \(ApiClient.shared.calls)")
  check(!requested.isEmpty && ApiClient.shared.calls.contains("upload-abandon \(requested)"),
        "the REQUESTED id's session is abandoned, got \(ApiClient.shared.calls)")
  check(!ApiClient.shared.calls.contains("upload-abandon server-chosen-id"), "the echoed id is never touched")
  check(!MasterKeyHandle.derivedFileIds.contains("server-chosen-id"), "no key is derived for the echoed id, got \(MasterKeyHandle.derivedFileIds)")
}

// ---- A dropped chunk request is retried; a refused one is not ----
// Without a retry, one chunk PUT that timed out failed the whole create and
// Files restarted the upload from the first byte.
func createItemFromFilesApp(_ filename: String, bytes: Int) async -> (NSFileProviderItem?, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  let template = Template("template-\(filename)", parent: "root", filename: filename)
  let source = AppGroupContainer.directory("create-source").appendingPathComponent(filename)
  try! Data(repeating: 0x5A, count: bytes).write(to: source)
  return await withCheckedContinuation { continuation in
    _ = ext.createItem(basedOn: template, fields: [], contents: source, options: [],
                       request: NSFileProviderRequest()) { item, _, _, error in
      continuation.resume(returning: (item, error as NSError?))
    }
  }
}

func createRetriesADroppedChunkAndStopsOnARefusal() async {
  reset()
  ApiClient.shared.chunkFailures = [URLError(.timedOut)]
  let retried = await createItemFromFilesApp("Clip.mov", bytes: 1024)
  check(retried.0 != nil && retried.1 == nil, "a timed-out chunk: the create still finishes, got \(describe(retried.1))")
  check(ApiClient.shared.count("upload-chunk 0") == 2, "a timed-out chunk is sent again, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.count("upload-init") == 1, "a timed-out chunk does not restart the upload, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.count("upload-complete") == 1, "a timed-out chunk: the upload completes once, got \(ApiClient.shared.calls)")

  // Task 260 (P2-3): a chunk attempt gives up on its OWN deadline, not on the
  // session's 60 s request timeout, and one chunk's attempts stay inside
  // the chunk budget. A whole upload stuck here used to cost ~247 s
  // (4 x 60 s + 1+2+4 s backoff) and got the extension killed with no retry.
  let timeouts = ApiClient.shared.chunkTimeouts
  check(!timeouts.isEmpty, "a chunk attempt names its own timeout, got none")
  check(timeouts.allSatisfy { $0 > 0 && $0 <= FileProviderExtension.chunkAttemptTimeout },
        "every chunk attempt times out within \(FileProviderExtension.chunkAttemptTimeout) s, got \(timeouts)")
  check(FileProviderExtension.chunkRetryBudget <= 20 && FileProviderExtension.chunkRetryBudget < 30,
        "one chunk's total budget stays under 30 s, got \(FileProviderExtension.chunkRetryBudget)")
  check(FileProviderExtension.chunkAttemptTimeout < FileProviderExtension.chunkRetryBudget,
        "an attempt is shorter than the whole chunk budget, got \(FileProviderExtension.chunkAttemptTimeout) vs \(FileProviderExtension.chunkRetryBudget)")
  check(FileProviderExtension.chunkRetryBudget < 60,
        "one chunk's whole budget is under a single inherited 60 s request timeout, got \(FileProviderExtension.chunkRetryBudget)")

  // A fast reset (connection dropped, not a hang) is retried at once: the
  // budget must not be spent waiting on an attempt that already failed.
  reset()
  ApiClient.shared.chunkFailures = [URLError(.networkConnectionLost)]
  let reset0 = await createItemFromFilesApp("Reset.mov", bytes: 1024)
  check(reset0.0 != nil && reset0.1 == nil, "a reset chunk: the create still finishes, got \(describe(reset0.1))")
  check(ApiClient.shared.count("upload-chunk 0") == 2, "a chunk reset by the peer is sent again, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.chunkTimeouts.count == 2 && ApiClient.shared.chunkTimeouts.allSatisfy { $0 <= FileProviderExtension.chunkAttemptTimeout },
        "the retried attempt carries its own timeout too, got \(ApiClient.shared.chunkTimeouts)")

  reset()
  ApiClient.shared.chunkFailures = [ApiError.statusCode(400)]
  let refused = await createItemFromFilesApp("Refused.mov", bytes: 1024)
  check(refused.0 == nil && refused.1 != nil, "a refused chunk (400): the create fails")
  check(ApiClient.shared.count("upload-chunk 0") == 1, "a refused chunk is not sent again, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.count("upload-complete") == 0, "a refused chunk: nothing is completed, got \(ApiClient.shared.calls)")

  for status in [408, 425] {
    reset()
    ApiClient.shared.chunkFailures = [ApiError.statusCode(status)]
    let retriedStatus = await createItemFromFilesApp("Retry-\(status).mov", bytes: 1024)
    check(retriedStatus.0 != nil && retriedStatus.1 == nil, "HTTP \(status) retries the chunk")
    check(ApiClient.shared.count("upload-chunk 0") == 2, "HTTP \(status) sends the chunk again")
  }
}

func uploadSessionLossRestartsWithoutDeletingTheLiveItem() async {
  reset()
  ApiClient.shared.chunkFailures = [ApiError.uploadSessionUnavailable]
  let restartedChunk = await createItemFromFilesApp("Restart chunk.mov", bytes: 1024)
  check(restartedChunk.0 != nil && restartedChunk.1 == nil, "a vanished session during a chunk starts a fresh upload")
  check(ApiClient.shared.count("upload-init") == 2, "the vanished chunk session is initialized again")
  check(ApiClient.shared.count("upload-chunk 0") == 2 && ApiClient.shared.count("upload-complete") == 1,
        "the new session uploads from the beginning and completes")
  let chunkCalls = ApiClient.shared.calls
  check(ApiClient.shared.count("upload-abandon-for-restart") == 1
          && chunkCalls.firstIndex(where: { $0.hasPrefix("upload-abandon-for-restart") })!
            < chunkCalls.lastIndex(where: { $0.hasPrefix("upload-init") })!,
        "the vanished chunk session is abandoned before re-init")
  check(ApiClient.shared.serverFileRows.count == 1,
        "the restarted chunk upload leaves exactly one server row")

  reset()
  ApiClient.shared.completeFailures = [ApiError.uploadSessionUnavailable]
  let restartedComplete = await createItemFromFilesApp("Restart complete.mov", bytes: 1024)
  check(restartedComplete.0 != nil && restartedComplete.1 == nil, "a vanished session during complete starts a fresh upload")
  check(ApiClient.shared.count("upload-init") == 2 && ApiClient.shared.count("upload-chunk 0") == 2,
        "completion loss restarts the whole encrypted stream")
  check(ApiClient.shared.count("upload-complete") == 2, "completion is retried only with the fresh session")
  let completeCalls = ApiClient.shared.calls
  check(ApiClient.shared.count("upload-abandon-for-restart") == 1
          && completeCalls.firstIndex(where: { $0.hasPrefix("upload-abandon-for-restart") })!
            < completeCalls.lastIndex(where: { $0.hasPrefix("upload-init") })!,
        "the complete-404 session is abandoned before re-init")
  check(ApiClient.shared.serverFileRows.count == 1,
        "a complete-404 restart leaves exactly one live server row")

  reset()
  ApiClient.shared.initFailures = [ApiError.retryableConflict]
  let busy = await createItemFromFilesApp("Busy.mov", bytes: 1024)
  check(busy.0 == nil && isProviderError(busy.1, .serverUnreachable),
        "a live upload lease is retryable, not a permanent conflict")

  check(isProviderError(FileProviderExtension.mapError(ApiError.uploadSessionUnavailable) as NSError, .serverUnreachable),
        "an exhausted session restart never tells Files that its live item disappeared")
}

func idempotentUploadCompletionUsesKnownMetadata() async {
  reset()
  ApiClient.shared.completeAsIdempotentRetry = true
  let created = await createItemFromFilesApp("Retried.raw", bytes: 4096)
  check(created.1 == nil && created.0 != nil, "an id-only idempotent completion still finishes, got \(describe(created.1))")
  check((created.0?.documentSize ?? nil)?.intValue == 4096, "known plaintext size fills the abbreviated completion response")
  check(ApiClient.shared.count("upload-complete") == 1, "completion was sent once")
}

// ---- Files kept showing items deleted elsewhere: the background refresh was cancelled ----
// iOS invalidates an enumerator right after enumerateItems. The refresh that prunes rows deleted on the
// server used to be cancelled with it (NSURLError -999), so the cache was never reconciled. Only the
// first-load path, which still has to answer the observer, may be cancelled by invalidate().
final class CancellationAwareRefresher: FileProviderContainerRefreshing, @unchecked Sendable {
  private let lock = NSLock()
  private var started = 0, finished = 0, running = 0, maxRunning = 0, sawCancel = false
  var delayNanos: UInt64 = 150_000_000
  var startedCount: Int { lock.lock(); defer { lock.unlock() }; return started }
  var finishedCount: Int { lock.lock(); defer { lock.unlock() }; return finished }
  var maxConcurrent: Int { lock.lock(); defer { lock.unlock() }; return maxRunning }
  var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return sawCancel }
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome {
    lock.lock(); started += 1; running += 1; maxRunning = max(maxRunning, running); lock.unlock()
    try? await Task.sleep(nanoseconds: delayNanos)
    // A cancelled URLSession request fails with -999 and never reaches the cache.
    let wasCancelled = Task.isCancelled
    let outcome: FileProviderRefreshOutcome = wasCancelled ? .serverUnreachable : await SyncEngine.refreshContainer(containerId: containerId)
    lock.lock(); running -= 1; finished += 1; if wasCancelled { sawCancel = true }; lock.unlock()
    return outcome
  }
  func refreshMaterializedContainers() async {}
}

func enumerateOnce(_ enumerator: FileProviderEnumerator, wait: Bool = true) async -> ListingObserver {
  let observer = ListingObserver()
  enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
  if wait {
    let done = await withCheckedContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(returning: observer.wait()) }
    }
    check(done, "enumeration finished")
  }
  return observer
}

func backgroundRefreshSurvivesInvalidate() async {
  reset()
  CacheManager.shared.rows["keep"] = row("keep", name: "keep.txt")
  CacheManager.shared.rows["gone"] = row("gone", name: "gone.txt")
  ApiClient.shared.listings["root"] = .success([dto("keep", parent: nil, name: "keep.txt")])
  let refresher = CancellationAwareRefresher()
  let enumerator = FileProviderEnumerator(containerIdentifier: .rootContainer, cache: CacheManager.shared, refresher: refresher)
  let first = await enumerateOnce(enumerator)
  // The location's root also carries the read-only Trash folder; it is not a cached row.
  let firstNames = first.items.map(\.filename).filter { $0 != "Beebeeb Trash" }.sorted()
  check(firstNames == ["gone.txt", "keep.txt"], "the cached listing is shown first, got \(firstNames)")
  enumerator.invalidate()
  let settled1 = await waitUntil { refresher.finishedCount == 1 }
  check(settled1, "the refresh finished after invalidate()")
  check(!refresher.cancelled, "invalidate() did not cancel the background refresh")
  check(CacheManager.shared.item(id: "gone") == nil, "a row deleted on the server is gone from the cache after enumeration")
  check(CacheManager.shared.item(id: "keep") != nil, "a row still on the server stays")
  check(ApiClient.shared.count("list root") == 1, "the server was listed once, got \(ApiClient.shared.calls)")
}

func backgroundRefreshesAreCoalescedPerContainer() async {
  reset()
  CacheManager.shared.rows["keep"] = row("keep", name: "keep.txt")
  ApiClient.shared.listings["root"] = .success([dto("keep", parent: nil, name: "keep.txt")])
  let refresher = CancellationAwareRefresher()
  for _ in 0..<5 {
    let enumerator = FileProviderEnumerator(containerIdentifier: .rootContainer, cache: CacheManager.shared, refresher: refresher)
    _ = await enumerateOnce(enumerator)
    enumerator.invalidate()
  }
  let settled2 = await waitUntil { refresher.startedCount >= 1 && refresher.startedCount == refresher.finishedCount }
  check(settled2, "the refreshes settled")
  try? await Task.sleep(nanoseconds: 400_000_000)
  check(refresher.maxConcurrent == 1, "at most one refresh per container is in flight, got \(refresher.maxConcurrent)")
  check(refresher.startedCount <= 2, "five enumerations start at most two refreshes (one running, one queued), got \(refresher.startedCount)")
  check(!refresher.cancelled, "no coalesced refresh was cancelled")
}

func firstLoadStaysCancellable() async {
  reset()
  ApiClient.shared.listings["root"] = .success([dto("a", parent: nil, name: "a.txt")])
  let refresher = CancellationAwareRefresher()
  let enumerator = FileProviderEnumerator(containerIdentifier: .rootContainer, cache: CacheManager.shared, refresher: refresher)
  let observer = await enumerateOnce(enumerator, wait: false)
  enumerator.invalidate()
  let settled3 = await waitUntil { refresher.finishedCount == 1 }
  check(settled3, "the first-load refresh ended")
  check(refresher.cancelled, "invalidate() cancels the first-load refresh, which still has to answer the observer")
  check(CacheManager.shared.item(id: "a") == nil, "a cancelled first load writes nothing")
  check(observer.items.isEmpty, "a cancelled first load vends nothing")
}

// ---- The root "Backups" folder is protected in the Files app ----
// The app publishes the folder's id through sync_state; the extension offers no delete, rename or
// move for it and refuses those calls if Files sends them anyway. Items inside stay manageable.
func deleteReturning(_ id: String) async -> NSError? {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    _ = ext.deleteItem(identifier: NSFileProviderItemIdentifier(id), baseVersion: NSFileProviderItemVersion(), options: [],
                       request: NSFileProviderRequest()) { error in continuation.resume(returning: error as NSError?) }
  }
}

func backupsRootIsProtected() async {
  let guarded: NSFileProviderItemCapabilities = [.allowsDeleting, .allowsRenaming, .allowsReparenting]
  func seed() {
    reset()
    CacheManager.shared.rows["B"] = row("B", name: "Backups", folder: true)
    CacheManager.shared.rows["D"] = row("D", parent: "B", name: "Camera Roll", folder: true)
    CacheManager.shared.rows["x"] = row("x", parent: "B", name: "notes.txt")
    CacheManager.shared.rows["other"] = row("other", name: "Taxes", folder: true)
    CacheManager.shared.setSyncState(key: FileProviderItem.protectedBackupsRootKey, value: "b")
  }

  seed()
  let rootCaps = FileProviderItem(cached: CacheManager.shared.rows["B"]!).capabilities
  check(rootCaps.isDisjoint(with: guarded), "the Backups root offers no delete, rename or move, got \(rootCaps.rawValue)")
  check(rootCaps.contains(.allowsContentEnumerating) && rootCaps.contains(.allowsAddingSubItems), "the Backups root can still be opened and filled")
  check(!rootCaps.contains(.allowsTrashing), "the Backups root offers no trashing")
  for id in ["D", "x", "other"] {
    let caps = FileProviderItem(cached: CacheManager.shared.rows[id]!).capabilities
    check(caps.isSuperset(of: guarded), "\(id) keeps delete, rename and move, got \(caps.rawValue)")
  }
  let protectedVersion = FileProviderItem(cached: CacheManager.shared.rows["B"]!).itemVersion.metadataVersion
  CacheManager.shared.state = [:]
  check(FileProviderItem(cached: CacheManager.shared.rows["B"]!).itemVersion.metadataVersion != protectedVersion,
        "protecting the folder changes its item version, so Files re-reads its capabilities")

  seed()
  let deleteError = await deleteReturning("B")
  check(isProviderError(deleteError, .deletionRejected), "deleting the Backups root is refused with deletionRejected, got \(describe(deleteError))")
  check(ApiClient.shared.count("delete") == 0, "a refused delete sends nothing to the server, got \(ApiClient.shared.calls)")
  check(CacheManager.shared.item(id: "B") != nil, "a refused delete keeps the cache row")

  let renameResult = await modifyReturningPending(Template("B", parent: NSFileProviderItemIdentifier.rootContainer.rawValue, filename: "Archive"), [.filename])
  check(renameResult.2 != nil && renameResult.0 == nil, "renaming the Backups root is refused, got \(describe(renameResult.2))")
  let moveResult = await modifyReturningPending(Template("B", parent: "other", filename: "Backups"), [.parentItemIdentifier])
  check(moveResult.2 != nil && moveResult.0 == nil, "moving the Backups root is refused, got \(describe(moveResult.2))")
  check(ApiClient.shared.count("patch") == 0, "refused rename and move send nothing to the server, got \(ApiClient.shared.calls)")
  let touch = await modifyReturningPending(Template("B", parent: NSFileProviderItemIdentifier.rootContainer.rawValue, filename: "Backups"), [.lastUsedDate])
  check(touch.2 == nil, "a change Beebeeb does not store (lastUsedDate) is not an error, got \(describe(touch.2))")

  let insideDelete = await deleteReturning("D")
  check(insideDelete == nil && ApiClient.shared.count("delete D") == 1, "items inside Backups can be deleted, got \(describe(insideDelete)) \(ApiClient.shared.calls)")
  let insideRename = await modifyReturningPending(Template("x", parent: "B", filename: "renamed.txt"), [.filename])
  check(insideRename.2 == nil && ApiClient.shared.count("patch x") == 1, "items inside Backups can be renamed, got \(describe(insideRename.2)) \(ApiClient.shared.calls)")

  // Sign-out clears sync_state with the rest of the cache: nothing stays protected.
  CacheManager.shared.state = [:]
  let afterSignOut = FileProviderItem(cached: CacheManager.shared.rows["B"]!).capabilities
  check(afterSignOut.isSuperset(of: guarded), "after sign-out the id is forgotten, got \(afterSignOut.rawValue)")
}


// ---- Files app: authentication recovery, badge sources, read-only Trash ----
let authFlagKey = "files.authRequiredAt"
let trashId = "io.beebeeb.trash"

func flagIsRecent() -> Bool {
  guard let raw = CacheManager.shared.syncState(key: authFlagKey), let at = Double(raw) else { return false }
  return abs(Date().timeIntervalSince1970 - at) < 10
}

func dtoUpdated(_ id: String, parent: String?, name: String?, folder: Bool = false, updated: String) -> ApiClient.FileEntryDto {
  ApiClient.FileEntryDto(id: id, parent_id: parent, name_encrypted: name, name_nonce: nil, mime_type: folder ? nil : "text/plain",
                         size_bytes: folder ? 0 : 5, is_folder: folder, chunk_count: 1, created_at: nil, updated_at: updated)
}

// Files reports "Authentication Required" for a listing that ends -1000. The app opens from
// that button and must know why: the extension records when it reported the error.
func notAuthenticatedRecordsAFlagAndRecoveryEndsClean() async {
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  ApiClient.shared.listings["F"] = .success([
    dto("c1", parent: "F", name: encryptedName("c1", "Taxes"), folder: true),
    dto("c3", parent: "F", name: encryptedName("c3", "notes.txt")),
  ])
  check(CacheManager.shared.syncState(key: authFlagKey) == nil, "no flag before anything failed")
  let refused = await list("F")
  check(isProviderError(refused.error, .notAuthenticated), "no key: -1000, got \(describe(refused.error))")
  check(flagIsRecent(), "the -1000 listing records a timestamp, got \(CacheManager.shared.syncState(key: authFlagKey) ?? "nil")")

  // A content fetch that ends -1000 records it as well.
  reset()
  CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.notFound)
  let (_, fetchError) = await fetch("f1")
  check(isProviderError(fetchError, .notAuthenticated), "fetch without key: -1000, got \(describe(fetchError))")
  check(flagIsRecent(), "a -1000 fetch records the flag")

  // A listing that works records nothing.
  reset()
  ApiClient.shared.listings["F"] = .success([dto("c3", parent: "F", name: encryptedName("c3", "notes.txt"))])
  let fine = await list("F")
  check(fine.error == nil && fine.items.count == 1, "a healthy listing succeeds")
  check(CacheManager.shared.syncState(key: authFlagKey) == nil, "a healthy listing records no flag")

  // Recovery: the same folder, key now available. The listing succeeds and carries no error.
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  ApiClient.shared.listings["F"] = .success([
    dto("c1", parent: "F", name: encryptedName("c1", "Taxes"), folder: true),
    dto("c3", parent: "F", name: encryptedName("c3", "notes.txt")),
  ])
  _ = await list("F")
  BeebeebKeychainCore.keyResult = .success(BeebeebKeychainCore.goodKey)
  let recovered = await list("F")
  check(recovered.error == nil, "after recovery the listing ends without an error, got \(describe(recovered.error))")
  check(recovered.items.map(\.filename).sorted() == ["Taxes", "notes.txt"], "after recovery the real names are listed, got \(recovered.items.map(\.filename))")
  check(flagIsRecent(), "the flag stays until the app has handled it (the app clears it)")
}

// The working set is not a place the user opens. A -1000 there is what leaves the blue
// sync-problem badge on the Beebeeb location, with no folder to show "Open Beebeeb" in.
func workingSetNeverCarriesAnAuthenticationError() async {
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  ApiClient.shared.listings["root"] = .success([dto("c1", parent: nil, name: encryptedName("c1", "Taxes"), folder: true)])
  let ws = await list(NSFileProviderItemIdentifier.workingSet.rawValue)
  check(ws.error == nil, "the working set finishes without an error, got \(describe(ws.error))")
  check(ws.items.isEmpty, "the working set vends nothing it cannot name, got \(ws.items.map(\.filename))")
  check(flagIsRecent(), "the working set still records that authentication is needed")
  // The root folder, which the user does open, still shows Authentication Required.
  let root = await list(NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(isProviderError(root.error, .notAuthenticated), "the root folder still ends -1000, got \(describe(root.error))")
}

// Errors Files treats as a dead end leave the red/blue badge on an item until the user removes it.
// Anything transient must be reported as something Files retries; a cancellation is not a failure.
func transientFailuresAreRetryableNotDeadEnds() async {
  let transient: [(String, Error)] = [
    ("timed out", URLError(.timedOut)),
    ("offline", URLError(.notConnectedToInternet)),
    ("connection lost", URLError(.networkConnectionLost)),
    ("cannot connect", URLError(.cannotConnectToHost)),
  ]
  for (label, failure) in transient {
    let mapped = FileProviderExtension.mapError(failure) as NSError
    check(isProviderError(mapped, .serverUnreachable), "\(label): retryable -1004, got \(describe(mapped))")
  }
  for (label, failure) in [("URLError.cancelled", URLError(.cancelled) as Error), ("CancellationError", CancellationError() as Error)] {
    let mapped = FileProviderExtension.mapError(failure) as NSError
    check(mapped.domain == NSCocoaErrorDomain && mapped.code == NSUserCancelledError, "\(label): a cancellation, not a sync error, got \(describe(mapped))")
  }
  check(isProviderError(FileProviderExtension.mapError(CryptoBridge.CryptoBridgeError.decodeFailed) as NSError, .cannotSynchronize),
        "an error nobody can retry past is still -2005")

  for code in [408, 425, 429, 500, 503] {
    check(isProviderError(FileProviderExtension.mapError(ApiError.statusCode(code)) as NSError, .serverUnreachable),
          "HTTP \(code) is retryable")
  }
  for code in [400, 403, 409, 413, 422] {
    let mapped = FileProviderExtension.mapError(ApiError.statusCode(code)) as NSError
    check(isProviderError(mapped, .cannotSynchronize) && !mapped.localizedDescription.isEmpty,
          "HTTP \(code) is a described, non-retryable refusal")
  }
  check(isProviderError(FileProviderExtension.mapError(ApiError.statusCode(404)) as NSError, .noSuchItem),
        "HTTP 404 is noSuchItem so Files can rebuild a missing parent")
  check(isProviderError(FileProviderExtension.mapError(ApiError.quotaExceeded) as NSError, .insufficientQuota),
        "a typed server quota refusal is insufficientQuota")

  for (label, failure) in [("bad URL", URLError(.badURL)), ("refused TLS", URLError(.serverCertificateUntrusted))] {
    check(isProviderError(FileProviderExtension.mapError(failure) as NSError, .cannotSynchronize), "\(label) is not retried forever, -2005")
  }
  reset()
  CacheManager.shared.rows["f1"] = row("f1", name: "notes.txt", size: 5)
  ApiClient.shared.downloadResult = .failure(URLError(.timedOut))
  let (_, fetchError) = await fetch("f1")
  check(isProviderError(fetchError, .serverUnreachable), "a timed-out download is retryable, got \(describe(fetchError))")
}

// ---- Trash ----
func trashFolderIsListedAtTheTopAndIsReadOnly() async {
  let readOnlyFolder: NSFileProviderItemCapabilities = [.allowsContentEnumerating, .allowsAddingSubItems]
  reset()
  CacheManager.shared.rows["keep"] = row("keep", name: "keep.txt")
  ApiClient.shared.listings["root"] = .success([dto("keep", parent: nil, name: "keep.txt")])
  let root = await list(NSFileProviderItemIdentifier.rootContainer.rawValue)
  let names = root.items.map(\.filename).sorted()
  check(names == ["Beebeeb Trash", "keep.txt"], "root lists the files and a uniquely named Trash folder, got \(names)")
  let trash = root.items.first { $0.filename == "Beebeeb Trash" }!
  check(trash.itemIdentifier.rawValue == trashId && trash.parentItemIdentifier == .rootContainer, "Trash sits at the top of the location")
  check(trash.contentType == .folder, "Trash is a folder")
  check((trash.capabilities ?? []) == readOnlyFolder, "Trash can be opened, with no rename, move or delete, got \(trash.capabilities?.rawValue ?? 0)")

  let (looked, lookError) = await lookup(NSFileProviderItemIdentifier(trashId))
  check(lookError == nil && looked?.filename == "Beebeeb Trash", "item(for: Trash) answers with the folder, got \(describe(lookError))")
  check((looked?.capabilities ?? []) == readOnlyFolder, "the looked-up Trash is read-only")

  // The system trash container stays unsupported (a different thing).
  let (system, systemError) = await lookup(.trashContainer)
  check(system == nil && isFeatureUnsupported(systemError), "the system trash container is still unsupported")

  // The synthetic folder remains in the working set so existing installs can discover it;
  // only the folder is present, never any trash: content row.
  let ws = await list(NSFileProviderItemIdentifier.workingSet.rawValue)
  check(ws.items.contains { $0.itemIdentifier.rawValue == trashId }
          && !ws.items.contains { $0.itemIdentifier.rawValue.hasPrefix("trash:") },
        "the working set includes the Trash folder but no trashed contents")
  // Let the working-set's independent, rate-limited Trash refresh finish before
  // resetting this process-wide harness for the explicit Trash listing below.
  _ = await waitUntil { NSFileProviderManager.signals.contains(trashId) }

  // Its listing: trashed items, real names, ids that cannot be mistaken for live ones.
  reset()
  ApiClient.shared.listings["trashed:root"] = .success([
    dtoUpdated("t1", parent: nil, name: encryptedName("t1", "old.txt"), updated: "2026-10-01T00:00:00Z"),
    dtoUpdated("t2", parent: nil, name: encryptedName("t2", "Old folder"), folder: true, updated: "2026-10-02T00:00:00Z"),
    dtoUpdated("t3", parent: "t2", name: encryptedName("t3", "inside.txt"), updated: "2026-10-02T00:00:00Z"),
    dtoUpdated("t4", parent: "live-folder", name: encryptedName("t4", "trashed-from-live.txt"), updated: "2026-10-03T00:00:00Z"),
  ])
  let listed = await list(trashId)
  check(listed.error == nil, "Trash lists without error, got \(describe(listed.error))")
  check(!ApiClient.shared.calls.isEmpty && ApiClient.shared.calls.allSatisfy { $0 == "list-trashed root" }, "Trash asks the server for the trashed listing only, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.listLimits.compactMap { $0 }.last == 500, "Trash root caps the server listing at 500 rows")
  check(listed.items.map(\.filename).sorted() == ["Old folder", "old.txt", "trashed-from-live.txt"],
        "Trash includes a file trashed from a live folder but hides descendants of trashed folders, got \(listed.items.map(\.filename))")
  for item in listed.items {
    check(item.itemIdentifier.rawValue.hasPrefix("trash:"), "\(item.filename): Trash ids are their own namespace, got \(item.itemIdentifier.rawValue)")
    check(item.parentItemIdentifier.rawValue == trashId, "\(item.filename): its parent is Trash")
    let caps = item.capabilities ?? []
    let expected: NSFileProviderItemCapabilities = item.contentType == .folder ? [.allowsContentEnumerating, .allowsAddingSubItems] : [.allowsReading, .allowsWriting]
    check(caps == expected, "\(item.filename): read-only capabilities, got \(caps.rawValue)")
  }
  check(CacheManager.shared.item(id: "t1") == nil && CacheManager.shared.item(id: "t2") == nil, "no live row is created for a trashed item")

  // A trashed folder opens and lists its own contents.
  ApiClient.shared.listings["trashed:t2"] = .success([
    dtoUpdated("t3", parent: nil, name: encryptedName("t3", "inside.txt"), updated: "2026-10-02T00:00:00Z"),
  ])
  let inside = await list("trash:t2")
  check(inside.error == nil && inside.items.map(\.filename) == ["inside.txt"], "a trashed folder lists its contents, got \(inside.items.map(\.filename)) \(describe(inside.error))")
  check(ApiClient.shared.count("list-trashed t2") == 1, "it goes through the trashed listing of that folder, got \(ApiClient.shared.calls)")
  check(inside.items.first?.parentItemIdentifier.rawValue == "trash:t2", "and its parent is the trashed folder")

  // Opening a trashed file downloads the real id and derives its keys from it.
  MasterKeyHandle.derivedFileIds = []
  ApiClient.shared.downloadResult = .failure(ApiError.statusCode(503))
  _ = await fetch("trash:t1")
  check(ApiClient.shared.count("download t1") == 1, "a trashed file is downloaded by its server id, got \(ApiClient.shared.calls)")

  // The server may refuse the download of a trashed file: say what to do instead of a generic failure.
  for code in [403, 404, 409, 410] {
    ApiClient.shared.downloadResult = .failure(ApiError.statusCode(code))
    let (_, refused) = await fetch("trash:t1")
    check(refused?.localizedDescription == "Restore it in the Beebeeb app to open it.", "HTTP \(code) on a trashed file explains how to open it, got \(refused?.localizedDescription ?? "nil")")
  }
  ApiClient.shared.downloadResult = .failure(ApiError.statusCode(503))
  let (_, outage) = await fetch("trash:t1")
  check(isProviderError(outage, .serverUnreachable), "a server outage on a trashed file is still retryable, got \(describe(outage))")
  ApiClient.shared.downloadResult = .failure(ApiError.statusCode(404))
  CacheManager.shared.rows["live1"] = row("live1", name: "live.txt", size: 5)
  let (_, liveMissing) = await fetch("live1")
  check(liveMissing?.localizedDescription != "Restore it in the Beebeeb app to open it.", "the message is for trashed items only")

  // Restored on the server: the next listing drops it.
  ApiClient.shared.listings["trashed:root"] = .success([
    dtoUpdated("t2", parent: nil, name: encryptedName("t2", "Old folder"), folder: true, updated: "2026-10-02T00:00:00Z"),
  ])
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  check(CacheManager.shared.item(id: "trash:t1") == nil && CacheManager.shared.item(id: "trash:t2") != nil, "a restored item leaves Trash on the next listing")

  // If the folder itself is later restored/purged, its nested cached names are unreachable and
  // must leave the shared cache with it, even if that folder is never opened again.
  ApiClient.shared.listings["trashed:root"] = .success([])
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  check(CacheManager.shared.item(id: "trash:t2") == nil && CacheManager.shared.item(id: "trash:t3") == nil, "restoring a trashed folder prunes its nested cached rows")
}

func nothingCanBeWrittenInsideTrash() async {
  func seed() {
    reset()
    CacheManager.shared.rows["trash:t1"] = row("trash:t1", parent: trashId, name: "old.txt")
    CacheManager.shared.rows["trash:t2"] = row("trash:t2", parent: trashId, name: "Old folder", folder: true)
    CacheManager.shared.rows["live"] = row("live", name: "live.txt")
  }
  seed()
  for id in ["trash:t1", "trash:t2", trashId] {
    let error = await deleteReturning(id)
    check(isProviderError(error, .deletionRejected), "deleting \(id) is refused, got \(describe(error))")
    let rejected = error?.userInfo[NSFileProviderErrorItemKey] as? NSFileProviderItem
    check(rejected?.itemIdentifier.rawValue == id,
          "deletionRejected for \(id) identifies the current item so Files can restore it")
  }
  check(ApiClient.shared.count("delete") == 0, "refused deletes send nothing, got \(ApiClient.shared.calls)")

  let rename = await modifyOutcome(Template("trash:t1", parent: trashId, filename: "new.txt"), [.filename])
  check(rename.0?.filename == "old.txt" && rename.1.isEmpty && rename.3 == nil,
        "renaming in Trash returns current metadata and settles, got \(describe(rename.3))")
  let moveOut = await modifyOutcome(Template("trash:t1", parent: NSFileProviderItemIdentifier.rootContainer.rawValue, filename: "old.txt"), [.parentItemIdentifier])
  check(moveOut.0?.parentItemIdentifier.rawValue == trashId && moveOut.1.isEmpty && moveOut.3 == nil,
        "moving out of Trash restores the current parent and settles, got \(describe(moveOut.3))")
  let moveIn = await modifyOutcome(Template("live", parent: trashId, filename: "live.txt"), [.parentItemIdentifier])
  check(moveIn.0?.parentItemIdentifier == .rootContainer && moveIn.1.isEmpty && moveIn.3 == nil,
        "moving a live item into Trash restores its current parent and settles, got \(describe(moveIn.3))")
  let moveInFolder = await modifyOutcome(Template("live", parent: "trash:t2", filename: "live.txt"), [.parentItemIdentifier])
  check(moveInFolder.0?.parentItemIdentifier == .rootContainer && moveInFolder.1.isEmpty && moveInFolder.3 == nil,
        "moving into a trashed folder restores the current parent and settles, got \(describe(moveInFolder.3))")
  let content = await modifyOutcome(Template("trash:t1", parent: trashId, filename: "old.txt"), [.contents])
  check(content.0 == nil && !content.2 && isProviderError(content.3, .cannotSynchronize),
        "changing Trash content is parked without replacing the user's local bytes, got \(describe(content.3))")
  check(content.3?.localizedDescription == "Trash is read-only in Files. Copy the edited file elsewhere to keep your changes.",
        "the parked edit explains how to preserve the local copy")
  check(ApiClient.shared.count("patch") == 0 && ApiClient.shared.count("upload") == 0, "refused writes send nothing, got \(ApiClient.shared.calls)")

  for parent in [trashId, "trash:t2"] {
    let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
    let source = AppGroupContainer.directory("create-source").appendingPathComponent("into-trash.txt")
    try! Data(repeating: 0x41, count: 16).write(to: source)
    let created: (NSFileProviderItem?, NSError?) = await withCheckedContinuation { continuation in
      _ = ext.createItem(basedOn: Template("new-item", parent: parent, filename: "into-trash.txt"), fields: [], contents: source, options: [],
                         request: NSFileProviderRequest()) { item, _, _, error in continuation.resume(returning: (item, error as NSError?)) }
    }
    check(created.0 == nil && created.1 != nil, "creating inside \(parent) is refused, got \(describe(created.1))")
  }
  check(ApiClient.shared.count("upload") == 0, "a refused create uploads nothing, got \(ApiClient.shared.calls)")
  check(CacheManager.shared.rows["live"] != nil && CacheManager.shared.writes.isEmpty, "refused writes leave the cache alone")

  // Live items outside Trash are unaffected.
  let ok = await deleteReturning("live")
  check(ok == nil && ApiClient.shared.count("delete live") == 1, "a live item can still be deleted, got \(describe(ok))")
}

func trashedItemsStayOutOfEverythingElse() async {
  reset()
  // Live tree, plus rows of a trashed folder Files had listed before it was trashed on the web.
  CacheManager.shared.rows["F"] = row("F", name: "Taxes", folder: true)
  CacheManager.shared.rows["c1"] = row("c1", parent: "F", name: "2026 return.pdf")
  CacheManager.shared.rows["keep"] = row("keep", name: "keep.txt")
  CacheManager.shared.rows["trash:t1"] = row("trash:t1", parent: trashId, name: "old.txt")
  CacheManager.shared.rows["trash:t2"] = row("trash:t2", parent: trashId, name: "Old folder", folder: true)
  CacheManager.shared.rows["trash:t3"] = row("trash:t3", parent: "trash:t2", name: "inside.txt")
  CacheManager.shared.materialized = ["F", "trash:t2", trashId]
  ApiClient.shared.listings["root"] = .success([dto("keep", parent: nil, name: "keep.txt"), dto("F", parent: nil, name: "Taxes", folder: true)])

  let ws = await list(NSFileProviderItemIdentifier.workingSet.rawValue)
  let wsNames = ws.items.map(\.filename).sorted()
  check(!wsNames.contains("old.txt") && !wsNames.contains("Old folder") && !wsNames.contains("inside.txt") && wsNames.contains("Beebeeb Trash"),
        "the working set carries the synthetic Trash folder but none of its contents, got \(wsNames)")
  check(wsNames.contains("2026 return.pdf") && wsNames.contains("keep.txt"), "but still the live tree, got \(wsNames)")

  let root = await list(NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(!root.items.map(\.filename).contains("old.txt"), "the root folder lists no trashed file, got \(root.items.map(\.filename))")

  // The folder is trashed on the web: the root listing drops it. Its children must go with it.
  ApiClient.shared.listings["root"] = .success([dto("keep", parent: nil, name: "keep.txt")])
  _ = await SyncEngine.refreshContainer(containerId: BeebeebConstants.rootContainerIdentifier)
  check(CacheManager.shared.item(id: "F") == nil, "setup: the trashed folder left the cache")
  let after = await list(NSFileProviderItemIdentifier.workingSet.rawValue)
  let afterNames = after.items.map(\.filename).sorted()
  check(!afterNames.contains("2026 return.pdf"), "children of a folder trashed elsewhere leave the working set, got \(afterNames)")
  check(afterNames.contains("keep.txt"), "the live tree stays, got \(afterNames)")
}


final class FolderTemplate: NSObject, NSFileProviderItem {
  let itemIdentifier: NSFileProviderItemIdentifier
  let parentItemIdentifier: NSFileProviderItemIdentifier
  let filename: String
  var contentType: UTType { .folder }
  init(_ id: String, parent: String, filename: String) {
    itemIdentifier = NSFileProviderItemIdentifier(id)
    parentItemIdentifier = NSFileProviderItemIdentifier(parent)
    self.filename = filename
  }
}

func createFolderFromFilesApp(
  _ name: String,
  parent: String,
  options: NSFileProviderCreateItemOptions = []
) async -> (NSFileProviderItem?, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    _ = ext.createItem(basedOn: FolderTemplate("template-folder", parent: parent, filename: name), fields: [], contents: nil, options: options,
                       request: NSFileProviderRequest()) { item, _, _, error in
      continuation.resume(returning: (item, error as NSError?))
    }
  }
}

// A new folder made in Files used to end noSuchItem: a permanent error on the new folder.
func foldersCanBeCreatedFromFiles() async {
  reset()
  let (made, error) = await createFolderFromFilesApp("Receipts", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(error == nil, "creating a folder succeeds, got \(describe(error))")
  check(ApiClient.shared.count("create-folder") == 1 && ApiClient.shared.calls.contains { $0.hasSuffix("parent=root") }, "the server is asked once, in the root, got \(ApiClient.shared.calls)")
  let id = ApiClient.shared.createdFolderIds.first ?? ""
  check(id == id.lowercased() && !id.isEmpty, "the folder id is lowercase (keys derive from it), got \(id)")
  check(made?.filename == "Receipts" && made?.contentType == .folder, "the created item is the folder, got \(made?.filename ?? "nil")")
  check(made?.itemIdentifier.rawValue == id, "its id is the id the server holds")
  check(CacheManager.shared.item(id: id)?.isFolder == true && CacheManager.shared.item(id: id)?.nameDecrypted == "Receipts", "the folder is cached with its name")

  reset()
  _ = await createFolderFromFilesApp("Inner", parent: "P1")
  check(ApiClient.shared.calls.contains { $0.hasSuffix("parent=P1") }, "a folder is created inside its parent, got \(ApiClient.shared.calls)")

  // A failure is reported as something Files retries, not as a dead end.
  reset()
  ApiClient.shared.createFolderFailure = URLError(.notConnectedToInternet)
  let (none, offline) = await createFolderFromFilesApp("Later", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(none == nil && isProviderError(offline, .serverUnreachable), "an offline create is retryable, got \(describe(offline))")

  // No key: -1000, never noSuchItem.
  reset()
  BeebeebKeychainCore.keyResult = .failure(BeebeebKeychainCore.LoadError.seKeyNotFound)
  let (_, noKey) = await createFolderFromFilesApp("Locked", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(isProviderError(noKey, .notAuthenticated), "no key: -1000, got \(describe(noKey))")

  // Inside Trash it is still refused.
  reset()
  let (_, refused) = await createFolderFromFilesApp("Nope", parent: trashId)
  check(refused != nil && ApiClient.shared.count("create-folder") == 0, "no folder is created in Trash")

  reset()
  ApiClient.shared.folderEchoOverride = "another-folder"
  let (wrong, mismatch) = await createFolderFromFilesApp("Wrong echo", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(wrong == nil && isProviderError(mismatch, .cannotSynchronize), "a folder response must echo the chosen id")
  check(mismatch?.localizedDescription == UploadItemIdEcho.message, "the folder echo mismatch carries the honest message")
}

func folderCreateRetriesAreIdempotent() async {
  reset()
  ApiClient.shared.failCreateAfterServerWrite = true
  ApiClient.shared.createFolderFailure = URLError(.networkConnectionLost)
  let first = await createFolderFromFilesApp("Receipts", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(first.0 == nil && isProviderError(first.1, .serverUnreachable), "the dropped first response is retryable")
  let second = await createFolderFromFilesApp("Receipts", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(second.0?.filename == "Receipts" && second.1 == nil, "the retry returns the folder the server already created")
  check(ApiClient.shared.count("create-folder") == 1, "a created-but-lost response leaves exactly one server folder, calls \(ApiClient.shared.calls)")
  check(ApiClient.shared.createdFolderIds.count == 1, "only one folder id was created")

  reset()
  ApiClient.shared.listings["root"] = .success([
    dto("existing-folder", parent: nil, name: encryptedName("existing-folder", "Inbox"), folder: true),
  ])
  let existing = await createFolderFromFilesApp(
    "Inbox",
    parent: NSFileProviderItemIdentifier.rootContainer.rawValue,
    options: [.mayAlreadyExist]
  )
  check(existing.0?.itemIdentifier.rawValue == "existing-folder" && existing.1 == nil,
        "mayAlreadyExist returns the existing same-name folder")
  check(ApiClient.shared.count("create-folder") == 0, "mayAlreadyExist does not create a duplicate")
  check(ApiClient.shared.listExpectedUsers.last! == "user-1",
        "the authoritative retry listing carries the key owner's account header")

  reset()
  CacheManager.shared.rows["stale-folder"] = row("stale-folder", name: "Archive", folder: true)
  ApiClient.shared.listings["root"] = .success([])
  let replacement = await createFolderFromFilesApp("Archive", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(replacement.0?.itemIdentifier.rawValue != "stale-folder" && replacement.1 == nil,
        "a cached same-name folder absent from the server is not returned")
  check(ApiClient.shared.count("list root") == 1 && ApiClient.shared.count("create-folder") == 1,
        "the server listing is authoritative and a new live folder is created")

  reset()
  ApiClient.shared.createFolderFailure = ApiError.parentUnavailable("missing-parent")
  let missingParent = await createFolderFromFilesApp("Child", parent: "missing-parent")
  check(missingParent.0 == nil && isProviderError(missingParent.1, .noSuchItem),
        "a missing destination parent is reported as the missing parent")
  let missingIdentifier = missingParent.1?.userInfo[NSFileProviderErrorNonExistentItemIdentifierKey] as? NSFileProviderItemIdentifier
  check(missingIdentifier?.rawValue == "missing-parent", "the noSuchItem error identifies the parent, got \(String(describing: missingIdentifier))")

  reset()
  ApiClient.shared.listings["missing-before-create"] = .failure(ApiError.statusCode(404))
  let missingDuringRetryCheck = await createFolderFromFilesApp("Child", parent: "missing-before-create")
  let retryCheckIdentifier = missingDuringRetryCheck.1?.userInfo[NSFileProviderErrorNonExistentItemIdentifierKey] as? NSFileProviderItemIdentifier
  check(missingDuringRetryCheck.0 == nil && isProviderError(missingDuringRetryCheck.1, .noSuchItem),
        "a parent missing during the retry listing is reported as noSuchItem")
  check(retryCheckIdentifier?.rawValue == "missing-before-create",
        "the retry-listing error identifies the missing parent, got \(String(describing: retryCheckIdentifier))")
  check(ApiClient.shared.count("create-folder") == 0, "no create is attempted below a missing parent")
}

func deletingAnAlreadyMissingItemSucceeds() async {
  reset()
  CacheManager.shared.rows["gone"] = row("gone", name: "gone.txt")
  ApiClient.shared.deleteFailure = ApiError.statusCode(404)
  let error = await deleteReturning("gone")
  check(error == nil, "a server 404 completes deleteItem successfully, got \(describe(error))")
  check(ApiClient.shared.count("delete gone") == 1, "the delete still reaches the server once")
  check(CacheManager.shared.item(id: "gone") == nil, "the stale local cache row is removed")
}

func everyWrittenNameUsesTheCanonicalEnvelope() async {
  reset()
  let folder = await createFolderFromFilesApp("Canonical folder", parent: NSFileProviderItemIdentifier.rootContainer.rawValue)
  check(folder.1 == nil, "the canonical folder create succeeds, got \(describe(folder.1))")
  let folderId = ApiClient.shared.createdFolderIds.first ?? ""
  let folderName = ApiClient.shared.createdFolderNames.first
  check(serverAcceptsNamePayload(folderName), "folder create sends the production canonical name envelope")
  let folderDto = dto(folderId, parent: nil, name: folderName, folder: true)
  check(SyncEngine.decryptName(dto: folderDto, masterKeyHandle: fixtureMaster, fallback: nil).name == "Canonical folder",
        "the extension reads its canonical folder name back")

  reset()
  let uploaded = await createItemFromFilesApp("Canonical upload.txt", bytes: 32)
  check(uploaded.1 == nil, "the canonical upload succeeds, got \(describe(uploaded.1))")
  let uploadId = ApiClient.shared.uploadInitFileIds.first ?? ""
  let uploadName = ApiClient.shared.uploadInitNames.first
  check(serverAcceptsNamePayload(uploadName), "upload init sends the production canonical name envelope")
  let uploadDto = dto(uploadId, parent: nil, name: uploadName)
  check(SyncEngine.decryptName(dto: uploadDto, masterKeyHandle: fixtureMaster, fallback: nil).name == "Canonical upload.txt",
        "the extension reads its canonical upload name back")

  reset()
  CacheManager.shared.rows["rename-id"] = row(
    "rename-id", name: "before.txt", encrypted: legacyEncryptedName("rename-id", "before.txt")
  )
  let renamed = await modify(Template("rename-id", parent: "root", filename: "after.txt"), [.filename])
  check(renamed.1 == nil, "the canonical rename succeeds, got \(describe(renamed.1))")
  let renameName = ApiClient.shared.patchedNames.first ?? nil
  check(serverAcceptsNamePayload(renameName), "rename PATCH sends the production canonical name envelope")
  let renameDto = dto("rename-id", parent: nil, name: renameName)
  check(SyncEngine.decryptName(dto: renameDto, masterKeyHandle: fixtureMaster, fallback: nil).name == "after.txt",
        "the extension reads its canonical renamed name back")

  reset()
  var duplicate = row("duplicate-id", name: "report.txt", encrypted: encryptedName("duplicate-id", "report.txt"))
  duplicate.displayName = "report (2).txt"
  CacheManager.shared.rows["duplicate-id"] = duplicate
  let source = AppGroupContainer.directory("display-name-upload").appendingPathComponent("content.bin")
  try! Data(repeating: 0x42, count: 32).write(to: source)
  let contentUpdate = await modifyOutcome(
    Template("duplicate-id", parent: NSFileProviderItemIdentifier.rootContainer.rawValue, filename: "report (2).txt"),
    [.contents],
    contents: source
  )
  check(contentUpdate.3 == nil, "content update of a disambiguated item succeeds, got \(describe(contentUpdate.3))")
  let contentName = ApiClient.shared.uploadInitNames.first.flatMap {
    try? CryptoBridge.decryptFilename(masterKeyHandle: fixtureMaster, fileId: "duplicate-id", nameEncrypted: $0)
  }
  check(contentName == "report.txt", "an upload sends the real name, never the display-only suffix, got \(contentName ?? "nil")")

  let legacy = legacyEncryptedName("legacy-id", "legacy.txt")
  let legacyDto = dto("legacy-id", parent: nil, name: legacy)
  check(SyncEngine.decryptName(dto: legacyDto, masterKeyHandle: fixtureMaster, fallback: nil).name == "legacy.txt",
        "the extension still reads the legacy base64 name envelope")
}


// The server's flat trash listing may or may not carry parent_id. Either way a trashed row has ONE
// stable parent in the cache: it never moves between Trash and a trashed folder on a refresh.
func trashedRowsKeepOneStableParent() async {
  func parentOf(_ id: String) -> String? { CacheManager.shared.item(id: id)?.parentId }
  func seed(withParentIds: Bool) {
    reset()
    ApiClient.shared.listings["trashed:root"] = .success([
      dtoUpdated("t1", parent: nil, name: encryptedName("t1", "old.txt"), updated: "2026-10-01T00:00:00Z"),
      dtoUpdated("t2", parent: nil, name: encryptedName("t2", "Old folder"), folder: true, updated: "2026-10-02T00:00:00Z"),
      dtoUpdated("t3", parent: withParentIds ? "t2" : nil, name: encryptedName("t3", "inside.txt"), updated: "2026-10-02T00:00:00Z"),
    ])
    ApiClient.shared.listings["trashed:t2"] = .success([
      dtoUpdated("t3", parent: nil, name: encryptedName("t3", "inside.txt"), updated: "2026-10-02T00:00:00Z"),
    ])
  }

  // With parent_id: a cascade-trashed child is not at the top level; it lives under its folder.
  seed(withParentIds: true)
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  check(CacheManager.shared.children(parent: trashId).map(\.id).sorted() == ["trash:t1", "trash:t2"], "top level: only what was trashed on its own, got \(CacheManager.shared.children(parent: trashId).map(\.id))")
  _ = await SyncEngine.refreshContainer(containerId: "trash:t2")
  check(parentOf("trash:t3") == "trash:t2", "the child lives under its folder, got \(parentOf("trash:t3") ?? "nil")")
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  check(parentOf("trash:t3") == "trash:t2", "a refresh of Trash does not move it, got \(parentOf("trash:t3") ?? "nil")")

  // Without parent_id (the current server): the flat list is shown as it is and rows never move.
  seed(withParentIds: false)
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  check(CacheManager.shared.children(parent: trashId).map(\.id).sorted() == ["trash:t1", "trash:t2", "trash:t3"], "no parent_id: the flat list is shown, got \(CacheManager.shared.children(parent: trashId).map(\.id))")
  _ = await SyncEngine.refreshContainer(containerId: "trash:t2")
  check(parentOf("trash:t3") == trashId, "no parent_id: opening the folder does not re-park the row, got \(parentOf("trash:t3") ?? "nil")")
  _ = await SyncEngine.refreshContainer(containerId: trashId)
  _ = await SyncEngine.refreshContainer(containerId: "trash:t2")
  check(parentOf("trash:t3") == trashId, "no parent_id: it stays put across refreshes, got \(parentOf("trash:t3") ?? "nil")")
  check(CacheManager.shared.children(parent: trashId).count == 3, "the same id is never listed in two places")
}

// ---- The internal backup manifest never shows in the Files app ----
// Backups/{Device}/.device.json is read by the app's backup screens, so it stays in the cache but is
// never enumerated: not in its folder, not in the working set. A user's own file with that name elsewhere
// stays; until the app has published the Backups root id the name alone decides.
struct NoRefresh: FileProviderContainerRefreshing {
  func refreshContainer(containerId: String) async -> FileProviderRefreshOutcome { .success }
  func refreshMaterializedContainers() async {}
}

func backupManifestIsNotEnumerated() async {
  func seed() {
    reset()
    CacheManager.shared.rows["B"] = row("B", name: "Backups", folder: true)
    CacheManager.shared.rows["D"] = row("D", parent: "B", name: "My iPhone", folder: true)
    CacheManager.shared.rows["m"] = row("m", parent: "D", name: ".device.json")
    CacheManager.shared.rows["n"] = row("n", parent: "D", name: "notes.txt")
    CacheManager.shared.rows["T"] = row("T", name: "Taxes", folder: true)
    CacheManager.shared.rows["own"] = row("own", parent: "T", name: ".device.json")
    CacheManager.shared.setSyncState(key: FileProviderItem.protectedBackupsRootKey, value: "b")
    for id in ["D", "T"] { CacheManager.shared.setSyncState(key: "container.\(id).anchor", value: "1") }
  }
  func names(_ container: NSFileProviderItemIdentifier) async -> [String] {
    let enumerator = FileProviderEnumerator(containerIdentifier: container, cache: CacheManager.shared, refresher: NoRefresh())
    return await enumerateOnce(enumerator).items.map(\.filename).sorted()
  }

  seed()
  let device = await names(NSFileProviderItemIdentifier("D"))
  check(device == ["notes.txt"], "the device folder lists no manifest, got \(device)")
  let own = await names(NSFileProviderItemIdentifier("T"))
  check(own == [".device.json"], "a user's own .device.json outside a device folder stays, got \(own)")
  CacheManager.shared.materialized = ["D", "T"]
  let workingSet = await names(.workingSet)
  check(workingSet.filter { $0 == ".device.json" }.count == 1, "exactly the user's own copy is in the working set, got \(workingSet)")
  check(CacheManager.shared.item(id: "m") != nil, "the manifest stays in the cache for the app")

  // The set a snapshot anchor is computed over hides it too: adding or replacing a manifest does not
  // make Files rebuild its listing.
  let enumerator = FileProviderEnumerator(containerIdentifier: NSFileProviderItemIdentifier("D"), cache: CacheManager.shared, refresher: NoRefresh())
  var before: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { before = $0 }
  CacheManager.shared.rows["m2"] = row("m2", parent: "D", name: ".device.json")
  var after: NSFileProviderSyncAnchor?
  enumerator.currentSyncAnchor { after = $0 }
  check(before != nil && before == after, "a manifest copy appearing does not change the anchor")

  // Root id not known yet: the name alone decides.
  CacheManager.shared.state = [:]
  for id in ["D", "T"] { CacheManager.shared.setSyncState(key: "container.\(id).anchor", value: "1") }
  let fallbackOwn = await names(NSFileProviderItemIdentifier("T"))
  check(fallbackOwn == [], "before the Backups root id is known the name alone hides it, got \(fallbackOwn)")
  let fallbackDevice = await names(NSFileProviderItemIdentifier("D"))
  check(fallbackDevice == ["notes.txt"], "and it stays hidden in the device folder, got \(fallbackDevice)")
}

let scenarioTable: [(String, () async -> Void)] = [
  ("key-errors", keyFailuresAreAuthenticationRequired),
  ("other-errors", otherFailuresKeepTheirMeaning),
  ("no-key-listing", noKeyRefusesListingInsteadOfPlaceholders),
  ("no-key-known-names", noKeyStillRefreshesKnownNames),
  ("no-key-mixed", noKeyRefusesAMixedFolder),
  ("undecryptable-label", undecryptableNameGetsUniqueLabelWithoutRename),
  ("duplicate-display-names", duplicateSiblingNamesGetStableDisplayAliases),
  ("app-write-aliases", appWritesCannotLeaveStaleOrCollidingAliases),
  ("placeholder-rename", renameOfUndecryptedItemNeverReachesTheServer),
  ("metadata-modify", metadataOnlyModifyKeepsTheItem),
  ("trash", trashIsUnsupportedNotTheRoot),
  ("snapshot-mime", snapshotIgnoresTheMimeType),
  ("streamed-content", contentStreamsIntoATemporaryFile),
  ("streamed-memory", contentStreamingStaysWithinTheExtensionBudget),
  ("registered-temp", contentLandsInTheRegisteredTempDirectory),
  ("bad-chunk", badChunkLeavesNoPlaintext),
  ("leftover-sweep", leftoversFromAKilledExtensionAreDeletedAtStart),
  ("stream-abort", midStreamStopsDeleteThePartialFile),
  ("materialized-set", { await materializedSetFollowsTheSystem(); workingSetScenariosFinish() }),
  ("materialized-refresh", { await staleMaterializedFoldersAreRefreshed(); workingSetScenariosFinish() }),
  ("trash-refresh", staleTrashIsRefreshedOutsideTheWorkingSet),
  ("trash-signal-race", newerTrashRefreshWinsAfterTheAppSignal),
  ("trash-signal-burst", idleTrashBurstDeliversEveryNewRow),
  ("trash-change-publication", supersededTrashChangeStillPublishesBeforeReplying),
  ("trash-change-bounded", repeatedSupersessionStopsAfterTheRetryLimit),
  ("trash-delete-signal-race", permanentDeleteSignalQueuesANewerTrashRefresh),
  ("first-listing-race", firstSuccessfulListingSurvivesANewerFailure),
  ("create-lowercase-id", createMintsALowercaseFileIdUsedForDerivation),
  ("chunk-retry", createRetriesADroppedChunkAndStopsOnARefusal),
  ("upload-session-restart", uploadSessionLossRestartsWithoutDeletingTheLiveItem),
  ("completion-retry-shape", idempotentUploadCompletionUsesKnownMetadata),
  ("create-echo-mismatch", createAbortsOnAnotherItemsEcho),
  ("refresh-survives-invalidate", backgroundRefreshSurvivesInvalidate),
  ("refresh-coalesced", backgroundRefreshesAreCoalescedPerContainer),
  ("first-load-cancellable", firstLoadStaysCancellable),
  ("backups-protected", backupsRootIsProtected),
  ("files-auth-flag", notAuthenticatedRecordsAFlagAndRecoveryEndsClean),
  ("files-working-set-auth", workingSetNeverCarriesAnAuthenticationError),
  ("files-retryable", transientFailuresAreRetryableNotDeadEnds),
  ("files-trash-folder", trashFolderIsListedAtTheTopAndIsReadOnly),
  ("files-trash-writes", nothingCanBeWrittenInsideTrash),
  ("files-trash-excluded", trashedItemsStayOutOfEverythingElse),
  ("files-create-folder", foldersCanBeCreatedFromFiles),
  ("files-create-folder-retry", folderCreateRetriesAreIdempotent),
  ("files-delete-missing", deletingAnAlreadyMissingItemSucceeds),
  ("files-canonical-names", everyWrittenNameUsesTheCanonicalEnvelope),
  ("files-trash-stable", trashedRowsKeepOneStableParent),
  ("manifest-hidden", backupManifestIsNotEnumerated),
]

@main
struct Harness {
  static func main() async {
    let only = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
    for (name, scenario) in scenarioTable where only == nil || only == name {
      await scenario()
    }
    print("extension-behaviour harness: \(passed) checks passed")
  }
}
`;

const REAL_SOURCES = [
  'FileProviderExtension.swift',
  'FileProviderItem.swift',
  'FileProviderEnumerator.swift',
  'SyncEngine.swift',
  'CachedHandleIdentity.swift',
  'CryptoBridge.swift',
].map((file) => join(EXT, file)).concat([
  // Task 1962 r4: the File Provider target also compiles this shared helper (plugins/file-provider/withFileProvider.js
  // and the committed pbxproj list it); without it here the harness cannot compile FileProviderExtension.swift.
  join(ROOT, 'modules', 'beebeeb-crypto', 'ios', 'LegacyURLCacheCleanup.swift'),
]);

let compiled: { dir: string; binary: string } | null = null;
const harnessRoots = new Set<string>();

afterAll(() => {
  for (const dir of harnessRoots) rmSync(dir, { recursive: true, force: true });
  harnessRoots.clear();
  compiled = null;
});

/** Compiles the shipped sources + doubles once per test file run. */
function harnessBinary(): { dir: string; binary: string } {
  if (compiled) return compiled;
  const dir = mkdtempSync(join(tmpdir(), 'bb-1722-extension-'));
  harnessRoots.add(dir);
  const doublesPath = join(dir, 'Doubles.swift');
  const scenariosPath = join(dir, 'Scenarios.swift');
  const binary = join(dir, 'harness');
  writeFileSync(doublesPath, doubles);
  writeFileSync(scenariosPath, scenarios);
  try {
    execFileSync('xcrun', [
    'swiftc', '-parse-as-library',
    '-framework', 'FileProvider', '-framework', 'UniformTypeIdentifiers',
    ...REAL_SOURCES, doublesPath, scenariosPath, '-o', binary,
    ], { stdio: 'pipe', timeout: 240_000 });
  } catch (error) {
    // Show the compiler's own diagnostics instead of only "Command failed".
    throw new Error(`harness did not compile:\n${String(error?.stderr ?? '')}${String(error?.stdout ?? '')}\n${String(error?.message ?? error)}`);
  }
  compiled = { dir, binary };
  return compiled;
}

/** Runs one scenario group; returns its combined stdout/stderr (NSLog lines included). */
function runScenario(name: string): string {
  const { dir, binary } = harnessBinary();
  const workDir = mkdtempSync(join(dir, `${name}-`));
  const output = join(workDir, 'output.log');
  try {
    execFileSync('/bin/sh', ['-c', '"$1" "$2" "$3" > "$4" 2>&1', 'extension-harness', binary, workDir, name, output], { timeout: 60_000 });
  } catch {
    // The FAIL line is the useful part of a red run; the assertions below report it.
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`--- ${name}\n${text}`);
  return text;
}

function expectScenario(name: string, checks: number): string {
  const output = runScenario(name);
  expect(output).not.toContain('FAIL:');
  expect(output).toContain(`extension-behaviour harness: ${checks} checks passed`);
  return output;
}

describe('task 1722 (c): key failures surface as Authentication Required', () => {
  nativeSwiftHarnessTest('every key-unavailable error is -1000 (never -2005) and nothing is downloaded', () => {
    const output = expectScenario('key-errors', 21);
    // G3: the reason a key load failed is logged, sanitised to a step and a status.
    expect(output).toContain('[Beebeeb] fetchContents(f1) failed: fileProviderKeyUnavailable(step: "unwrap", domain: "NSOSStatusErrorDomain", code: -25308)');
  }, 300_000);

  nativeSwiftHarnessTest('errors that are not about the key keep their meaning (-1004, -1000 for HTTP 401, -1005)', () => {
    expectScenario('other-errors', 3);
  }, 300_000);
});

describe('task 1722 (d): listings never vend placeholder names', () => {
  nativeSwiftHarnessTest('with no key, a folder whose names need decrypting ends -1000 with 0 items and 0 cache writes', () => {
    expectScenario('no-key-listing', 5);
  }, 300_000);

  nativeSwiftHarnessTest('with no key, names the app already decrypted (and legacy plaintext names) still refresh', () => {
    expectScenario('no-key-known-names', 3);
  }, 300_000);

  // Review M2-A: `contains(where:)` -> `!isEmpty && allSatisfy` passed every other check.
  // Review round 2, item 3: `return prior == nil` passed too; a TF 236 row with no name is now in it.
  nativeSwiftHarnessTest('with no key, a folder with ONE name that needs the key is refused whole (no placeholder rows, TF 236 rows included)', () => {
    expectScenario('no-key-mixed', 7);
  }, 300_000);

  nativeSwiftHarnessTest('an undecryptable name gets a unique id label and no rename capability', () => {
    expectScenario('undecryptable-label', 12);
  }, 300_000);

  nativeSwiftHarnessTest('duplicate server sibling names get stable display-only aliases in normal folders and Trash', () => {
    expectScenario('duplicate-display-names', 9);
  }, 300_000);

  nativeSwiftHarnessTest('app rename, move and duplicate writes cannot leave stale or colliding File Provider aliases', () => {
    expectScenario('app-write-aliases', 11);
  }, 300_000);

  nativeSwiftHarnessTest('renaming an undecrypted item sends 0 server writes; a move keeps its ciphertext name; only unstored fields stay pending', () => {
    expectScenario('placeholder-rename', 16);
  }, 300_000);

  // Found on the 2026-10-14 simulator log: Files sends modifyItem(lastUsedDate) after every open.
  // Review round 2, item 6: those fields come back still pending (returning [] reset them on disk).
  nativeSwiftHarnessTest('a change Beebeeb does not store (lastUsedDate, mtime, tags) keeps the item versions, writes nothing and stays pending', () => {
    expectScenario('metadata-modify', 24);
  }, 300_000);
});

describe('task 1722 review M4: no full rescans for a MIME type the cache writers disagree on', () => {
  nativeSwiftHarnessTest('a MIME-only change keeps the snapshot anchor; a rename still expires it', () => {
    expectScenario('snapshot-mime', 4);
  }, 300_000);
});

describe('task 1722 (e): no Files trash', () => {
  nativeSwiftHarnessTest('the trash container is NSFeatureUnsupportedError for item lookup and enumeration, never the root item', () => {
    expectScenario('trash', 6);
  }, 300_000);
});

// Task 1722 round 4 (review round 2, minor 6): iOS never lists a materialized folder again and
// ignores signals for any container but the working set. The extension keeps the system's
// materialized folders (materializedItemsDidChange -> enumeratorForMaterializedItems) and refreshes
// their stale listings when the working set is enumerated, so a web-side change and a TestFlight
// 236 row cached without a name reach Files.
describe('task 1722 round 4: folders Files already listed get their changes through the working set', () => {
  nativeSwiftHarnessTest('materializedItemsDidChange keeps the stored folders equal to the system\'s materialized folders', () => {
    expectScenario('materialized-set', 5);
  }, 300_000);

  nativeSwiftHarnessTest('a stale materialized folder is listed again from the working set, gets its real names, once', () => {
    expectScenario('materialized-refresh', 11);
  }, 300_000);

  nativeSwiftHarnessTest('the rate-limited refresh also prunes an emptied Trash and signals only its enumerator', () => {
    expectScenario('trash-refresh', 7);
  }, 300_000);

  nativeSwiftHarnessTest('a signal-triggered Trash refresh cannot be overwritten by an older response', () => {
    expectScenario('trash-signal-race', 8);
  }, 300_000);

  nativeSwiftHarnessTest('a newer failed refresh cannot discard the first successful listing of a folder', () => {
    expectScenario('first-listing-race', 4);
  }, 300_000);
});

// Task 1722 (G4/G5): fetchContents used to hold the whole ciphertext AND the whole plaintext in
// memory (a 59.8 MB DNG needs ~120 MB against the extension's ~50 MB budget).
// Task 1722 review I1 (2026-10-15): 7b57ac7 also moved the plaintext to
// NSFileProviderManager.temporaryDirectoryURL(). On the simulator that is <device>/data/tmp
// (fileprovider-stream.log:26619-26649), outside every app container: not registered, not
// protected by us, and out of reach of the sign-out purge. The plaintext stays in the registered
// App Group temp/ (same APFS volume on iOS; the framework hands fileproviderd a read-write
// sandbox extension for whatever URL we return, so it can still clone and unlink the file).
describe('task 1722 (G4/G5, review I1): content is streamed into the registered App Group temp directory', () => {
  const extensionSource = read(join(EXT, 'FileProviderExtension.swift'));
  const bridgeSource = read(join(EXT, 'CryptoBridge.swift'));
  const fetchBody = declaration(extensionSource, 'func fetchContents(');

  test('the download lands in a file, never in one Data buffer', () => {
    const download = declaration(apiClient, 'func downloadEncrypted(fileId: String)');
    expect(download).toContain('session.download(for:');
    expect(download).not.toContain('session.data(for:');
    const downloaded = declaration(apiClient, 'struct DownloadedEncryptedFile {');
    expect(downloaded).toMatch(/let url: URL/);
    expect(downloaded).not.toMatch(/let data: Data/);
  });

  test('decryption reads and writes one chunk at a time', () => {
    const decrypt = declaration(bridgeSource, 'static func decryptDownloadedFile(');
    expect(decrypt).toContain('to destination: URL');
    expect(decrypt).toContain('readExactly(');
    expect(decrypt).toContain('write(contentsOf:');
    expect(decrypt).not.toContain('Data(capacity: safePlaintextSize)');
    expect(decrypt).not.toMatch(/plaintext\.append\(/);
  });

  test('fetchContents writes only into the registered App Group temp directory, never temporaryDirectoryURL()', () => {
    expect(fetchBody).toContain('AppGroupContainer.temporaryContentDirectory');
    expect(extensionSource).not.toContain('temporaryDirectoryURL');
    expect(fetchBody).not.toMatch(/plaintext\.write\(to:/);
    expect(fetchBody).toContain('try? FileManager.default.removeItem(at: encrypted.url)');
  });

  nativeSwiftHarnessTest('a multi-chunk file and a pinned file stream to disk byte for byte; the ciphertext file is deleted', () => {
    expectScenario('streamed-content', 7);
  }, 300_000);

  nativeSwiftHarnessTest('a 48 MiB fetch grows the peak footprint by under 24 MiB', () => {
    expectScenario('streamed-memory', 3);
  }, 300_000);

  nativeSwiftHarnessTest('content lands in the App Group temp directory; temporaryDirectoryURL() is never asked', () => {
    expectScenario('registered-temp', 4);
  }, 300_000);

  nativeSwiftHarnessTest('a tampered or truncated chunk k of n leaves no partial plaintext (-2005)', () => {
    expectScenario('bad-chunk', 8);
  }, 300_000);

  nativeSwiftHarnessTest('the first extension instance deletes plaintext a killed decrypt left in temp/; later ones do not', () => {
    expectScenario('leftover-sweep', 4);
  }, 300_000);

  nativeSwiftHarnessTest('a purge or a cancel mid-stream leaves no partial plaintext (-1005 / NSUserCancelledError)', () => {
    expectScenario('stream-abort', 5);
  }, 300_000);
});

// SF-0002 part 1: a Files-app create used to mint UPPERCASE (UUID().uuidString)
// and derive the name/chunk keys from it, while the server body carried the
// lowercase id — so no client could derive the key. The mint is lowercase once,
// and the bytes handed to deriveFileKey are exactly the file_id sent upstream.
describe('SF-0002 part 1: a Files-app create derives keys from the lowercase id it sends', () => {
  nativeSwiftHarnessTest('createItem derives the name and chunk keys from the same lowercase id as file_id', () => {
    expectScenario('create-lowercase-id', 9);
  }, 300_000);
});

describe('SF-0001 round 2: a Files-app create whose init names another item', () => {
  nativeSwiftHarnessTest('aborts with the dead-end -2005 and the mismatch sentence (round 3), abandons the requested id, sends nothing to the echoed one', () => {
    expectScenario('create-echo-mismatch', 7);
  }, 300_000);
});

describe('a Files-app upload survives a dropped chunk request', () => {
  nativeSwiftHarnessTest('a timed-out chunk is sent again without restarting the upload; a refused one fails at once', () => {
    expectScenario('chunk-retry', 19);
  }, 300_000);

  nativeSwiftHarnessTest('an expired upload session restarts from init and a live lease remains retryable', () => {
    expectScenario('upload-session-restart', 12);
  }, 300_000);

  nativeSwiftHarnessTest('an idempotent completion retry may return only its id and still uses the known upload metadata', () => {
    expectScenario('completion-retry-shape', 3);
  }, 300_000);

  // Task 260 (P2-3) — runs anywhere: the harness substitutes its own ApiClient, so
  // the SHIPPED request timeout can only be checked at the source.
  test('the shipped chunk PUT sets its own request timeout instead of inheriting the 60 s one', () => {
    const put = declaration(apiClient, 'func uploadChunkV2(');
    // The harness's double declares this same signature; a drift fails here, not only on macOS.
    expect(put).toContain('timeout: TimeInterval');
    expect(put).toContain('request.timeoutInterval = timeout');
    // The shared session still configures the long whole-file timeout: the chunk
    // deadline must not come from it.
    expect(apiClient).toContain('cfg.timeoutIntervalForRequest = 60');
    const ext = read(join(EXT, 'FileProviderExtension.swift'));
    const retry = declaration(ext, 'private static func uploadChunkWithRetry(');
    // Per attempt: its own timeout, clamped to the budget that is left.
    expect(retry).toContain('timeout: min(Self.chunkAttemptTimeout, remaining)');
    expect(retry).toContain('let deadline = Date().addingTimeInterval(Self.chunkRetryBudget)');
    // No sleep that would outlast the budget, and no attempt started with none left.
    expect(retry).toContain('guard remaining > 0');
    expect(retry).toContain('guard deadline.timeIntervalSinceNow > backoff');
    const attempt = Number(ext.match(/static let chunkAttemptTimeout: TimeInterval = ([\d.]+)/)?.[1]);
    const budget = Number(ext.match(/static let chunkRetryBudget: TimeInterval = ([\d.]+)/)?.[1]);
    expect(attempt).toBe(15);
    expect(budget).toBeLessThanOrEqual(20);
    // The old ladder (4 x the shared 60 s + 7 s backoff) is what got the extension killed.
    expect(attempt * 4 + 7).toBeGreaterThan(budget);
  });
});

// Files kept showing items deleted elsewhere because iOS invalidates the enumerator right after
// enumerateItems and that cancelled the background refresh that prunes the cache.
describe('the background refresh outlives the enumerator', () => {
  nativeSwiftHarnessTest('invalidate() does not cancel the refresh; a row deleted on the server leaves the cache', () => {
    expectScenario('refresh-survives-invalidate', 7);
  }, 300_000);

  nativeSwiftHarnessTest('refreshes are coalesced: one in flight per container, at most one queued', () => {
    expectScenario('refresh-coalesced', 9);
  }, 300_000);

  nativeSwiftHarnessTest('the first-load refresh, which must answer the observer, is still cancelled by invalidate()', () => {
    expectScenario('first-load-cancellable', 4);
  }, 300_000);
});

describe('an app permanent-delete signal is newer than any Trash refresh already in flight', () => {
  nativeSwiftHarnessTest('queues one post-delete server listing and prunes the namespaced cache row', () => {
    expectScenario('trash-delete-signal-race', 5);
  }, 300_000);
});

describe('an idle Trash enumerator receives a burst of app signals', () => {
  nativeSwiftHarnessTest('publishes and delivers every newly trashed row while keeping one queued pass', () => {
    expectScenario('trash-signal-burst', 10);
  }, 300_000);
});

describe('a Trash change observer is not satisfied by a discarded refresh generation', () => {
  nativeSwiftHarnessTest('retries until its server listing publishes even when a newer direct refresh fails', () => {
    expectScenario('trash-change-publication', 5);
  }, 300_000);
  nativeSwiftHarnessTest('stops after three repeatedly superseded passes and returns a retryable error', () => {
    expectScenario('trash-change-bounded', 10);
  }, 300_000);
});

describe('the root Backups folder is protected in the Files app', () => {
  nativeSwiftHarnessTest('no delete, rename or move capability; those calls are refused; items inside are unaffected', () => {
    expectScenario('backups-protected', 17);
  }, 300_000);
});

describe('Files app: recover from Authentication Required, no stale error badge, read-only Trash', () => {
  nativeSwiftHarnessTest('-1000 records a timestamp; after recovery the listing succeeds with no error', () => {
    expectScenario('files-auth-flag', 14);
  }, 300_000);
  nativeSwiftHarnessTest('the working set never ends with an authentication error (the domain-level badge)', () => {
    expectScenario('files-working-set-auth', 6);
  }, 300_000);
  nativeSwiftHarnessTest('transient network errors are retryable and cancellations are not sync errors', () => {
    expectScenario('files-retryable', 22);
  }, 300_000);
  nativeSwiftHarnessTest('Trash is a read-only folder at the top that lists trashed items', () => {
    expectScenario('files-trash-folder', 38);
  }, 300_000);
  nativeSwiftHarnessTest('nothing can be created, renamed, moved, changed or deleted inside Trash', () => {
    expectScenario('files-trash-writes', 19);
  }, 300_000);
  nativeSwiftHarnessTest('the working set includes the synthetic Trash folder but excludes every trashed content row', () => {
    expectScenario('files-trash-excluded', 9);
  }, 300_000);
  nativeSwiftHarnessTest('a folder made in Files is created on the server (no permanent noSuchItem error)', () => {
    expectScenario('files-create-folder', 12);
  }, 300_000);
  nativeSwiftHarnessTest('a created-but-lost response and mayAlreadyExist both return the existing folder without a duplicate', () => {
    expectScenario('files-create-folder-retry', 14);
  }, 300_000);
  nativeSwiftHarnessTest('deleting an item already gone from the server completes successfully and drops its stale cache row', () => {
    expectScenario('files-delete-missing', 3);
  }, 300_000);
  nativeSwiftHarnessTest('folder create, upload init and rename write canonical names while both read formats remain supported', () => {
    expectScenario('files-canonical-names', 12);
  }, 300_000);
  nativeSwiftHarnessTest('a trashed row keeps one stable parent, with or without parent_id in the server listing', () => {
    expectScenario('files-trash-stable', 7);
  }, 300_000);
});

describe('the internal backup manifest is hidden in the Files app', () => {
  nativeSwiftHarnessTest('not enumerated in its folder or the working set; a user copy elsewhere stays; name-only before the root id is known', () => {
    expectScenario('manifest-hidden', 12);
  }, 300_000);
});
