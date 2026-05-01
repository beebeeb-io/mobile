import Foundation

// BeebeebCore is the UniFFI-generated Swift binding for the Rust crypto crate.
// The xcframework is produced by `repos/core/build-ios.sh`. Linking it into
// this extension target requires updating `modules/beebeeb-crypto/app.plugin.js`
// (Phase 2) so that `withXcodeProject` embeds the xcframework into both the
// main app AND every extension target. Until then, this import will fail to
// resolve at link time even though the source compiles.
#if canImport(BeebeebCore)
import BeebeebCore
#endif

/// Wraps the BeebeebCore handle-based API for use inside the File Provider.
///
/// All methods are best-effort: if the xcframework is not yet linked, calls
/// throw `CryptoBridgeError.notLinked`. The extension surfaces this as a
/// generic "Beebeeb is not ready" error to the system rather than crashing,
/// so the Files app can keep rendering metadata it already cached.
enum CryptoBridge {
  enum CryptoBridgeError: Error {
    case notLinked
    case decodeFailed
    case keyUnavailable
  }

  /// Encoded `{nonce, ciphertext}` pair as it appears in `name_encrypted` on
  /// the wire — base64 strings, mirroring the web client.
  struct EncryptedNamePayload: Codable {
    let nonce: String
    let ciphertext: String
  }

  // MARK: - Key access

  /// Load the wrapped master key from the App Group Keychain, decrypt it via
  /// the Secure Enclave, and lift it into a `MasterKeyHandle` that owns the
  /// raw bytes inside Rust memory. The returned handle deinit zeroes the key.
  static func loadMasterKeyHandle() throws -> Any {
    var bytes = try KeychainKeyLoader.loadMasterKey()
    defer {
      // Zero out the byte buffer once Rust has copied it into a handle.
      bytes.withUnsafeMutableBytes { buf in
        if let ptr = buf.baseAddress { memset(ptr, 0, buf.count) }
      }
    }

    #if canImport(BeebeebCore)
    return try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
    #else
    throw CryptoBridgeError.notLinked
    #endif
  }

  // MARK: - Filename codec

  /// Decode the JSON `{nonce, ciphertext}` blob the API returns for filenames
  /// and decrypt it using the file key derived from `fileId`.
  static func decryptFilename(
    masterKeyHandle: Any,
    fileId: String,
    nameEncrypted: String
  ) throws -> String {
    let payload = try parseNamePayload(nameEncrypted)

    #if canImport(BeebeebCore)
    guard let mkh = masterKeyHandle as? MasterKeyHandle else { throw CryptoBridgeError.keyUnavailable }
    let fkh = try mkh.deriveFileKey(fileId: Data(fileId.utf8))
    return try fkh.decryptMetadata(nonce: payload.nonce, ciphertext: payload.ciphertext)
    #else
    _ = payload
    throw CryptoBridgeError.notLinked
    #endif
  }

  /// Encrypt `filename` for upload, returning the JSON blob the server stores
  /// in `name_encrypted`.
  static func encryptFilename(
    masterKeyHandle: Any,
    fileId: String,
    filename: String
  ) throws -> String {
    #if canImport(BeebeebCore)
    guard let mkh = masterKeyHandle as? MasterKeyHandle else { throw CryptoBridgeError.keyUnavailable }
    let fkh = try mkh.deriveFileKey(fileId: Data(fileId.utf8))
    let blob = try fkh.encryptMetadata(metadata: filename)
    return try encodeNamePayload(nonce: blob.nonce, ciphertext: blob.ciphertext)
    #else
    _ = (masterKeyHandle, fileId, filename)
    throw CryptoBridgeError.notLinked
    #endif
  }

  // MARK: - Chunk codec

  /// Decrypt a downloaded blob, assuming the on-the-wire format is
  /// `nonce(12) ‖ ciphertext` produced by the web upload client.
  static func decryptDownloadedBlob(
    masterKeyHandle: Any,
    fileId: String,
    blob: Data
  ) throws -> Data {
    guard blob.count > 12 else { throw CryptoBridgeError.decodeFailed }
    let nonce = blob.prefix(12)
    let ciphertext = blob.suffix(from: 12)

    #if canImport(BeebeebCore)
    guard let mkh = masterKeyHandle as? MasterKeyHandle else { throw CryptoBridgeError.keyUnavailable }
    let fkh = try mkh.deriveFileKey(fileId: Data(fileId.utf8))
    return try fkh.decryptChunk(nonce: nonce, ciphertext: ciphertext)
    #else
    _ = (nonce, ciphertext)
    throw CryptoBridgeError.notLinked
    #endif
  }

  /// Encrypt `plaintext` for upload, returning the on-the-wire `nonce ‖ ciphertext`
  /// blob that matches the format the existing servers and web client use.
  static func encryptChunkForUpload(
    masterKeyHandle: Any,
    fileId: String,
    plaintext: Data
  ) throws -> Data {
    #if canImport(BeebeebCore)
    guard let mkh = masterKeyHandle as? MasterKeyHandle else { throw CryptoBridgeError.keyUnavailable }
    let fkh = try mkh.deriveFileKey(fileId: Data(fileId.utf8))
    let blob = try fkh.encryptChunk(plaintext: plaintext)
    var combined = Data(capacity: blob.nonce.count + blob.ciphertext.count)
    combined.append(blob.nonce)
    combined.append(blob.ciphertext)
    return combined
    #else
    _ = (masterKeyHandle, fileId, plaintext)
    throw CryptoBridgeError.notLinked
    #endif
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
