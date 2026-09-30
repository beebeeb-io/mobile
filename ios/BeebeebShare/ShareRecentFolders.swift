import Foundation

/// Task 1671 round 2 — the Share Extension's "RECENT" folder list, as pure,
/// Foundation-only logic (no UIKit, no `MasterKeyHandle`) so it is unit-tested
/// by a standalone `swiftc` compile (`scripts/swift-tests/share-recent-folders-test.swift`).
///
/// PRIVACY RULE (lead ruling, 2026-09-30): the recents store persists folder
/// IDS ONLY — never a name. Folder names are end-to-end encrypted; the moment
/// `FolderFetcher` started returning real decrypted names, persisting them in
/// App Group `UserDefaults` (`beebeeb_share_recent_folders`) would have put
/// plaintext folder names into iCloud backups (that key is not registered in
/// `PlaintextStorageProtection`) and left them behind after sign-out / account
/// switch. So:
///   - `encode` writes `[{"id": ...}]` and nothing else — the type it encodes
///     has no name field, so a name cannot be written by construction.
///   - `load` reads with the same id-only type; a legacy `{id, name}` payload
///     (builds <= 230 wrote `name`, including stale "Folder N" fallbacks) decodes
///     with the name ignored, and `load` reports a `scrubbedPayload` so the
///     caller rewrites the store id-only immediately rather than waiting for
///     the next successful share.
///   - `resolve` turns ids into display rows by looking each id up in the
///     freshly fetched + decrypted folder list, and DROPS ids not in that list
///     (deleted folders, or ids stored under a different signed-in account).
enum ShareRecentFolders {

    /// Most recents kept.
    static let maxCount = 3

    /// The on-disk element. Deliberately has ONLY `id`: Codable ignores unknown
    /// keys when decoding, which is what makes legacy `name` values unreadable.
    private struct StoredEntry: Codable {
        let id: String
    }

    /// A recent resolved against the current folder list, for display only.
    /// Never persisted.
    struct Resolved: Equatable {
        let id: String
        let name: String
    }

    // MARK: - Persistence format

    /// The store payload for `ids` (de-duplicated, capped). Ids only.
    static func encode(_ ids: [String]) -> Data? {
        let entries = normalized(ids).map { StoredEntry(id: $0) }
        return try? JSONEncoder().encode(entries)
    }

    /// Decode a stored payload to ids, ignoring any `name` it carries.
    /// `scrubbedPayload` is non-nil when the stored bytes are not the canonical
    /// id-only encoding of those ids (legacy names present, duplicates, over
    /// the cap) and must be rewritten. An undecodable payload is scrubbed to
    /// empty (rewritten as `[]`) rather than left in place.
    static func load(from data: Data?) -> (ids: [String], scrubbedPayload: Data?) {
        guard let data = data else { return ([], nil) }
        guard let entries = try? JSONDecoder().decode([StoredEntry].self, from: data) else {
            return ([], encode([]))
        }
        let ids = normalized(entries.map { $0.id })
        let canonical = encode(ids)
        return (ids, canonical == data ? nil : canonical)
    }

    // MARK: - Recording

    /// `stored` with `id` moved to the front, capped at `maxCount`. When
    /// `knownFolderIds` is non-nil (the folder fetch succeeded) ids not in it
    /// are pruned, so ids from a deleted folder or another account do not
    /// linger; when nil (fetch failed) the stored ids are kept untouched.
    static func recording(_ id: String, in stored: [String], knownFolderIds: Set<String>?) -> [String] {
        var kept = stored.filter { $0 != id }
        if let known = knownFolderIds {
            kept = kept.filter { known.contains($0) }
        }
        return normalized([id] + kept)
    }

    // MARK: - Display

    /// Display rows for `ids`: each id is looked up in `folders` (the freshly
    /// fetched, decrypted top-level folders) for its CURRENT name; ids absent
    /// from `folders` are dropped. Order follows `ids`.
    static func resolve(_ ids: [String], against folders: [(id: String, name: String)]) -> [Resolved] {
        var names: [String: String] = [:]
        for f in folders where names[f.id] == nil { names[f.id] = f.name }
        return normalized(ids).compactMap { id in
            names[id].map { Resolved(id: id, name: $0) }
        }
    }

    /// The folder to preselect: the most recent one, else `nil` — the "My files"
    /// root row (row 0 of the FOLDERS section). Never `folders.first`.
    static func defaultSelection(recents: [Resolved]) -> String? {
        recents.first?.id
    }

    // MARK: - Helpers

    private static func normalized(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for id in ids where !id.isEmpty && seen.insert(id).inserted {
            out.append(id)
            if out.count == maxCount { break }
        }
        return out
    }
}
