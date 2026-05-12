import Foundation

// MARK: - File-scope free-function references
//
// Swift name resolution would otherwise pick `BeebeebCryptoBridge.encryptChunk`
// over the UniFFI free function inside our static methods, causing infinite
// recursion. Capture the free functions at file scope (where free functions
// resolve first) and call through these aliases instead.

fileprivate let _uniffiDeriveFileKey: (Data, Data) throws -> Data = deriveFileKey(masterKey:fileId:)
fileprivate let _uniffiEncryptChunk: (Data, Data) throws -> EncryptedData = encryptChunk(key:plaintext:)
fileprivate let _uniffiDecryptChunk: (Data, Data, Data) throws -> Data = decryptChunk(key:nonce:ciphertext:)
fileprivate let _uniffiEncryptMetadata: (Data, String) throws -> EncryptedData = encryptMetadata(key:metadata:)
fileprivate let _uniffiDecryptMetadata: (Data, Data, Data) throws -> String = decryptMetadata(key:nonce:ciphertext:)

/// Bridge between the Expo native module (`BeebeebCryptoModule`) and the UniFFI
/// Rust crypto bindings shipped in `BeebeebCore.xcframework`.
///
/// The master key never leaves Rust except via the Secure Enclave-wrapped
/// keychain. `loadMasterKey()` reconstructs a `MasterKeyHandle` from the bytes
/// returned by `KeychainManager.load(label:)`; thereafter all derivations and
/// crypto run inside Rust.
enum BeebeebCryptoBridge {

    /// The keychain label under which the wrapped master key is stored.
    /// Must match the label used by the JS layer when calling `storeKeyInKeychain`.
    static let kMasterKeyLabel = "io.beebeeb.master-key"

    enum BridgeError: LocalizedError {
        case noMasterKey

        var errorDescription: String? {
            switch self {
            case .noMasterKey:
                return "Master key not available — open Beebeeb and sign in."
            }
        }
    }

    // MARK: - Master key

    /// Decrypt the wrapped master key from the Secure Enclave-backed keychain
    /// and reconstruct a `MasterKeyHandle`. Returns `nil` if no key is stored.
    /// May trigger a biometric/passcode prompt if SE access control requires it.
    static func loadMasterKey() throws -> MasterKeyHandle? {
        if let bytes = try KeychainManager.load(label: kMasterKeyLabel) {
            return try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
        }
        #if targetEnvironment(simulator)
        if let bytes = loadSimulatorFallbackMasterKey() {
            return try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
        }
        #endif
        return nil
    }

    /// Same as `loadMasterKey()` but throws `BridgeError.noMasterKey` if no key
    /// is stored, for callers that always require a key.
    static func requireMasterKey() throws -> MasterKeyHandle {
        guard let mk = try loadMasterKey() else { throw BridgeError.noMasterKey }
        return mk
    }

    // MARK: - Pure crypto pass-throughs (key passed explicitly from JS)

    static func deriveFileKey(masterKey: Data, fileId: String) throws -> Data {
        return try _uniffiDeriveFileKey(masterKey, Data(fileId.utf8))
    }

    static func encryptChunk(key: Data, plaintext: Data) throws -> EncryptedData {
        return try _uniffiEncryptChunk(key, plaintext)
    }

    static func decryptChunk(key: Data, nonce: Data, ciphertext: Data) throws -> Data {
        return try _uniffiDecryptChunk(key, nonce, ciphertext)
    }

    static func encryptMetadata(key: Data, metadata: String) throws -> EncryptedData {
        return try _uniffiEncryptMetadata(key, metadata)
    }

    static func decryptMetadata(key: Data, nonce: Data, ciphertext: Data) throws -> String {
        return try _uniffiDecryptMetadata(key, nonce, ciphertext)
    }

    #if targetEnvironment(simulator)
    private static func loadSimulatorFallbackMasterKey() -> Data? {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }
        let url = documents.appendingPathComponent("beebeeb-simulator-master-key.txt")
        guard let encoded = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return Data(base64Encoded: encoded.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    #endif
}
