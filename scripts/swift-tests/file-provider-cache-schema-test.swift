import Foundation

// SF-0002 M2a run 3: the File Provider cache schema migration + convention
// columns. Compiles with targets/file-provider/FileProviderCacheSchema.swift.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else {
        print("FAIL: \(name)")
        exit(1)
    }
    assertions += 1
    print("PASS: \(name)")
}

/// ── theMigrationLeavesUserVersionUnchanged ────────────────────────────────
let fresh = FileProviderCacheSchema.addColumnStatements(existing: [])
check(fresh.count == 3, "theMigrationLeavesUserVersionUnchanged: three new columns on an old database")
check(fresh.contains { $0.contains("name_convention") },
      "theMigrationLeavesUserVersionUnchanged: name_convention")
check(fresh.contains { $0.contains("content_convention") },
      "theMigrationLeavesUserVersionUnchanged: content_convention")
check(fresh.contains { $0.contains("content_version_id") },
      "theMigrationLeavesUserVersionUnchanged: content_version_id")
check(!fresh.contains { $0.lowercased().contains("user_version") },
      "theMigrationLeavesUserVersionUnchanged: never writes PRAGMA user_version")

let existing: Set<String> = ["id", "parent_id", "name_convention", "content_convention", "content_version_id"]
check(FileProviderCacheSchema.addColumnStatements(existing: existing).isEmpty,
      "theMigrationLeavesUserVersionUnchanged: idempotent when the columns already exist")

let partial: Set<String> = ["id", "name_convention"]
let remaining = FileProviderCacheSchema.addColumnStatements(existing: partial)
check(remaining.count == 2 && !remaining.contains { $0.contains("name_convention") },
      "theMigrationLeavesUserVersionUnchanged: adds only the missing columns")

/// ── theAppSideCacheUpsertWritesTheNameConvention ──────────────────────────
check(FileProviderCacheSchema.nameConvention(
    previous: "string", previousNameEncrypted: "enc-a",
    newNameEncrypted: "enc-a", batch: "upper_repair") == "upper_repair",
    "theAppSideCacheUpsertWritesTheNameConvention: the batch result wins")
check(FileProviderCacheSchema.nameConvention(
    previous: "string", previousNameEncrypted: "enc-a",
    newNameEncrypted: "enc-b", batch: nil) == nil,
    "theAppSideCacheUpsertWritesTheNameConvention: a new name_encrypted RESETS the column")
check(FileProviderCacheSchema.nameConvention(
    previous: "upper_repair", previousNameEncrypted: "enc-a",
    newNameEncrypted: "enc-a", batch: nil) == "upper_repair",
    "theAppSideCacheUpsertWritesTheNameConvention: an unchanged name keeps its convention")

check(FileProviderCacheSchema.contentConvention(
    previousVersionId: "v1", previous: "string",
    incomingVersionId: "v1", incoming: nil) == "string",
    "theAppSideCacheUpsertWritesTheNameConvention: content survives the same objectVersionId")
check(FileProviderCacheSchema.contentConvention(
    previousVersionId: "v1", previous: "string",
    incomingVersionId: "v2", incoming: nil) == nil,
    "theAppSideCacheUpsertWritesTheNameConvention: a new objectVersionId resets the content half")
check(FileProviderCacheSchema.contentConvention(
    previousVersionId: "v1", previous: "string",
    incomingVersionId: "v2", incoming: "upper_repair") == "upper_repair",
    "theAppSideCacheUpsertWritesTheNameConvention: the classified version is written")

print("file-provider-cache-schema-test: \(assertions) assertions, 0 failed")
