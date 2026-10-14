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

  func reset() {
    lock.lock(); defer { lock.unlock() }
    rows = [:]; state = [:]; epoch = 7; writes = []
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
  func purgeEpochUnchanged(since captured: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return captured == epoch }
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

  func reset() { listings = [:]; downloadResult = .failure(ApiError.invalidResponse); calls = [] }
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
    calls.append("patch \(fileId) name=\(nameEncrypted != nil) parent=\(parentId ?? "root")")
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

func row(_ id: String, parent: String? = nil, name: String? = nil, encrypted: String? = nil, folder: Bool = false, size: Int = 0) -> CachedItem {
  CachedItem(id: id, parentId: parent, nameEncrypted: encrypted, nameDecrypted: name, mimeType: folder ? nil : "text/plain",
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

@main
struct Harness {
  static func main() async {
    await keyFailuresAreAuthenticationRequired()
    await otherFailuresKeepTheirMeaning()
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

function runHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bb-1722-extension-'));
  const doublesPath = join(dir, 'Doubles.swift');
  const scenariosPath = join(dir, 'Scenarios.swift');
  const binary = join(dir, 'harness');
  const output = join(dir, 'output.log');
  writeFileSync(doublesPath, doubles);
  writeFileSync(scenariosPath, scenarios);
  execFileSync('xcrun', [
    'swiftc', '-parse-as-library',
    '-framework', 'FileProvider', '-framework', 'UniformTypeIdentifiers',
    ...REAL_SOURCES, doublesPath, scenariosPath, '-o', binary,
  ], { stdio: 'pipe', timeout: 240_000 });
  try {
    execFileSync('/bin/sh', ['-c', '"$1" "$2" > "$3" 2>&1', 'extension-harness', binary, dir, output], { timeout: 60_000 });
  } catch {
    // The FAIL line below is the useful part of a red run.
  }
  return readFileSync(output, 'utf8');
}

describe('task 1722: iOS File Provider extension behaviour (shipped sources, in-memory doubles)', () => {
  nativeSwiftHarnessTest('key failures are Authentication Required, never -2005; other errors keep their meaning', () => {
    const output = runHarness();
    // eslint-disable-next-line no-console
    console.log(output);
    expect(output).not.toContain('FAIL:');
    expect(output).toContain('extension-behaviour harness: 24 checks passed');
    // G3: the reason a key load failed is logged, sanitised to a step and a status.
    expect(output).toContain('[Beebeeb] fetchContents(f1) failed: fileProviderKeyUnavailable(step: "unwrap", domain: "NSOSStatusErrorDomain", code: -25308)');
  }, 300_000);
});
