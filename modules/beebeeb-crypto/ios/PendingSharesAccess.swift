import Foundation

/// Bridge between the iOS Share Extension's App Group dropbox and the
/// React Native side. The extension drops `<id>.json` (manifest) plus a
/// `<id>.<ext>` payload into `group.io.beebeeb.shared/IncomingShares/`.
/// The main app reads them here and ships URIs to JS for upload.
enum PendingSharesAccess {

    private static let appGroup = "group.io.beebeeb.shared"
    private static let incomingDir = "IncomingShares"
    /// The main-app sandbox sub-directory we copy consumed shares into so
    /// JavaScript can `fetch(file://...)` them through expo-file-system.
    private static let stagingDir = "PendingShareUploads"

    enum AccessError: LocalizedError {
        case appGroupUnavailable
        case manifestMissing(String)
        case payloadMissing(String)

        var errorDescription: String? {
            switch self {
            case .appGroupUnavailable:
                return "App Group container is not available — check entitlements."
            case .manifestMissing(let id):
                return "Pending share \(id) has no manifest."
            case .payloadMissing(let id):
                return "Pending share \(id) has no payload file."
            }
        }
    }

    private struct Manifest: Codable {
        let id: String
        let filename: String
        let relativePath: String
        let mimeType: String?
        let sizeBytes: Int64
        let timestamp: TimeInterval
        let kind: String
    }

    // MARK: - Public API

    static func list() throws -> [[String: Any]] {
        let dir = try requireSharedDir()
        let entries = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return entries
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> [String: Any]? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                guard let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return nil }
                return manifestToDict(manifest)
            }
            .sorted { (lhs, rhs) -> Bool in
                let l = (lhs["timestamp"] as? Double) ?? 0
                let r = (rhs["timestamp"] as? Double) ?? 0
                return l < r
            }
    }

    /// Copy the share's payload into the main-app sandbox, delete the App
    /// Group copy + manifest, and return everything the JS layer needs to
    /// upload it.
    static func consume(id: String) throws -> [String: Any] {
        let dir = try requireSharedDir()
        let manifestURL = dir.appendingPathComponent("\(id).json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            throw AccessError.manifestMissing(id)
        }
        let data = try Data(contentsOf: manifestURL)
        let manifest = try JSONDecoder().decode(Manifest.self, from: data)

        let payloadURL = dir.appendingPathComponent(manifest.relativePath)
        guard FileManager.default.fileExists(atPath: payloadURL.path) else {
            // Manifest is orphaned — drop it so we don't keep tripping over it.
            try? FileManager.default.removeItem(at: manifestURL)
            throw AccessError.payloadMissing(id)
        }

        let staging = try ensureStagingDir()
        let dest = staging.appendingPathComponent(manifest.relativePath)
        if FileManager.default.fileExists(atPath: dest.path) {
            try? FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.copyItem(at: payloadURL, to: dest)

        // Tear down the App Group copy now that the main app owns the file.
        try? FileManager.default.removeItem(at: payloadURL)
        try? FileManager.default.removeItem(at: manifestURL)

        var dict = manifestToDict(manifest)
        dict["uri"] = "file://" + dest.path
        return dict
    }

    static func clearAll() throws -> Int {
        let dir = try requireSharedDir()
        let entries = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        var removed = 0
        for url in entries {
            do {
                try FileManager.default.removeItem(at: url)
                removed += 1
            } catch {
                // Best-effort: skip files we can't remove.
            }
        }
        return removed
    }

    // MARK: - Helpers

    private static func requireSharedDir() throws -> URL {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ) else {
            throw AccessError.appGroupUnavailable
        }
        let dir = container.appendingPathComponent(incomingDir, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func ensureStagingDir() throws -> URL {
        let docs = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dir = docs.appendingPathComponent(stagingDir, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func manifestToDict(_ m: Manifest) -> [String: Any] {
        var dict: [String: Any] = [
            "id": m.id,
            "filename": m.filename,
            "sizeBytes": m.sizeBytes,
            "timestamp": m.timestamp,
            "kind": m.kind,
        ]
        if let mime = m.mimeType { dict["mimeType"] = mime }
        return dict
    }
}
