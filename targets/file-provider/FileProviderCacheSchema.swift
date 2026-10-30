import Foundation

// SF-0002 M2a run 3 — the File Provider cache's convention columns.
//
// The cache has TWO schema owners (the extension's CacheManager and the app's
// BeebeebCryptoModule). Both run this same idempotent migration: each of the
// three columns is added only when `pragma table_info(file_cache)` does not
// already list it. `PRAGMA user_version` is the purge epoch and must never be
// written here.
//
// The name convention RESETS whenever `name_encrypted` changes (a new ciphertext
// has not been authenticated yet). The content convention is keyed by
// `objectVersionId`, so a move/rename keeps it and a new version drops it.
//
// Dependency-free so the Swift harness compiles it with swiftc only.

enum FileProviderCacheSchema {
    /// The three columns, in the order the migration adds them.
    static let addedColumns: [(name: String, declaration: String)] = [
        ("name_convention", "TEXT"),
        ("content_convention", "TEXT"),
        ("content_version_id", "TEXT"),
    ]

    /// ALTER statements for the columns `existing` lacks, in table order.
    static func addColumnStatements(existing: Set<String>) -> [String] {
        addedColumns
            .filter { !existing.contains($0.name) }
            .map { "ALTER TABLE file_cache ADD COLUMN \($0.name) \($0.declaration)" }
    }

    /// The convention to store after an upsert. An unchanged ciphertext keeps
    /// (or refreshes) it; a changed ciphertext starts from the batch result
    /// only, never inheriting the previous ciphertext's convention.
    static func nameConvention(
        previous: String?,
        previousNameEncrypted: String?,
        newNameEncrypted: String,
        batch: String?
    ) -> String? {
        if previousNameEncrypted == newNameEncrypted {
            return batch ?? previous
        }
        return batch
    }

    /// The content convention for the incoming object version. A different
    /// version has not been classified yet, so only `incoming` can answer.
    static func contentConvention(
        previousVersionId: String?,
        previous: String?,
        incomingVersionId: String,
        incoming: String?
    ) -> String? {
        if previousVersionId == incomingVersionId {
            return incoming ?? previous
        }
        return incoming
    }
}
