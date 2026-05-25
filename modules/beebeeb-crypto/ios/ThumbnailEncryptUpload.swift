import Foundation

/// Encrypt a plaintext thumbnail blob and upload it to the server.
///
/// Encryption follows the same pattern as `NativeBackupEngine`:
///   1. Load master key from Secure Enclave-backed keychain
///   2. Derive the per-file AES-256-GCM key via `MasterKeyHandle.deriveFileKey`
///   3. Encrypt with `FileKeyHandle.encryptChunk`
///   4. Serialize as `nonce(12) || ciphertext` (wire format matching web client)
///
/// Credentials (baseURL + sessionToken) come from `ThumbnailServiceModule.credentials()`,
/// which is set by the JS layer via `setApiCredentials`.
public enum ThumbnailEncryptUpload {

    /// Encrypt plaintext thumbnail data using the per-file key derived from master key.
    /// Returns the wire-format bytes: `nonce(12) || ciphertext`.
    public static func encryptThumbnail(fileId: String, plaintext: Data) async throws -> Data {
        let masterKey = try BeebeebCryptoBridge.requireMasterKey()
        let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
        let enc = try fileKey.encryptChunk(plaintext: plaintext)

        // Wire format: nonce(12) || ciphertext — matches the web client and NativeBackupEngine
        var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
        wire.append(enc.nonce)
        wire.append(enc.ciphertext)
        return wire
    }

    /// PUT the encrypted thumbnail to `/api/v1/files/:id/thumbnail`.
    public static func put(fileId: String, ciphertext: Data) async throws {
        guard let creds = ThumbnailServiceModule.credentials() else {
            throw NSError(
                domain: "BeebeebThumbnailGen", code: 401,
                userInfo: [NSLocalizedDescriptionKey: "no API credentials — call setApiCredentials first"]
            )
        }
        let (baseURL, token) = creds

        let thumbnailURL = baseURL.appendingPathComponent("api/v1/files/\(fileId)/thumbnail")
        var req = URLRequest(url: thumbnailURL)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = ciphertext
        req.timeoutInterval = 30

        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw NSError(domain: NSURLErrorDomain, code: NSURLErrorBadServerResponse)
        }
        if http.statusCode == 429 {
            throw NSError(
                domain: "BeebeebThumbnailGen", code: 429,
                userInfo: [NSLocalizedDescriptionKey: "rate limited"]
            )
        }
        if http.statusCode == 413 {
            throw NSError(
                domain: "BeebeebThumbnailGen", code: 413,
                userInfo: [NSLocalizedDescriptionKey: "too large"]
            )
        }
        if http.statusCode >= 500 {
            throw NSError(
                domain: "BeebeebThumbnailGen", code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "server hiccup"]
            )
        }
        if http.statusCode >= 400 {
            throw NSError(
                domain: "BeebeebThumbnailGen", code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "client error"]
            )
        }
    }
}
