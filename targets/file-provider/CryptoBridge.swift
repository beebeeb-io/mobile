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
    /// Task 1594 round 2 (F3): the shared owner record is missing, or does
    /// not match the currently signed-in user mirrored alongside the session
    /// token. Thrown INSTEAD of ever loading the key.
    case ownerUnverified
  }

  struct DecryptedName {
    let name: String
    let mimeType: String?
  }

  /// SF-0002 M2a run 3: a name read through the owner resolver, with the id
  /// convention it authenticated under (`string` / `binary` / `upper_repair`).
  struct OwnerDecryptedName {
    let name: String
    let mimeType: String?
    let convention: String
  }

  // MARK: - Key ownership (task 1594 round 2, F3)

  /// The vault key's proven owner (`BeebeebCryptoModule.mirrorKeyOwner`) and
  /// the currently signed-in user (`mirrorSessionUserId`) — both written by
  /// the MAIN APP ONLY, into the SAME shared keychain access group +
  /// accessibility as the master key itself (F6), so this extension needs no
  /// bridge back to the app to read them. Public so `FileProviderExtension`
  /// can decide when a cached handle must be dropped (F3: "drop the cached
  /// handle when the owner record changes") without loading a new one.
  static func currentKeyOwner() -> String? {
    BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.masterKeyOwnerKey)
  }

  /// Task 1594 round 3 (Codex T4): the currently signed-in user, mirrored by
  /// the main app alongside the owner record above. Public (like
  /// `currentKeyOwner()`) so a caller that CACHES a loaded handle can key
  /// that cache on BOTH values, not the owner alone — see
  /// `FileProviderExtension.masterKey()`.
  static func currentSignedInUser() -> String? {
    BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.sessionUserIdKey)
  }

  /// `true` only when an owner record exists AND matches the signed-in user.
  /// Both being present-but-different, or either being absent, refuse — this
  /// is the fix for the round-1 gap where `loadMasterKeyHandle()` used
  /// whatever key was in the keychain with no ownership check at all, so an
  /// unbound/unverifiable/leftover key (the exact 1594 bug class) stayed
  /// usable by Files.app regardless of what the main app's own (JS-only)
  /// ownership check was doing.
  private static func ownershipVerified() -> Bool {
    guard let owner = currentKeyOwner(), !owner.isEmpty else { return false }
    guard let signedInUser = currentSignedInUser(), !signedInUser.isEmpty else { return false }
    return owner == signedInUser
  }

  // MARK: - Key access

  static func loadMasterKeyHandle() throws -> MasterKeyHandle {
    guard ownershipVerified() else {
      throw CryptoBridgeError.ownerUnverified
    }
    // Files must use its dedicated unlocked-device SE key. Never fall back
    // to the primary or shared backup/share keys, which may require a prompt
    // that this extension cannot present.
    var bytes = try BeebeebKeychainCore.loadMasterKeyThrowing(
      label: BeebeebConstants.masterKeyLabel,
      mode: .fileProviderOnly
    )
    defer {
      bytes.withUnsafeMutableBytes { buf in
        if let ptr = buf.baseAddress { memset(ptr, 0, buf.count) }
      }
    }
    do {
      return try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
    } catch {
      // Task 1722 (c): unwrapped bytes that do not form a key are an
      // unavailable key (Files shows "Authentication Required" and retries
      // after the app re-provisions it), not a generic sync failure.
      throw CryptoBridgeError.keyUnavailable
    }
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

  /// The owner name resolver, for an owned row. Reports the exact convention
  /// the ciphertext authenticated under; the key never leaves the handle.
  static func resolveOwnerNameWithMime(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    nameEncrypted: String
  ) throws -> OwnerDecryptedName {
    let resolved = try masterKeyHandle.ownerFileKeyForName(fileId: fileId, nameEncrypted: nameEncrypted)
    let meta = try resolved.key.decryptNameMetadata(nameEncrypted: nameEncrypted)
    let convention: String
    switch resolved.convention {
    case .string: convention = "string"
    case .binary: convention = "binary"
    case .upperRepair: convention = "upper_repair"
    }
    return OwnerDecryptedName(name: meta.name, mimeType: meta.mimeType, convention: convention)
  }

  /// SF-0002 M2a run 3: classify one owned content version from its first
  /// chunk frame. Returns `string`, `binary` or `upper_repair`; nil when the
  /// frame does not authenticate.
  static func classifyOwnerContent(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    firstChunkFrame: Data
  ) -> String? {
    guard let resolved = try? masterKeyHandle.ownerFileKeyForContent(
      fileId: fileId, firstChunkFrame: firstChunkFrame) else { return nil }
    switch resolved.convention {
    case .string: return "string"
    case .binary: return "binary"
    case .upperRepair: return "upper_repair"
    }
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

  /// Decrypts the downloaded ciphertext into a new file at `destination`.
  ///
  /// Task 1722 (G5): one chunk at a time. At most one ciphertext chunk and
  /// one plaintext chunk (about 2 x the 4 MiB chunk size) are in memory, so
  /// the 59.8 MB DNG no longer needs ~120 MB against the extension's ~50 MB
  /// budget. `shouldContinue` runs before every chunk; when it returns false
  /// the call stops with `CancellationError` (the caller deletes the partial
  /// output). Any framing mismatch (short chunk, trailing bytes, a chunk that
  /// does not authenticate) throws, so a truncated or tampered file never
  /// comes back as a shorter plaintext.
  static func decryptDownloadedFile(
    masterKeyHandle: MasterKeyHandle,
    fileId: String,
    encryptedFile: DownloadedEncryptedFile,
    plaintextSize: Int,
    to destination: URL,
    shouldContinue: () -> Bool
  ) throws {
    let fkh = try masterKeyHandle.deriveFileKey(fileId: Data(fileId.utf8))
    let safePlaintextSize = max(0, plaintextSize)
    let chunkSize = max(1, encryptedFile.chunkSize)
    let inferredChunkCount = max(1, Int(ceil(Double(safePlaintextSize) / Double(chunkSize))))
    let chunkCount = max(1, max(encryptedFile.chunkCount, inferredChunkCount))

    let input = try FileHandle(forReadingFrom: encryptedFile.url)
    defer { try? input.close() }
    guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
      throw CocoaError(.fileWriteUnknown)
    }
    let output = try FileHandle(forWritingTo: destination)
    defer { try? output.close() }

    for index in 0..<chunkCount {
      guard shouldContinue() else { throw CancellationError() }
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
      try autoreleasepool { () throws -> Void in
        let chunk = try readExactly(input, count: encryptedChunkSize)
        guard chunk.count == encryptedChunkSize else { throw CryptoBridgeError.decodeFailed }
        let nonce = chunk.prefix(12)
        let ciphertext = chunk.suffix(from: chunk.startIndex + 12)
        try output.write(contentsOf: try fkh.decryptChunk(nonce: nonce, ciphertext: ciphertext))
      }
    }

    // Bytes after the last expected chunk mean the layout did not match.
    guard try readExactly(input, count: 1).isEmpty else {
      throw CryptoBridgeError.decodeFailed
    }
  }

  /// Reads `count` bytes, or fewer only at end of file.
  private static func readExactly(_ handle: FileHandle, count: Int) throws -> Data {
    guard var data = try handle.read(upToCount: count) else { return Data() }
    while data.count < count {
      guard let next = try handle.read(upToCount: count - data.count), !next.isEmpty else { break }
      data.append(next)
    }
    return data
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
