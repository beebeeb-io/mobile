import Foundation

final class FakeKey { let id: Int; init(_ id: Int) { self.id = id } }
var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}
let registry = SharedKeyRegistry<FakeKey>()
let key = FakeKey(1)
check(registry.storeFile("a", key) && registry.file("a") === key, "registry_returns_a_stored_file_handle")
for i in 1..<SharedKeyRegistry<FakeKey>.maxFiles { _ = registry.storeFile("\(i)", key) }
check(!registry.storeFile("overflow", key), "registry_refuses_the_100001st_file")
check(registry.storeFile("a", key), "replacement_at_cap_is_allowed")
let folder = registry.storeFolder(key, folderId: "root")
registry.clear()
check(registry.folder(folder) == nil && registry.file("a") == nil, "clear_drops_folders_and_files")
let next = registry.storeFolder(key, folderId: "next")
check(next > folder, "ids_are_never_reused_after_clear")
registry.releaseFolder(next)
check(registry.folder(next) == nil, "a_released_folder_id_is_invalid")
var derived = 0
let picked = pickKey(table: key) { derived += 1; return FakeKey(2) }
check(picked === key && derived == 0, "table_entry_wins_over_derivation")
DispatchQueue.concurrentPerform(iterations: 8) { worker in
    for i in 0..<1000 {
        _ = registry.storeFile("\(worker)-\(i)", key)
        _ = registry.file("\(worker)-\(i)")
        if i % 4 == 0 { registry.clear() }
    }
}
registry.clear()
check(registry.file("0-0") == nil, "concurrent_store_and_clear_never_crash")
let names = mergeNameResults(count: 4, fromTable: [(index: 1, value: "guest")],
    fromMaster: [(index: 0, value: "owner"), (index: 2, value: "error:bad"), (index: 3, value: "last")])
check(names == ["owner", "guest", "error:bad", "last"], "decrypt_names_merges_table_and_master_results_in_order")
print("shared-key-registry: \(assertions) assertions, 0 failed")
