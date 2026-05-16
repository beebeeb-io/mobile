import Foundation

// File-scope reference to the UniFFI free function to avoid name collisions.
fileprivate let _decryptName: (Data, String, String) throws -> String = decryptName(masterKey:fileId:nameEncrypted:)

/// Fetches top-level folders from the Beebeeb API for the folder picker.
///
/// With BeebeebCore.xcframework linked, folder names are decrypted using the
/// master key from the shared keychain. Falls back to "Folder 1", "Folder 2"
/// if the key is unavailable or decryption fails.
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
    private let masterKey: Data?

    init(sessionToken: String, apiUrl: String, masterKey: Data? = nil) {
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
                    displayName = try _decryptName(mk, id, nameEncrypted)
                } catch {
                    // Decryption failed — use fallback name
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
