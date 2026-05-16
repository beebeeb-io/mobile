import Foundation

// MARK: - File-scope free-function references
//
// Swift name resolution can pick `BeebeebCryptoShim.encryptChunk` over the
// UniFFI free function inside our static methods, causing infinite recursion.
// Capture the free functions at file scope where free functions resolve first.

fileprivate let _deriveFileKey: (Data, Data) throws -> Data = deriveFileKey(masterKey:fileId:)
fileprivate let _encryptChunk: (Data, Data) throws -> EncryptedData = encryptChunk(key:plaintext:)
fileprivate let _encryptName: (Data, String, String, String?) throws -> String = encryptName(masterKey:fileId:filename:mimeType:)

/// Thin shim wrapping beebeeb-core UniFFI calls for use in the Share Extension.
///
/// Phase 2 (current): BeebeebCore.xcframework is linked. Calls go through real
/// UniFFI crypto (AES-256-GCM via the Rust core). Falls back to staging if the
/// master key is unavailable (e.g. device locked, keychain inaccessible).
enum BeebeebCryptoShim {

    enum CryptoError: LocalizedError {
        case noMasterKey
        case encryptionFailed(String)

        var errorDescription: String? {
            switch self {
            case .noMasterKey:
                return "Master key not available — open Beebeeb and sign in"
            case .encryptionFailed(let msg):
                return "Encryption failed: \(msg)"
            }
        }
    }

    /// Encrypt `data` using AES-256-GCM with a key derived from `masterKey` + `fileID`.
    /// Returns nonce + ciphertext concatenated (the format the server expects per chunk).
    static func encrypt(data: Data, masterKey: Data, fileID: String) throws -> Data {
        let fileIdData = Data(fileID.utf8)
        let fileKey = try _deriveFileKey(masterKey, fileIdData)
        let encrypted = try _encryptChunk(fileKey, data)
        // Server expects: nonce || ciphertext (GCM tag is appended inside ciphertext by Rust)
        return encrypted.nonce + encrypted.ciphertext
    }

    /// Encrypt `filename` into the canonical JSON envelope the server expects.
    /// Uses the high-level `encryptName` UniFFI function which returns a JSON string
    /// containing cipher_suite, nonce (base64), and ciphertext (base64).
    static func encryptFilename(_ filename: String, masterKey: Data, fileID: String) throws -> String {
        return try _encryptName(masterKey, fileID, filename, nil)
    }
}
