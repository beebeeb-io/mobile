import Foundation

/// Fetches top-level folders from the Beebeeb API for the folder picker.
///
/// Since BeebeebCryptoShim is not yet linked, folder names cannot be decrypted.
/// The UI shows fallback display names ("Folder 1", "Folder 2", ...) with the
/// encrypted blob as subtitle context.
final class FolderFetcher {

    struct Folder {
        let id: String
        let nameEncrypted: String
        /// Human-readable fallback — "Folder 1", "Folder 2", etc.
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

    init(sessionToken: String, apiUrl: String) {
        self.sessionToken = sessionToken
        self.apiUrl = apiUrl
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

            folders.append(Folder(
                id: id,
                nameEncrypted: nameEncrypted,
                displayName: "Folder \(index)"
            ))
            index += 1
        }

        return folders
    }
}
