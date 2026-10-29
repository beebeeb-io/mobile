// @ts-nocheck - compiled production Swift exercises framing and metadata decoding.
// Fixture handles use real CryptoKit AES-GCM; they do not test Rust derivation or SE hardware.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const CRYPTO_BRIDGE = join(ROOT, 'targets', 'file-provider', 'CryptoBridge.swift');

const nativeTest = process.platform === 'darwin' ? test : test.skip;

nativeTest('File Provider content and name codecs decrypt ordered chunks and fail closed', () => {
  const cryptoBridge = readFileSync(CRYPTO_BRIDGE, 'utf8').replace(/^import Foundation\s*/, '');
  const harness = `
import Foundation
import CryptoKit

enum BeebeebConstants {
  static let masterKeyLabel = "io.beebeeb.master-key"
}

enum BeebeebKeychainCore {
  enum LoadMode { case primaryOnly, extensionOnly, extensionThenPrimary, fileProviderOnly }
  enum LoadError: Error { case notFound, seKeyNotFound }
  static let masterKeyOwnerKey = "owner"
  static let sessionUserIdKey = "user"
  static var strings: [String: String] = ["owner": "u1", "user": "u1"]
  static var keyBytes = Data((0..<32).map { UInt8($0) })
  static func loadString(key: String) -> String? { strings[key] }
  static func loadMasterKeyThrowing(label: String, mode: LoadMode) throws -> Data {
    precondition(mode == .fileProviderOnly, "Files must not use primary or shared extension keys")
    return keyBytes
  }
}

struct EncryptedData {
  let nonce: Data
  let ciphertext: Data
}

struct DownloadedEncryptedFile {
  let url: URL
  let chunkCount: Int
  let chunkSize: Int
}

struct DecryptedNameWithMime {
  let name: String
  let mimeType: String?
}

final class MasterKeyHandle {
  let key: Data
  init(key: Data) { self.key = key }
  static func fromKeychainBytes(bytes: Data) throws -> MasterKeyHandle {
    guard bytes.count == 32 else { throw CryptoBridge.CryptoBridgeError.decodeFailed }
    return MasterKeyHandle(key: bytes)
  }
  func deriveFileKey(fileId: Data) throws -> FileKeyHandle {
    var material = Data()
    material.append(key)
    material.append(fileId)
    return FileKeyHandle(key: Data(SHA256.hash(data: material)))
  }
  func decryptNameWithMime(fileId: String, nameEncrypted: String) throws -> DecryptedNameWithMime {
    throw CryptoBridge.CryptoBridgeError.decodeFailed
  }
}

final class FileKeyHandle {
  let key: SymmetricKey
  static var nonceCounter = 0
  init(key: Data) { self.key = SymmetricKey(data: key) }
  private func nextNonce() throws -> AES.GCM.Nonce {
    defer { Self.nonceCounter += 1 }
    return try AES.GCM.Nonce(data: Data((0..<12).map { UInt8((Self.nonceCounter + $0) & 0xff) }))
  }
  func encryptChunk(plaintext: Data) throws -> EncryptedData {
    let sealed = try AES.GCM.seal(plaintext, using: key, nonce: try nextNonce())
    var ciphertext = sealed.ciphertext
    ciphertext.append(sealed.tag)
    return EncryptedData(nonce: Data(sealed.nonce), ciphertext: ciphertext)
  }
  func decryptChunk(nonce: Data, ciphertext: Data) throws -> Data {
    guard ciphertext.count >= 16 else { throw CryptoBridge.CryptoBridgeError.decodeFailed }
    let sealed = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce),
      ciphertext: ciphertext.dropLast(16),
      tag: ciphertext.suffix(16)
    )
    return try AES.GCM.open(sealed, using: key)
  }
  func encryptMetadata(metadata: String) throws -> EncryptedData {
    try encryptChunk(plaintext: Data(metadata.utf8))
  }
  func decryptMetadata(nonce: Data, ciphertext: Data) throws -> String {
    guard let text = String(data: try decryptChunk(nonce: nonce, ciphertext: ciphertext), encoding: .utf8) else {
      throw CryptoBridge.CryptoBridgeError.decodeFailed
    }
    return text
  }
}

${cryptoBridge}

func assert(_ condition: @autoclosure () -> Bool, _ message: String, count: inout Int) {
  precondition(condition(), message)
  count += 1
}

func expectThrows(_ message: String, count: inout Int, _ body: () throws -> Void) {
  do {
    try body()
    preconditionFailure(message)
  } catch {
    count += 1
  }
}

let master = try CryptoBridge.loadMasterKeyHandle()
let fileId = "9D330814-8553-47B2-8389-68470D9ED6AF"
let payload = Data((0..<100_003).map { UInt8($0 % 251) })
let chunkSize = 16_384
var wire = Data()
var offset = 0
var chunks = 0
while offset < payload.count {
  let end = min(offset + chunkSize, payload.count)
  let encrypted = try CryptoBridge.encryptChunkForUpload(masterKeyHandle: master, fileId: fileId, plaintext: payload[offset..<end])
  wire.append(encrypted)
  offset = end
  chunks += 1
}

// Task 1722 (G5): decryptDownloadedFile streams from the downloaded ciphertext file into an output
// file, one chunk at a time. Every case writes its ciphertext to disk and reads the output back.
let scratch = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("beebeeb-codec-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
var files = 0
func decryptFile(_ wire: Data, chunkSize: Int, chunkCount: Int, plaintextSize: Int, fileId: String = fileId,
                 shouldContinue: () -> Bool = { true }) throws -> Data {
  files += 1
  let input = scratch.appendingPathComponent("in-\(files).bin")
  let output = scratch.appendingPathComponent("out-\(files).bin")
  try wire.write(to: input)
  try CryptoBridge.decryptDownloadedFile(
    masterKeyHandle: master,
    fileId: fileId,
    encryptedFile: DownloadedEncryptedFile(url: input, chunkCount: chunkCount, chunkSize: chunkSize),
    plaintextSize: plaintextSize,
    to: output,
    shouldContinue: shouldContinue
  )
  return try Data(contentsOf: output)
}
func wireFor(_ chunks: [[UInt8]]) throws -> Data {
  var data = Data()
  for chunk in chunks { data.append(try CryptoBridge.encryptChunkForUpload(masterKeyHandle: master, fileId: fileId, plaintext: Data(chunk))) }
  return data
}

var count = 0
let decrypted = try decryptFile(wire, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count)
assert(decrypted == payload, "mixed-size chunks decrypt in order", count: &count)

let inferredPlaintext = try decryptFile(wire, chunkSize: chunkSize, chunkCount: 0, plaintextSize: payload.count)
assert(inferredPlaintext == payload, "chunk count can be inferred", count: &count)

let emptyWire = try CryptoBridge.encryptChunkForUpload(masterKeyHandle: master, fileId: fileId, plaintext: Data())
let emptyPlaintext = try decryptFile(emptyWire, chunkSize: chunkSize, chunkCount: 1, plaintextSize: 0)
assert(emptyPlaintext.isEmpty, "empty files decrypt", count: &count)

expectThrows("truncated body rejected", count: &count) {
  var truncated = wire
  truncated.removeLast()
  _ = try decryptFile(truncated, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count)
}
expectThrows("tampered body rejected", count: &count) {
  var tampered = wire
  tampered[tampered.count / 2] ^= 0x80
  _ = try decryptFile(tampered, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count)
}
expectThrows("wrong file id rejected", count: &count) {
  _ = try decryptFile(wire, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count, fileId: "wrong-id")
}
expectThrows("extra trailing bytes rejected", count: &count) {
  var extra = wire
  extra.append(0)
  _ = try decryptFile(extra, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count)
}

// Chunk-layout cases (from scripts/test-file-provider-decrypt-downloaded-file.py), real AES-GCM.
let single = try decryptFile(try wireFor([[1, 2, 3, 4, 5]]), chunkSize: 8, chunkCount: 1, plaintextSize: 5)
assert(single == Data([1, 2, 3, 4, 5]), "single chunk uses the full plaintext size", count: &count)
let exact = try decryptFile(try wireFor([[1, 2, 3, 4], [5, 6, 7, 8]]), chunkSize: 4, chunkCount: 2, plaintextSize: 8)
assert(exact == Data(1...8), "exact multiple uses the declared chunk size", count: &count)
let remainder = try decryptFile(try wireFor([[10, 11, 12, 13], [14, 15]]), chunkSize: 4, chunkCount: 2, plaintextSize: 6)
assert(remainder == Data([10, 11, 12, 13, 14, 15]), "the last chunk is sized from the plaintext size", count: &count)
let underDeclared = try decryptFile(try wireFor([[20, 21, 22, 23], [24, 25]]), chunkSize: 4, chunkCount: 1, plaintextSize: 6)
assert(underDeclared == Data([20, 21, 22, 23, 24, 25]), "a declared chunk count below the size inference still decrypts every chunk", count: &count)
expectThrows("zero cached size rejects a non-empty stream", count: &count) {
  _ = try decryptFile(try wireFor([[90, 91, 92, 93]]), chunkSize: 4, chunkCount: 1, plaintextSize: 0)
}

// The per-chunk stop: checked before every chunk, and a stop throws instead of returning a prefix.
var checks = 0
_ = try decryptFile(wire, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count, shouldContinue: { checks += 1; return true })
assert(checks == chunks, "shouldContinue runs once per chunk (\(checks) of \(chunks))", count: &count)
var stopped: Error?
do {
  checks = 0
  _ = try decryptFile(wire, chunkSize: chunkSize, chunkCount: chunks, plaintextSize: payload.count, shouldContinue: { checks += 1; return checks < 3 })
} catch {
  stopped = error
}
assert(stopped is CancellationError && checks == 3, "a stop before chunk 3 throws CancellationError", count: &count)
try? FileManager.default.removeItem(at: scratch)

let metadata = "{\\"name\\":\\"RAW image.dng\\",\\"mime_type\\":\\"image/x-adobe-dng\\"}"
let encryptedName = try CryptoBridge.encryptFilename(masterKeyHandle: master, fileId: fileId, filename: metadata)
let name = try CryptoBridge.decryptNameWithMime(masterKeyHandle: master, fileId: fileId, nameEncrypted: encryptedName)
assert(name.name == "RAW image.dng", "metadata name decrypted", count: &count)
assert(name.mimeType == "image/x-adobe-dng", "metadata MIME decrypted", count: &count)

let bareName = try CryptoBridge.decryptNameWithMime(masterKeyHandle: master, fileId: fileId, nameEncrypted: "legacy.jpg")
assert(bareName.name == "legacy.jpg" && bareName.mimeType == nil, "legacy plaintext name stays readable", count: &count)

expectThrows("wrong metadata key rejected", count: &count) {
  _ = try CryptoBridge.decryptNameWithMime(masterKeyHandle: master, fileId: "other-file", nameEncrypted: encryptedName)
}

FileHandle.standardOutput.write(Data("PASS FileProvider codec cases=\\(count)\\n".utf8))
`;
  const dir = mkdtempSync(join(tmpdir(), 'beebeeb-files-codec-'));
  const swift = join(dir, 'main.swift');
  const binary = join(dir, 'runner');
  const output = join(dir, 'output.log');
  writeFileSync(swift, harness);
  execFileSync('swiftc', [swift, '-o', binary], { timeout: 60_000 });
  try {
    execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-codec-test', binary, output], { timeout: 30_000 });
  } catch {
    // The failing precondition is in the output asserted below.
  }
  const text = readFileSync(output, 'utf8');
  // eslint-disable-next-line no-console
  if (!text.includes('PASS')) console.log(text);
  expect(text).toContain('PASS FileProvider codec cases=18');
}, 90_000);
