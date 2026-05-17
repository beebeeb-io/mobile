import Foundation

// The UniFFI-generated Swift bindings (beebeeb_uniffi.swift) are compiled
// directly into this extension target. The static library from the
// BeebeebCore.xcframework (module: beebeeb_uniffiFFI) is linked in.
// No conditional import needed — the types (MasterKeyHandle, FileKeyHandle,
// EncryptedData) are available at compile time.

enum CryptoBridge {
  enum CryptoBridgeError: Error {
    case decodeFailed
    case keyUnavailable
  }

  struct EncryptedNamePayload: Codable {
    let nonce: String
    let ciphertext: String
  }

  // MARK: - Key access

  static func loadMasterKeyHandle() throws -> MasterKeyHandle {
    var bytes = try KeychainKeyLoader.loadMasterKey()
    defer {
      bytes.withUnsafeMutableBytes { buf in
        if let ptr = buf.baseAddress { memset(ptr, 0, buf.count) }
      }
    }
    return try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
  }

  // MARK: - Filename codec

  static func decryptFilename(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    nameEncrypted: String
  ) throws -> String {
    let payload = try parseNamePayload(nameEncrypted)
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    return try fkh.decryptMetadata(nonce: payload.nonce, ciphertext: payload.ciphertext)
  }

  static func encryptFilename(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    filename: String
  ) throws -> String {
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    let blob = try fkh.encryptMetadata(metadata: filename)
    return try encodeNamePayload(nonce: blob.nonce, ciphertext: blob.ciphertext)
  }

  // MARK: - Chunk codec

  static func decryptDownloadedBlob(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    blob: Data
  ) throws -> Data {
    guard blob.count > 12 else { throw CryptoBridgeError.decodeFailed }
    let nonce = blob.prefix(12)
    let ciphertext = blob.suffix(from: 12)
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    return try fkh.decryptChunk(nonce: nonce, ciphertext: ciphertext)
  }

  static func encryptChunkForUpload(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    plaintext: Data
  ) throws -> Data {
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    let blob = try fkh.encryptChunk(plaintext: plaintext)
    var combined = Data(capacity: blob.nonce.count + blob.ciphertext.count)
    combined.append(blob.nonce)
    combined.append(blob.ciphertext)
    return combined
  }

  // MARK: - Helpers

  private static func parseNamePayload(_ raw: String) throws -> (nonce: Data, ciphertext: Data) {
    guard let data = raw.data(using: .utf8),
          let payload = try? JSONDecoder().decode(EncryptedNamePayload.self, from: data),
          let nonce = Data(base64Encoded: payload.nonce),
          let ciphertext = Data(base64Encoded: payload.ciphertext) else {
      throw CryptoBridgeError.decodeFailed
    }
    return (nonce, ciphertext)
  }

  private static func encodeNamePayload(nonce: Data, ciphertext: Data) throws -> String {
    let payload = EncryptedNamePayload(
      nonce: nonce.base64EncodedString(),
      ciphertext: ciphertext.base64EncodedString()
    )
    let data = try JSONEncoder().encode(payload)
    guard let str = String(data: data, encoding: .utf8) else { throw CryptoBridgeError.decodeFailed }
    return str
  }
}
