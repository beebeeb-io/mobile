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
  let data: Data
  let chunkSize: Int
  let chunkCount: Int
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

var count = 0
let downloaded = DownloadedEncryptedFile(data: wire, chunkSize: chunkSize, chunkCount: chunks)
let decrypted = try CryptoBridge.decryptDownloadedFile(
  masterKeyHandle: master,
  fileId: fileId,
  encryptedFile: downloaded,
  plaintextSize: payload.count
)
assert(decrypted == payload, "mixed-size chunks decrypt in order", count: &count)

let inferred = DownloadedEncryptedFile(data: wire, chunkSize: chunkSize, chunkCount: 0)
let inferredPlaintext = try CryptoBridge.decryptDownloadedFile(masterKeyHandle: master, fileId: fileId, encryptedFile: inferred, plaintextSize: payload.count)
assert(inferredPlaintext == payload, "chunk count can be inferred", count: &count)

let emptyWire = try CryptoBridge.encryptChunkForUpload(masterKeyHandle: master, fileId: fileId, plaintext: Data())
let empty = DownloadedEncryptedFile(data: emptyWire, chunkSize: chunkSize, chunkCount: 1)
let emptyPlaintext = try CryptoBridge.decryptDownloadedFile(masterKeyHandle: master, fileId: fileId, encryptedFile: empty, plaintextSize: 0)
assert(emptyPlaintext.isEmpty, "empty files decrypt", count: &count)

expectThrows("truncated body rejected", count: &count) {
  var truncated = wire
  truncated.removeLast()
  _ = try CryptoBridge.decryptDownloadedFile(masterKeyHandle: master, fileId: fileId, encryptedFile: DownloadedEncryptedFile(data: truncated, chunkSize: chunkSize, chunkCount: chunks), plaintextSize: payload.count)
}
expectThrows("tampered body rejected", count: &count) {
  var tampered = wire
  tampered[tampered.count / 2] ^= 0x80
  _ = try CryptoBridge.decryptDownloadedFile(masterKeyHandle: master, fileId: fileId, encryptedFile: DownloadedEncryptedFile(data: tampered, chunkSize: chunkSize, chunkCount: chunks), plaintextSize: payload.count)
}
expectThrows("wrong file id rejected", count: &count) {
  _ = try CryptoBridge.decryptDownloadedFile(masterKeyHandle: master, fileId: "wrong-id", encryptedFile: downloaded, plaintextSize: payload.count)
}
expectThrows("extra trailing bytes rejected", count: &count) {
  var extra = wire
  extra.append(0)
  _ = try CryptoBridge.decryptDownloadedFile(masterKeyHandle: master, fileId: fileId, encryptedFile: DownloadedEncryptedFile(data: extra, chunkSize: chunkSize, chunkCount: chunks), plaintextSize: payload.count)
}

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
  execFileSync('/bin/sh', ['-c', '"$1" > "$2" 2>&1', 'files-codec-test', binary, output], { timeout: 30_000 });
  expect(readFileSync(output, 'utf8')).toContain('PASS FileProvider codec cases=11');
}, 90_000);
