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

  struct DecryptedName {
    let name: String
    let mimeType: String?
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
    try decryptNameWithMime(
      masterKeyHandle: masterKeyHandle,
      fileId: fileId,
      nameEncrypted: nameEncrypted
    ).name
  }

  static func decryptNameWithMime(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    nameEncrypted: String
  ) throws -> DecryptedName {
    if !nameEncrypted.hasPrefix("{") {
      return DecryptedName(name: nameEncrypted, mimeType: nil)
    }

    do {
      let result = try masterKeyHandle.decryptNameWithMime(fileId: fileId, nameEncrypted: nameEncrypted)
      return DecryptedName(name: result.name, mimeType: result.mimeType)
    } catch {
      // Older mobile/web rows used the same file-key metadata primitive but a
      // JSON envelope with base64 fields. Keep that fallback so Files can read
      // mixed accounts while the canonical Rust/Core envelope remains primary.
    }

    let payload = try parseNamePayload(nameEncrypted)
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    let plaintext = try fkh.decryptMetadata(nonce: payload.nonce, ciphertext: payload.ciphertext)
    return parsePlaintextMetadata(plaintext)
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

  static func decryptDownloadedFile(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    encryptedFile: DownloadedEncryptedFile,
    plaintextSize: Int
  ) throws -> Data {
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    let safePlaintextSize = max(0, plaintextSize)
    let chunkSize = max(1, encryptedFile.chunkSize)
    let inferredChunkCount = max(1, Int(ceil(Double(safePlaintextSize) / Double(chunkSize))))
    let chunkCount = max(1, max(encryptedFile.chunkCount, inferredChunkCount))

    var plaintext = Data(capacity: safePlaintextSize)
    var offset = 0

    for index in 0..<chunkCount {
      let isLast = index == chunkCount - 1
      let chunkPlaintextSize: Int
      if chunkCount == 1 {
        chunkPlaintextSize = safePlaintextSize
      } else if isLast {
        chunkPlaintextSize = max(0, safePlaintextSize - index * chunkSize)
      } else {
        chunkPlaintextSize = chunkSize
      }

      let encryptedChunkSize = 12 + chunkPlaintextSize + 16
      guard encryptedFile.data.count >= offset + encryptedChunkSize else {
        throw CryptoBridgeError.decodeFailed
      }
      let chunk = encryptedFile.data.subdata(in: offset..<(offset + encryptedChunkSize))
      guard chunk.count > 12 else { throw CryptoBridgeError.decodeFailed }
      let nonce = chunk.prefix(12)
      let ciphertext = chunk.suffix(from: 12)
      plaintext.append(try fkh.decryptChunk(nonce: nonce, ciphertext: ciphertext))
      offset += encryptedChunkSize
    }

    guard offset == encryptedFile.data.count else {
      throw CryptoBridgeError.decodeFailed
    }
    return plaintext
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
          let object = try? JSONSerialization.jsonObject(with: data),
          let dict = object as? [String: Any],
          let nonce = bytes(from: dict["nonce"] ?? dict["n"]),
          let ciphertext = bytes(from: dict["ciphertext"] ?? dict["c"]) else {
      throw CryptoBridgeError.decodeFailed
    }
    return (nonce, ciphertext)
  }

  private static func bytes(from value: Any?) -> Data? {
    if let string = value as? String {
      return Data(base64Encoded: string)
    }
    guard let array = value as? [Any] else { return nil }
    var data = Data(capacity: array.count)
    for item in array {
      let byte: UInt8?
      if let number = item as? NSNumber {
        byte = UInt8(exactly: number.intValue)
      } else if let int = item as? Int {
        byte = UInt8(exactly: int)
      } else {
        byte = nil
      }
      guard let byte else { return nil }
      data.append(byte)
    }
    return data
  }

  private static func parsePlaintextMetadata(_ plaintext: String) -> DecryptedName {
    guard let data = plaintext.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let dict = object as? [String: Any],
          let name = dict["name"] as? String,
          !name.isEmpty else {
      return DecryptedName(name: plaintext, mimeType: nil)
    }
    return DecryptedName(name: name, mimeType: dict["mime_type"] as? String)
  }

  private static func encodeNamePayload(nonce: Data, ciphertext: Data) throws -> String {
    let payload: [String: String] = [
      "nonce": nonce.base64EncodedString(),
      "ciphertext": ciphertext.base64EncodedString(),
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    guard let str = String(data: data, encoding: .utf8) else { throw CryptoBridgeError.decodeFailed }
    return str
  }
}
