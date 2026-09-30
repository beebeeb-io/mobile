import Foundation

/// Fetches top-level folders from the Beebeeb API for the folder picker.
///
/// Folder names are decrypted via the SAME core path the main app
/// (`src/lib/api.ts` + its crypto layer) and the File Provider extension
/// (`targets/file-provider/CryptoBridge.swift`'s `decryptNameWithMime`) use:
/// `MasterKeyHandle.decryptNameWithMime(fileId:nameEncrypted:)` — the
/// per-handle UniFFI method, not the raw-`Data` free function. Task 1671
/// (Issue 2a): `ShareViewController` used to construct this fetcher WITHOUT
/// ever passing its loaded key, so `masterKey` was always `nil` and every
/// folder fell back to "Folder N" — a hard project rule violation ("all
/// crypto in core Rust, never per-client") was never actually at risk here;
/// the bug was simpler and dumber: the key just never made it into this
/// class. Falls back to "Folder N" only when decryption genuinely fails for
/// that one row (never as the default state).
final class FolderFetcher {

    struct Folder {
        let id: String
        let nameEncrypted: String
        /// Decrypted folder name, or fallback "Folder N" if decryption fails.
        let displayName: String
    }

    enum FetchError: LocalizedError {
        case noToken
        case networkError(Error)
        case httpError(Int)
        case decodingError

        var errorDescription: String? {
            switch self {
            case .noToken: return "No session token"
            case .networkError(let e): return "Network error: \(e.localizedDescription)"
            case .httpError(let code): return "HTTP \(code)"
            case .decodingError: return "Failed to decode folder list"
            }
        }
    }

    private let apiUrl: String
    private let sessionToken: String
    /// Key-hygiene (matches `ShareUploader`'s own doc comment): the opaque
    /// handle, never raw key bytes. `nil` only when the caller genuinely has
    /// no key yet — `ShareViewController.performSetup()` already refuses the
    /// whole share before reaching the folder fetch in that case, so in
    /// practice this is always set.
    private let masterKey: MasterKeyHandle?

    init(sessionToken: String, apiUrl: String, masterKey: MasterKeyHandle? = nil) {
        self.sessionToken = sessionToken
        self.apiUrl = apiUrl
        self.masterKey = masterKey
    }

    /// Fetch all top-level folders (parent_id == null, is_folder == true).
    func fetchTopLevelFolders() async throws -> [Folder] {
        guard let url = URL(string: "\(apiUrl)/api/v1/files") else {
            throw FetchError.networkError(URLError(.badURL))
        }

        var request = URLRequest(url: url)
        ProvenanceHeaders.apply(to: &request)
        request.httpMethod = "GET"
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw FetchError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw FetchError.networkError(URLError(.badServerResponse))
        }

        guard httpResponse.statusCode == 200 else {
            throw FetchError.httpError(httpResponse.statusCode)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let files = json["files"] as? [[String: Any]] else {
            throw FetchError.decodingError
        }

        // Filter: is_folder == true AND parent_id == null (top-level)
        var folders: [Folder] = []
        var index = 1

        for file in files {
            guard let isFolder = file["is_folder"] as? Bool, isFolder else { continue }

            // parent_id should be null for top-level — the API returns root items
            // when no parent_id query param is provided
            let id = file["id"] as? String ?? ""
            let nameEncrypted = file["name_encrypted"] as? String ?? ""

            guard !id.isEmpty else { continue }

            // Attempt to decrypt the folder name if master key is available
            var displayName = "Folder \(index)"
            if let mk = masterKey, !nameEncrypted.isEmpty {
                do {
                    displayName = try mk.decryptNameWithMime(fileId: id, nameEncrypted: nameEncrypted).name
                } catch {
                    // Decryption failed — use fallback name. Not expected in
                    // practice (see the class doc comment): this now only
                    // fires for a genuinely malformed/foreign-key row, not as
                    // the default state for every folder.
                    NSLog("[Beebeeb] FolderFetcher: decrypt name failed for folder \(id): \(error)")
                }
            }

            folders.append(Folder(
                id: id,
                nameEncrypted: nameEncrypted,
                displayName: displayName
            ))
            index += 1
        }

        return folders
    }
}
