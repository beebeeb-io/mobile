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

    // MARK: - In-process master key cache
    //
    // Avoids repeated Keychain reads (which can trigger Face ID / passcode)
    // during hot paths like thumbnail decrypt and backup stop/start cycles.
    // The cache is populated on first successful load and cleared when the
    // unlocked JS master-key handles are released, such as app lock or sign-out.

    private static var cachedMasterKey: MasterKeyHandle?
    private static let masterKeyCacheLock = NSLock()

    static func setCachedMasterKey(_ handle: MasterKeyHandle?) {
        masterKeyCacheLock.lock()
        cachedMasterKey = handle
        masterKeyCacheLock.unlock()
        RuntimeTrace.event("native_master_key_cache.set", ["hasHandle": handle != nil])
    }

    static func hasCachedMasterKey() -> Bool {
        masterKeyCacheLock.lock()
        let hasCached = cachedMasterKey != nil
        masterKeyCacheLock.unlock()
        return hasCached
    }

    static func cachedMasterKeyIfAvailable() -> MasterKeyHandle? {
        masterKeyCacheLock.lock()
        let cached = cachedMasterKey
        masterKeyCacheLock.unlock()
        if cached != nil {
            RuntimeTrace.event("native_master_key_cache.hit")
        }
        return cached
    }

    static func clearCachedMasterKey() {
        masterKeyCacheLock.lock()
        cachedMasterKey = nil
        masterKeyCacheLock.unlock()
        RuntimeTrace.event("native_master_key_cache.clear")
    }

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
    /// Uses an in-process cache to avoid repeated biometric prompts.
    static func loadMasterKey() throws -> MasterKeyHandle? {
        masterKeyCacheLock.lock()
        if let cached = cachedMasterKey {
            masterKeyCacheLock.unlock()
            RuntimeTrace.event("native_master_key_cache.hit")
            return cached
        }
        masterKeyCacheLock.unlock()

        RuntimeTrace.event("native_master_key_cache.miss", [
            "source": "BeebeebCryptoBridge.loadMasterKey",
            "promptMayAppear": true
        ])
        if let bytes = try KeychainManager.load(label: kMasterKeyLabel) {
            let handle = try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
            setCachedMasterKey(handle)
            RuntimeTrace.event("native_master_key_cache.loaded_from_keychain")
            return handle
        }
        #if targetEnvironment(simulator)
        if let bytes = loadSimulatorFallbackMasterKey() {
            let handle = try MasterKeyHandle.fromKeychainBytes(bytes: bytes)
            setCachedMasterKey(handle)
            RuntimeTrace.event("native_master_key_cache.loaded_from_simulator_file")
            return handle
        }
        #endif
        RuntimeTrace.event("native_master_key_cache.load_miss")
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

    static func decryptChunkWithCachedMasterKey(fileId: String, nonce: Data, ciphertext: Data) throws -> Data? {
        masterKeyCacheLock.lock()
        let cached = cachedMasterKey
        masterKeyCacheLock.unlock()

        guard let cached else {
            RuntimeTrace.event("native_master_key_cache.thumbnail_decrypt_miss", [
                "fileId": fileId,
                "promptMayAppear": false
            ])
            return nil
        }

        let fileKey = try cached.deriveFileKey(fileId: Data(fileId.utf8))
        RuntimeTrace.event("native_master_key_cache.thumbnail_decrypt_key_ready", ["fileId": fileId])
        return try fileKey.decryptChunk(nonce: nonce, ciphertext: ciphertext)
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
