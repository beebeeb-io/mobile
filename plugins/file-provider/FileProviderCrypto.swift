import Foundation
import Security
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "Crypto")

private let kAppGroup = "group.io.beebeeb.shared"
private let kKeychainAccessGroup = "R8352WDJJR.io.beebeeb.shared"
private let kMasterKeyLabel = "io.beebeeb.master-key"
private let kWrappedKeyService = "io.beebeeb.masterkey"
private let kSEKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
private let kECIESAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
private let kChunkSize = 4 * 1024 * 1024
private let kSimulatorFileProviderMasterKeyKey = "io.beebeeb.simulatorFileProviderMasterKey"

class FileProviderCrypto {
    private var masterKeyHandle: MasterKeyHandle?

    init() {
        loadMasterKey()
    }

    // MARK: - Master Key Management

    private func loadMasterKey() {
        do {
            if let keyData = try readWrappedMasterKey(label: kMasterKeyLabel) {
                masterKeyHandle = try MasterKeyHandle.fromKeychainBytes(bytes: keyData)
                logger.info("Master key loaded from shared keychain")
                return
            }

            #if DEBUG && targetEnvironment(simulator)
            if let keyData = readSimulatorMasterKeyFallback() {
                masterKeyHandle = try MasterKeyHandle.fromKeychainBytes(bytes: keyData)
                logger.info("Master key loaded from DEBUG simulator App Group fallback")
                return
            }
            #endif

            logger.warning("No extension-readable master key found — crypto operations will fail until App Group keychain sharing is wired")
            return
        } catch {
            logger.error("Failed to load master key: \(error.localizedDescription)")
        }
    }

    // MARK: - Filename Encryption/Decryption

    func decryptFilename(fileId: String, encrypted: String) -> String? {
        do {
            let metadata = try decryptMetadataString(fileId: fileId, encrypted: encrypted)
            return displayName(fromMetadata: metadata) ?? metadata
        } catch {
            logger.error("decryptFilename failed for \(fileId): \(error.localizedDescription)")
            return nil
        }
    }

    func encryptFilename(fileId: String, name: String, mimeType: String?) throws -> String {
        let metadata = metadataJSON(name: name, mimeType: mimeType)
        let encrypted = try fileKey(for: fileId).encryptMetadata(metadata: metadata)
        return try encryptedPayloadJSON(encrypted)
    }

    // MARK: - File Content Encryption/Decryption

    func decryptFile(
        fileId: String,
        encryptedFile: DownloadedEncryptedFile,
        plaintextSize: Int64,
        metadataChunkCount: Int?
    ) throws -> Data {
        let fk = try fileKey(for: fileId)
        let chunkCount = max(1, metadataChunkCount ?? encryptedFile.chunkCount)
        let plaintextSizeInt = max(0, Int(plaintextSize))
        let chunkSize = max(1, encryptedFile.chunkSize)

        var plaintext = Data()
        var offset = 0

        for index in 0..<chunkCount {
            let isLast = index == chunkCount - 1
            let chunkPlaintextSize: Int
            if chunkCount == 1 {
                chunkPlaintextSize = plaintextSizeInt
            } else if isLast {
                chunkPlaintextSize = max(0, plaintextSizeInt - index * chunkSize)
            } else {
                chunkPlaintextSize = chunkSize
            }

            let encryptedChunkSize = 12 + chunkPlaintextSize + 16
            guard encryptedFile.data.count >= offset + encryptedChunkSize else {
                throw FileProviderCryptoError.invalidChunkFormat
            }

            let chunk = encryptedFile.data.subdata(in: offset..<(offset + encryptedChunkSize))
            guard chunk.count > 12 else {
                throw FileProviderCryptoError.invalidChunkFormat
            }
            let nonce = chunk.prefix(12)
            let ciphertext = chunk.suffix(from: 12)

            let decrypted = try fk.decryptChunk(nonce: nonce, ciphertext: ciphertext)
            plaintext.append(decrypted)
            offset += encryptedChunkSize
        }

        guard offset == encryptedFile.data.count else {
            throw FileProviderCryptoError.invalidChunkFormat
        }

        return plaintext
    }

    func encryptFile(fileId: String, plaintext: Data) throws -> [Data] {
        let fk = try fileKey(for: fileId)

        var chunks: [Data] = []
        var offset = 0

        repeat {
            let end = min(offset + kChunkSize, plaintext.count)
            let chunkData = plaintext.subdata(in: offset..<end)

            let encrypted = try fk.encryptChunk(plaintext: chunkData)

            var chunkBlob = Data()
            chunkBlob.append(encrypted.nonce)
            chunkBlob.append(encrypted.ciphertext)
            chunks.append(chunkBlob)

            offset = end
        } while offset < plaintext.count

        return chunks
    }

    // MARK: - Shared Keychain Access

    private func fileKey(for fileId: String) throws -> FileKeyHandle {
        if masterKeyHandle == nil {
            loadMasterKey()
        }
        guard let mk = masterKeyHandle else {
            throw FileProviderCryptoError.noMasterKey
        }
        return try mk.deriveFileKey(fileId: Data(fileId.utf8))
    }

    private func decryptMetadataString(fileId: String, encrypted: String) throws -> String {
        guard
            let jsonData = encrypted.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: String],
            let nonceB64 = json["nonce"] ?? json["n"],
            let ciphertextB64 = json["ciphertext"] ?? json["c"],
            let nonce = Data(base64Encoded: nonceB64),
            let ciphertext = Data(base64Encoded: ciphertextB64)
        else {
            return encrypted
        }

        return try fileKey(for: fileId).decryptMetadata(nonce: nonce, ciphertext: ciphertext)
    }

    private func displayName(fromMetadata metadata: String) -> String? {
        guard
            let data = metadata.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let name = object["name"] as? String,
            !name.isEmpty
        else {
            return nil
        }
        return name
    }

    private func metadataJSON(name: String, mimeType: String?) -> String {
        let object: [String: Any] = [
            "name": name,
            "mime_type": mimeType as Any? ?? NSNull(),
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: object),
            let value = String(data: data, encoding: .utf8)
        else {
            return name
        }
        return value
    }

    private func encryptedPayloadJSON(_ encrypted: EncryptedData) throws -> String {
        let payload: [String: String] = [
            "nonce": encrypted.nonce.base64EncodedString(),
            "ciphertext": encrypted.ciphertext.base64EncodedString(),
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let value = String(data: data, encoding: .utf8) else {
            throw FileProviderCryptoError.invalidMetadataFormat
        }
        return value
    }

    private func readWrappedMasterKey(label: String) throws -> Data? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: kWrappedKeyService,
            kSecAttrAccount: label,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        addAppGroupKeychainAccessGroupIfConfigured(to: &query)

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let wrapped = result as? Data else {
            throw FileProviderCryptoError.keychainReadFailed(status)
        }
        guard let seKey = findSEKey() else {
            throw FileProviderCryptoError.noMasterKey
        }

        var cfError: Unmanaged<CFError>?
        guard let plaintext = SecKeyCreateDecryptedData(seKey, kECIESAlgorithm, wrapped as CFData, &cfError) else {
            throw FileProviderCryptoError.keychainDecryptFailed
        }
        return plaintext as Data
    }

    #if DEBUG && targetEnvironment(simulator)
    private func readSimulatorMasterKeyFallback() -> Data? {
        guard
            let encoded = UserDefaults(suiteName: kAppGroup)?.string(forKey: kSimulatorFileProviderMasterKeyKey),
            let data = Data(base64Encoded: encoded),
            data.count == 32
        else {
            return nil
        }
        return data
    }
    #endif

    private func findSEKey() -> SecKey? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag: kSEKeyTag,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecReturnRef: true,
        ]
        addAppGroupKeychainAccessGroupIfConfigured(to: &query)

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let object = result else {
            return nil
        }
        return unsafeBitCast(object, to: SecKey.self)
    }

    private func addAppGroupKeychainAccessGroupIfConfigured(to query: inout [CFString: Any]) {
        query[kSecAttrAccessGroup] = kKeychainAccessGroup
    }
}

enum FileProviderCryptoError: Error, LocalizedError {
    case noMasterKey
    case invalidChunkFormat
    case invalidMetadataFormat
    case keychainReadFailed(OSStatus)
    case keychainDecryptFailed

    var errorDescription: String? {
        switch self {
        case .noMasterKey:
            return "No master key available to the File Provider. Open Beebeeb and unlock the vault."
        case .invalidChunkFormat:
            return "Invalid encrypted chunk format."
        case .invalidMetadataFormat:
            return "Invalid encrypted metadata format."
        case .keychainReadFailed(let status):
            return "File Provider keychain read failed (\(status))."
        case .keychainDecryptFailed:
            return "File Provider could not unwrap the master key."
        }
    }
}
