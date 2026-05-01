import Foundation

/// Thin shim wrapping beebeeb-core UniFFI calls for use in the Share Extension.
///
/// Phase 1 (current): BeebeebCore.xcframework not yet linked — all calls
/// throw NotLinkedError. Callers must catch and fall back to plaintext staging.
///
/// Phase 2: Once repos/core/build-ios.sh produces BeebeebCore.xcframework and
/// it is linked via expo-target.config.js, replace the throw stubs with actual
/// UniFFI calls:
///   - encryptChunk(data, key) → BeebeebCoreFFI.encryptChunk(chunk, fileKey)
///   - deriveFileKey(masterKey, fileID) → BeebeebCoreFFI.deriveFileKey(masterKey, fileID)
///   - encryptFilename(name, masterKey, fileID) → BeebeebCoreFFI.encryptMetadata(name, fileKey)
enum BeebeebCryptoShim {

    struct NotLinkedError: LocalizedError {
        var errorDescription: String? {
            "BeebeebCore.xcframework not linked — run repos/core/build-ios.sh"
        }
    }

    /// Encrypt `data` using AES-256-GCM with a key derived from `masterKey` + `fileID`.
    /// Returns the concatenated ciphertext (all chunks joined).
    static func encrypt(data: Data, masterKey: Data, fileID: String) throws -> Data {
        // Phase 2: replace with real UniFFI calls
        // let fileKey = try BeebeebCoreFFI.deriveFileKey(masterKey: masterKey, fileId: fileID)
        // let (ciphertext, nonce, tag) = try BeebeebCoreFFI.encryptChunk(chunk: data, fileKey: fileKey)
        // return nonce + ciphertext + tag
        throw NotLinkedError()
    }

    /// Encrypt `filename` using AES-256-GCM with the file key derived from `masterKey` + `fileID`.
    /// Returns the Base64-encoded ciphertext (safe for use in HTTP headers).
    static func encryptFilename(_ filename: String, masterKey: Data, fileID: String) throws -> String {
        // Phase 2: replace with real UniFFI calls
        // let fileKey = try BeebeebCoreFFI.deriveFileKey(masterKey: masterKey, fileId: fileID)
        // let nameData = filename.data(using: .utf8) ?? Data()
        // let (ciphertext, nonce, tag) = try BeebeebCoreFFI.encryptChunk(chunk: nameData, fileKey: fileKey)
        // return (nonce + ciphertext + tag).base64EncodedString()
        throw NotLinkedError()
    }
}
