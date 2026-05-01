import Foundation
import Security
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "Crypto")

private let kAppGroup = "group.io.beebeeb.shared"
private let kMasterKeyLabel = "io.beebeeb.master-key"
private let kChunkSize = 4 * 1024 * 1024 // 4 MB per chunk, matching server

class FileProviderCrypto {
    private var masterKeyHandle: MasterKeyHandle?

    init() {
        loadMasterKey()
    }

    // MARK: - Master Key Management

    private func loadMasterKey() {
        guard let keyData = readFromSharedKeychain(label: kMasterKeyLabel) else {
            logger.warning("No master key found in shared keychain — crypto operations will fail")
            return
        }

        do {
            masterKeyHandle = try MasterKeyHandle.fromKeychainBytes(bytes: keyData)
            logger.info("Master key loaded from shared keychain")
        } catch {
            logger.error("Failed to construct MasterKeyHandle: \(error.localizedDescription)")
        }
    }

    // MARK: - Filename Encryption/Decryption

    func decryptFilename(fileId: String, encrypted: String) -> String? {
        guard let mk = masterKeyHandle else { return nil }

        do {
            let fileIdBytes = Array(fileId.utf8)
            let fk = try mk.deriveFileKey(fileId: fileIdBytes)

            // Encrypted filenames are stored as JSON: {"cs":"V1Aes256Gcm","n":"base64...","c":"base64..."}
            guard let jsonData = encrypted.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: String],
                  let nonceB64 = json["n"],
                  let ciphertextB64 = json["c"],
                  let nonce = Data(base64Encoded: nonceB64),
                  let ciphertext = Data(base64Encoded: ciphertextB64)
            else {
                // Not JSON-encrypted — might be a plaintext name
                return encrypted
            }

            return try fk.decryptMetadata(nonce: Array(nonce), ciphertext: Array(ciphertext))
        } catch {
            logger.error("decryptFilename failed for \(fileId): \(error.localizedDescription)")
            return nil
        }
    }

    func encryptFilename(parentId: String?, name: String) throws -> String {
        guard let mk = masterKeyHandle else {
            throw FileProviderCryptoError.noMasterKey
        }

        // Use the parent folder's ID as the file ID for name encryption
        // (or a fixed "root" label for root-level items)
        let context = parentId ?? "root"
        let contextBytes = Array(context.utf8)
        let fk = try mk.deriveFileKey(fileId: contextBytes)

        let encrypted = try fk.encryptMetadata(metadata: name)
        let nonceB64 = Data(encrypted.nonce).base64EncodedString()
        let ciphertextB64 = Data(encrypted.ciphertext).base64EncodedString()

        let json: [String: String] = [
            "cs": encrypted.cipherSuite,
            "n": nonceB64,
            "c": ciphertextB64,
        ]

        let jsonData = try JSONSerialization.data(withJSONObject: json)
        return String(data: jsonData, encoding: .utf8) ?? ""
    }

    // MARK: - File Content Encryption/Decryption

    func decryptFile(fileId: String, encryptedChunks: [Data]) throws -> Data {
        guard let mk = masterKeyHandle else {
            throw FileProviderCryptoError.noMasterKey
        }

        let fileIdBytes = Array(fileId.utf8)
        let fk = try mk.deriveFileKey(fileId: fileIdBytes)

        var plaintext = Data()
        for chunk in encryptedChunks {
            // Each chunk is stored as: nonce (12 bytes) || ciphertext (includes GCM tag)
            guard chunk.count > 12 else {
                throw FileProviderCryptoError.invalidChunkFormat
            }
            let nonce = Array(chunk.prefix(12))
            let ciphertext = Array(chunk.suffix(from: 12))

            let decrypted = try fk.decryptChunk(nonce: nonce, ciphertext: ciphertext)
            plaintext.append(Data(decrypted))
        }

        return plaintext
    }

    func encryptFile(parentId: String?, plaintext: Data) throws -> [Data] {
        guard let mk = masterKeyHandle else {
            throw FileProviderCryptoError.noMasterKey
        }

        // Generate a new file key for this upload
        let fileId = UUID().uuidString
        let fileIdBytes = Array(fileId.utf8)
        let fk = try mk.deriveFileKey(fileId: fileIdBytes)

        var chunks: [Data] = []
        var offset = 0

        while offset < plaintext.count {
            let end = min(offset + kChunkSize, plaintext.count)
            let chunkData = Array(plaintext[offset..<end])

            let encrypted = try fk.encryptChunk(plaintext: chunkData)

            // Store as: nonce || ciphertext
            var chunkBlob = Data(encrypted.nonce)
            chunkBlob.append(Data(encrypted.ciphertext))
            chunks.append(chunkBlob)

            offset = end
        }

        return chunks
    }

    // MARK: - Shared Keychain Access

    private func readFromSharedKeychain(label: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrLabel as String: label,
            kSecAttrAccessGroup as String: kAppGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess, let data = result as? Data {
            return data
        }

        logger.debug("Keychain read for '\(label)' returned status \(status)")
        return nil
    }
}

enum FileProviderCryptoError: Error, LocalizedError {
    case noMasterKey
    case invalidChunkFormat

    var errorDescription: String? {
        switch self {
        case .noMasterKey:
            return "No master key available. Please open Beebeeb and sign in."
        case .invalidChunkFormat:
            return "Invalid encrypted chunk format."
        }
    }
}
