import Foundation
import Security
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "Crypto")

private let kKeychainAccessGroup = "R8352WDJJR.io.beebeeb.shared"
private let kMasterKeyLabel = "io.beebeeb.master-key"
private let kWrappedKeyService = "io.beebeeb.masterkey"
#if DEBUG && targetEnvironment(simulator)
private let kSimulatorSoftwareKeyService = "io.beebeeb.masterkey.simulator-software"
#endif
private let kSEKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
private let kECIESAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
private let kChunkSize = 4 * 1024 * 1024

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
        } catch {
            #if DEBUG && targetEnvironment(simulator)
            logger.warning("Shared Secure Enclave master key unavailable on simulator: \(error.localizedDescription)")
            #else
            logger.error("Failed to load master key: \(error.localizedDescription)")
            return
            #endif
        }

        #if DEBUG && targetEnvironment(simulator)
        do {
            if let keyData = try readSimulatorSoftwareMasterKey(label: kMasterKeyLabel) {
                masterKeyHandle = try MasterKeyHandle.fromKeychainBytes(bytes: keyData)
                logger.info("Master key loaded from DEBUG simulator shared software keychain")
                return
            }
        } catch {
            logger.error("Failed to load simulator software master key: \(error.localizedDescription)")
        }
        #endif

        logger.warning("No extension-readable master key found — crypto operations will fail until App Group keychain sharing is wired")
    }

    // MARK: - Filename Encryption/Decryption

    func decryptFilename(fileId: String, encrypted: String) -> String? {
        guard let mk = masterKeyHandle else { return nil }
        do {
            return try mk.decryptName(fileId: fileId, nameEncrypted: encrypted)
        } catch {
            logger.error("decryptFilename failed for \(fileId): \(error.localizedDescription)")
            return nil
        }
    }

    func encryptFilename(fileId: String, name: String, mimeType: String?) throws -> String {
        guard let mk = masterKeyHandle else { throw FileProviderCryptoError.noMasterKey }
        return try mk.encryptName(fileId: fileId, filename: name, mimeType: mimeType)
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
    private func readSimulatorSoftwareMasterKey(label: String) throws -> Data? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: kSimulatorSoftwareKeyService,
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
        guard status == errSecSuccess, let keyData = result as? Data else {
            throw FileProviderCryptoError.keychainReadFailed(status)
        }
        return keyData
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
