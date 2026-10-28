import Foundation

/// Process-memory handles only. Clearing advances a generation so work begun
/// before a lock cannot repopulate the table after it finishes decrypting.
final class SharedKeyRegistry<Handle: AnyObject> {
    static var maxFiles: Int { 100_000 }
    private let lock = NSLock()
    private var folders: [Int: (handle: Handle, folderId: String)] = [:]
    private var files: [String: Handle] = [:]
    private var nextId = 1
    private var epoch: UInt64 = 0

    var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return epoch }
    func storeFolder(_ handle: Handle, folderId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return insertFolder(handle, folderId: folderId)
    }
    func storeFolderIfCurrent(_ handle: Handle, folderId: String, generation: UInt64) -> Int? {
        lock.lock(); defer { lock.unlock() }
        guard epoch == generation else { return nil }
        return insertFolder(handle, folderId: folderId)
    }
    private func insertFolder(_ handle: Handle, folderId: String) -> Int {
        let id = nextId; nextId += 1
        folders[id] = (handle, folderId)
        return id
    }
    func folder(_ id: Int) -> (handle: Handle, folderId: String)? {
        lock.lock(); defer { lock.unlock() }; return folders[id]
    }
    func releaseFolder(_ id: Int) { lock.lock(); defer { lock.unlock() }; folders.removeValue(forKey: id) }
    @discardableResult func storeFile(_ fileId: String, _ handle: Handle, generation: UInt64? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let generation, generation != epoch { return false }
        guard files[fileId] != nil || files.count < Self.maxFiles else { return false }
        files[fileId] = handle; return true
    }
    func file(_ fileId: String) -> Handle? { lock.lock(); defer { lock.unlock() }; return files[fileId] }
    func clear() {
        lock.lock(); defer { lock.unlock() }
        epoch += 1
        folders.removeAll(); files.removeAll()
    }
}

func pickKey<H>(table: H?, derive: () throws -> H) rethrows -> H {
    if let table { return table }
    return try derive()
}

/// Each input index occurs exactly once; preserve per-item values, including errors.
func mergeNameResults<T>(count: Int, fromTable: [(index: Int, value: T)], fromMaster: [(index: Int, value: T)]) -> [T] {
    let ordered = (fromTable + fromMaster).sorted { $0.index < $1.index }
    precondition(ordered.map { $0.index } == Array(0..<count))
    return ordered.map { $0.value }
}
