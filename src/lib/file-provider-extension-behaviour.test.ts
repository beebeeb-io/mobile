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
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  init?(for domain: NSFileProviderDomain) {}
  func temporaryDirectoryURL() throws -> URL {
    Self.lock.lock(); Self._temporaryDirectoryCalls += 1; Self.lock.unlock()
    return Self.systemTemporaryDirectory
  }
  func signalEnumerator(for container: NSFileProviderItemIdentifier, completionHandler: @escaping (Error?) -> Void) {
    completionHandler(nil)
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
  static func fromKeychainBytes(bytes: Data) throws -> MasterKeyHandle {
    guard bytes.count == 32 else { throw FixtureCryptoError() }
    return MasterKeyHandle(key: bytes)
  }
  func deriveFileKey(fileId: Data) throws -> FileKeyHandle {
    FileKeyHandle(key: Data(SHA256.hash(data: key + fileId)))
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

// ---- shared metadata cache: in-memory, records every write ----
__CACHED_ITEM__

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

  func reset() {
    lock.lock(); defer { lock.unlock() }
    rows = [:]; state = [:]; epoch = 7; writes = []; onEpochCheck = nil; epochChecks = 0
  }
  func item(id: String) -> CachedItem? { lock.lock(); defer { lock.unlock() }; return rows[id] }
  func children(parent: String?) -> [CachedItem] {
    lock.lock(); defer { lock.unlock() }
    return rows.values.filter { $0.parentId == parent }.sorted { $0.id < $1.id }
  }
  @discardableResult
  func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard expectedEpoch == epoch else { return false }
    writes.append("replaceChildren")
    for (id, row) in rows where row.parentId == parent && !items.contains(where: { $0.id == id }) { rows[id] = nil }
    for item in items { rows[item.id] = item }
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
  __UPLOAD_RESPONSE_DTO__
  __UPLOAD_INIT_DTO__

  var listings: [String: Result<[FileEntryDto], Error>] = [:]
  var downloadResult: Result<DownloadedEncryptedFile, Error> = .failure(ApiError.invalidResponse)
  private(set) var calls: [String] = []
  private(set) var patchedNames: [String?] = []

  func reset() { listings = [:]; downloadResult = .failure(ApiError.invalidResponse); calls = []; patchedNames = [] }
  func count(_ prefix: String) -> Int { calls.filter { $0.hasPrefix(prefix) }.count }

  func listFiles(parentId: String?) async throws -> [FileEntryDto] {
    calls.append("list \(parentId ?? "root")")
    return try (listings[parentId ?? "root"] ?? .success([])).get()
  }
  func downloadEncrypted(fileId: String) async throws -> DownloadedEncryptedFile {
    calls.append("download \(fileId)")
    return try downloadResult.get()
  }
  func patchFile(fileId: String, nameEncrypted: String? = nil, parentId: String? = nil, expectedUser: String?) async throws -> FileEntryDto {
    calls.append("patch \(fileId) parent=\(parentId ?? "root")")
    patchedNames.append(nameEncrypted)
    return FileEntryDto(id: fileId, parent_id: parentId, name_encrypted: nameEncrypted, name_nonce: nil, mime_type: nil,
                        size_bytes: 0, is_folder: false, chunk_count: 1, created_at: nil, updated_at: "2026-10-14T00:00:00Z")
  }
  func deleteFile(fileId: String, expectedUser: String?) async throws { calls.append("delete \(fileId)") }
  func initUploadV2(fileId: String, nameEncrypted: String, fileSizeBytes: Int64, mimeType: String?, parentId: String?,
                    isMedia: Bool, chunkSizeBytes: Int, chunkCount: Int, expectedUser: String?) async throws -> UploadV2InitResponse {
    calls.append("upload-init \(fileId)")
    return UploadV2InitResponse(file_id: fileId, upload_session_id: "session", chunk_size_bytes: chunkSizeBytes, chunk_count: chunkCount)
  }
  func uploadChunkV2(uploadSessionId: String, index: Int, encryptedChunk: Data, expectedUser: String?) async throws {
    calls.append("upload-chunk \(index)")
  }
  func completeUploadV2(uploadSessionId: String, expectedUser: String?) async throws -> UploadResponseDto {
    calls.append("upload-complete")
    return UploadResponseDto(id: "uploaded", name_encrypted: nil, size_bytes: 0, chunk_count: 1, created_at: nil, updated_at: nil)
  }
}
`
  .replace('__LOAD_ERROR__', declaration(keychainCore, 'enum LoadError: Error {'))
  .replace('__CACHED_ITEM__', declaration(cacheManager, 'struct CachedItem {'))
  .replace('__API_ERROR__', declaration(apiClient, 'enum ApiError: Error {'))
  .replace('__DOWNLOADED_FILE__', declaration(apiClient, 'struct DownloadedEncryptedFile {'))
  .replace('__DEFAULT_CHUNK_SIZE__', line(apiClient, 'let defaultPlaintextChunkSize'))
  .replace('__FILE_ENTRY_DTO__', declaration(apiClient, 'struct FileEntryDto: Decodable {'))
  .replace('__UPLOAD_RESPONSE_DTO__', declaration(apiClient, 'struct UploadResponseDto: Decodable {'))
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

func reset() {
  CacheManager.shared.reset()
  ApiClient.shared.reset()
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
/// A well-formed envelope this account's key cannot open.
let undecryptable = #"{"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#

func dto(_ id: String, parent: String?, name: String?, folder: Bool = false) -> ApiClient.FileEntryDto {
  ApiClient.FileEntryDto(id: id, parent_id: parent, name_encrypted: name, name_nonce: nil, mime_type: folder ? nil : "text/plain",
                         size_bytes: folder ? 0 : 5, is_folder: folder, chunk_count: 1, created_at: nil, updated_at: "2026-10-14T00:00:00Z")
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

func modify(_ template: NSFileProviderItem, _ fields: NSFileProviderItemFields) async -> (NSFileProviderItem?, NSError?) {
  let ext = FileProviderExtension(domain: BeebeebConstants.fileProviderDomain)
  return await withCheckedContinuation { continuation in
    _ = ext.modifyItem(template, baseVersion: NSFileProviderItemVersion(contentVersion: Data(), metadataVersion: Data()),
                       changedFields: fields, contents: nil, options: [], request: NSFileProviderRequest()) { item, _, _, error in
      continuation.resume(returning: (item, error as NSError?))
    }
  }
}

func renameOfUndecryptedItemNeverReachesTheServer() async {
  reset()
  CacheManager.shared.rows["u1"] = row("u1", parent: "H", name: nil, encrypted: undecryptable)
  let placeholder = FileProviderItem(cached: CacheManager.shared.rows["u1"]!).filename
  let (renamed, renameError) = await modify(Template("u1", parent: "H", filename: "Folder 2"), [.filename])
  check(renameError == nil, "rename of an undecrypted item: no error, got \(describe(renameError))")
  check(ApiClient.shared.count("patch") == 0, "rename of an undecrypted item: 0 server writes, got \(ApiClient.shared.calls)")
  check(renamed?.filename == placeholder, "rename of an undecrypted item: the label is kept (\(placeholder)), got \(renamed?.filename ?? "nil")")
  check(CacheManager.shared.item(id: "u1")?.nameEncrypted == undecryptable, "the server name is untouched in the cache")

  reset()
  CacheManager.shared.rows["u1"] = row("u1", parent: "H", name: nil, encrypted: undecryptable)
  let (_, moveError) = await modify(Template("u1", parent: "K", filename: "Folder 2"), [.filename, .parentItemIdentifier])
  check(moveError == nil, "move of an undecrypted item: no error, got \(describe(moveError))")
  check(ApiClient.shared.calls == ["patch u1 parent=K"], "move: one PATCH for the new parent, got \(ApiClient.shared.calls)")
  check(ApiClient.shared.patchedNames == [undecryptable], "move: carries the existing ciphertext name, never a new one")

  reset()
  CacheManager.shared.rows["r1"] = row("r1", parent: "H", name: "old.txt", encrypted: encryptedName("r1", "old.txt"))
  let (readable, readableError) = await modify(Template("r1", parent: "H", filename: "new.txt"), [.filename])
  check(readableError == nil && readable?.filename == "new.txt", "a decrypted item still renames, got \(describe(readableError))")
  let sent = ApiClient.shared.patchedNames.first ?? nil
  let sentName = sent.flatMap { try? CryptoBridge.decryptFilename(masterKeyHandle: fixtureMaster, fileId: "r1", nameEncrypted: $0) }
  check(ApiClient.shared.count("patch") == 1 && sentName == "new.txt", "the rename sends one ciphertext of the new name, got \(sentName ?? "nil")")
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

let scenarioTable: [(String, () async -> Void)] = [
  ("key-errors", keyFailuresAreAuthenticationRequired),
  ("other-errors", otherFailuresKeepTheirMeaning),
  ("no-key-listing", noKeyRefusesListingInsteadOfPlaceholders),
  ("no-key-known-names", noKeyStillRefreshesKnownNames),
  ("no-key-mixed", noKeyRefusesAMixedFolder),
  ("undecryptable-label", undecryptableNameGetsUniqueLabelWithoutRename),
  ("placeholder-rename", renameOfUndecryptedItemNeverReachesTheServer),
  ("trash", trashIsUnsupportedNotTheRoot),
  ("snapshot-mime", snapshotIgnoresTheMimeType),
  ("streamed-content", contentStreamsIntoATemporaryFile),
  ("streamed-memory", contentStreamingStaysWithinTheExtensionBudget),
  ("registered-temp", contentLandsInTheRegisteredTempDirectory),
  ("bad-chunk", badChunkLeavesNoPlaintext),
  ("leftover-sweep", leftoversFromAKilledExtensionAreDeletedAtStart),
  ("stream-abort", midStreamStopsDeleteThePartialFile),
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
].map((file) => join(EXT, file));

let compiled: { dir: string; binary: string } | null = null;

/** Compiles the shipped sources + doubles once per test file run. */
function harnessBinary(): { dir: string; binary: string } {
  if (compiled) return compiled;
  const dir = mkdtempSync(join(tmpdir(), 'bb-1722-extension-'));
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
  nativeSwiftHarnessTest('with no key, a folder with ONE name that needs the key is refused whole (no placeholder rows)', () => {
    expectScenario('no-key-mixed', 3);
  }, 300_000);

  nativeSwiftHarnessTest('an undecryptable name gets a unique id label and no rename capability', () => {
    expectScenario('undecryptable-label', 12);
  }, 300_000);

  nativeSwiftHarnessTest('renaming an undecrypted item sends 0 server writes; a move keeps its ciphertext name', () => {
    expectScenario('placeholder-rename', 9);
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
