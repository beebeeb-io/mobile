import Foundation

// Task 1671 round 2 — standalone swiftc unit test for
// `targets/share-extension/ShareRecentFolders.swift`, the pure recents logic of
// the Share Extension. Same pattern as share-upload-request-policy-test.swift:
// the REAL shipped source file is compiled with this driver
// (scripts/swift-ci/run-swift-tests.sh, macOS job "Swift compile gate").
//
// The privacy rule under test: the recents store persists folder IDS ONLY. A
// decrypted folder name in App Group UserDefaults would land in iCloud backups
// and outlive sign-out (adversarial review of round 1, BLOCKING).

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

func jsonString(_ data: Data?) -> String {
  guard let data = data else { return "<nil>" }
  return String(data: data, encoding: .utf8) ?? "<non-utf8>"
}

/// Every key of every object in a JSON array payload.
func keys(of data: Data?) -> Set<String> {
  guard let data = data,
        let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return ["<undecodable>"] }
  return Set(arr.flatMap { $0.keys })
}

let legacy = """
[{"id":"f-1","name":"Folder 1"},{"id":"f-2","name":"Tax returns 2025"}]
""".data(using: .utf8)!

// MARK: - encode: ids only, never a name key

let encoded = ShareRecentFolders.encode(["f-1", "f-2"])
expect(encoded != nil, "encode produces a payload")
expect(keys(of: encoded) == ["id"], "encoded payload has exactly one key, \"id\" (got \(keys(of: encoded)))")
expect(!jsonString(encoded).contains("\"name\""), "encoded payload contains no \"name\" key: \(jsonString(encoded))")
expect(jsonString(encoded) == "[{\"id\":\"f-1\"},{\"id\":\"f-2\"}]", "encoded payload is the canonical id-only array")
expect(keys(of: ShareRecentFolders.encode([])) == [], "an empty list encodes to an empty array")

// Whatever is recorded, whatever the folder is called, the payload stays id-only
// (the recording API has no way to receive a name, but prove the bytes).
let recorded = ShareRecentFolders.recording("f-9", in: ["f-1", "f-2"], knownFolderIds: nil)
expect(!jsonString(ShareRecentFolders.encode(recorded)).contains("name"), "a recorded-then-encoded payload has no name key")

// MARK: - load: legacy {id,name} payloads: names are IGNORED and the store is scrubbed

let loadedLegacy = ShareRecentFolders.load(from: legacy)
expect(loadedLegacy.ids == ["f-1", "f-2"], "legacy payload: ids are read (got \(loadedLegacy.ids))")
expect(loadedLegacy.scrubbedPayload != nil, "legacy payload with names is flagged for an id-only rewrite")
expect(!jsonString(loadedLegacy.scrubbedPayload).contains("name"), "the scrubbed rewrite carries no name: \(jsonString(loadedLegacy.scrubbedPayload))")
expect(!jsonString(loadedLegacy.scrubbedPayload).contains("Tax returns"), "the scrubbed rewrite carries no legacy plaintext name")
expect(!jsonString(loadedLegacy.scrubbedPayload).contains("Folder 1"), "the scrubbed rewrite carries no stale \"Folder N\" name")
// The scrubbed payload is itself stable: loading it again needs no rewrite.
let reloaded = ShareRecentFolders.load(from: loadedLegacy.scrubbedPayload)
expect(reloaded.ids == ["f-1", "f-2"] && reloaded.scrubbedPayload == nil, "a scrubbed payload reloads unchanged with nothing more to rewrite")

// No name can be read from storage: resolving legacy-stored ids uses the FETCHED name.
let fetchedNames: [(id: String, name: String)] = [(id: "f-1", name: "Photos"), (id: "f-2", name: "Taxes")]
let fromLegacy = ShareRecentFolders.resolve(loadedLegacy.ids, against: fetchedNames)
expect(fromLegacy.map { $0.name } == ["Photos", "Taxes"], "resolved names come from the fetched list, not the legacy stored names (got \(fromLegacy.map { $0.name }))")
expect(!fromLegacy.contains { $0.name == "Folder 1" || $0.name == "Tax returns 2025" }, "a stale stored name never reaches the display rows")

// Hostile payload: extra fields of any kind are ignored, not carried.
let hostile = "[{\"id\":\"f-1\",\"name\":\"secret\",\"nameEncrypted\":\"zzz\",\"path\":\"/a/b\"}]".data(using: .utf8)!
let loadedHostile = ShareRecentFolders.load(from: hostile)
expect(loadedHostile.ids == ["f-1"], "extra fields are ignored on load")
expect(keys(of: loadedHostile.scrubbedPayload) == ["id"], "the rewrite of a payload with extra fields is id-only")

// Already id-only, absent, and unreadable payloads.
let idOnly = ShareRecentFolders.load(from: encoded)
expect(idOnly.ids == ["f-1", "f-2"] && idOnly.scrubbedPayload == nil, "an id-only payload loads with no rewrite needed")
let absent = ShareRecentFolders.load(from: nil)
expect(absent.ids.isEmpty && absent.scrubbedPayload == nil, "no stored payload -> no ids, nothing to write")
let garbage = ShareRecentFolders.load(from: "not json".data(using: .utf8)!)
expect(garbage.ids.isEmpty, "an undecodable payload yields no ids")
expect(garbage.scrubbedPayload != nil && keys(of: garbage.scrubbedPayload) == [], "an undecodable payload is rewritten to an empty array, not left in place")

// MARK: - resolve: drop unknown ids (deleted folder / different account)

let fetched: [(id: String, name: String)] = [(id: "a", name: "Alpha"), (id: "b", name: "Beta"), (id: "c", name: "Gamma")]
let resolved = ShareRecentFolders.resolve(["b", "gone", "a"], against: fetched)
expect(resolved == [ShareRecentFolders.Resolved(id: "b", name: "Beta"), ShareRecentFolders.Resolved(id: "a", name: "Alpha")],
       "resolve keeps stored order and drops ids not in the fetched list (got \(resolved))")
expect(!resolved.contains { $0.id == "gone" }, "an unknown id (deleted folder) is dropped")
expect(ShareRecentFolders.resolve(["x", "y"], against: fetched).isEmpty, "recents from a different account resolve to nothing")
expect(ShareRecentFolders.resolve(["a", "b"], against: []).isEmpty, "with no fetched folders (fetch failed) nothing resolves, so no stale rows are shown")
expect(ShareRecentFolders.resolve(["a", "a", "b"], against: fetched).map { $0.id } == ["a", "b"], "duplicate ids resolve once")
let renamed: [(id: String, name: String)] = [(id: "a", name: "Alpha (renamed)")]
expect(ShareRecentFolders.resolve(["a"], against: renamed).first?.name == "Alpha (renamed)", "a renamed folder shows its CURRENT name")

// MARK: - recording: MRU, cap, pruning

expect(ShareRecentFolders.recording("c", in: ["a", "b"], knownFolderIds: nil) == ["c", "a", "b"], "a new id goes to the front")
expect(ShareRecentFolders.recording("b", in: ["a", "b", "c"], knownFolderIds: nil) == ["b", "a", "c"], "an existing id moves to the front without duplicating")
expect(ShareRecentFolders.recording("d", in: ["a", "b", "c"], knownFolderIds: nil) == ["d", "a", "b"], "the list is capped at \(ShareRecentFolders.maxCount), oldest dropped")
expect(ShareRecentFolders.maxCount == 3, "the cap is 3")
expect(ShareRecentFolders.recording("a", in: ["gone", "b"], knownFolderIds: ["a", "b"]) == ["a", "b"],
       "with a known folder list, stored ids not in it are pruned on save")
expect(ShareRecentFolders.recording("a", in: ["gone", "b"], knownFolderIds: nil) == ["a", "gone", "b"],
       "with no known folder list (fetch failed) stored ids are kept, not wiped")
expect(ShareRecentFolders.recording("a", in: [], knownFolderIds: nil) == ["a"], "recording into an empty store works")

// MARK: - default selection: the "My files" root, never the first folder

expect(ShareRecentFolders.defaultSelection(recents: []) == nil, "no recents -> nil = the \"My files\" root row, not folders.first")
expect(ShareRecentFolders.defaultSelection(recents: resolved) == "b", "with recents the most recent one is preselected")

// MARK: - Report

if failures.isEmpty {
  print("ShareRecentFoldersTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ShareRecentFoldersTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
