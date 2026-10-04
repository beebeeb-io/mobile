import Foundation

enum NativePreviewWorkingStorage {
  private static let lock = NSLock()
  private static var preparedCacheDirectories = Set<String>()

  static func prepare(cacheDirectory: URL) throws {
    let directory = cacheDirectory.standardizedFileURL
    let key = directory.path

    lock.lock()
    if preparedCacheDirectories.contains(key) {
      lock.unlock()
      return
    }
    preparedCacheDirectories.insert(key)
    lock.unlock()

    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else {
      return
    }
    for name in names where shouldRemove(name: name, in: directory) {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
  }

#if DEBUG
  static func resetPreparedDirectoriesForTests() {
    lock.lock()
    preparedCacheDirectories.removeAll()
    lock.unlock()
  }
#endif

  private static func shouldRemove(name: String, in directory: URL) -> Bool {
    let url = directory.appendingPathComponent(name)
    let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
    if isDirectory {
      return isNativeStreamDirectory(name)
    }
    return isNativePipelineTempFile(name)
  }

  private static func isNativePipelineTempFile(_ name: String) -> Bool {
    guard name.hasPrefix("."), name.hasSuffix(".tmp") else { return false }
    let trimmed = String(name.dropLast(4))
    guard let separator = trimmed.lastIndex(of: ".") else { return false }
    let prefix = trimmed[..<separator]
    let uuid = trimmed[trimmed.index(after: separator)...]
    guard prefix.count > 1 else { return false }
    return UUID(uuidString: String(uuid)) != nil
  }

  private static func isNativeStreamDirectory(_ name: String) -> Bool {
    let prefix = ".beebeeb-stream-"
    guard name.hasPrefix(prefix), name.count > prefix.count + 37 else { return false }
    let uuidStart = name.index(name.endIndex, offsetBy: -36)
    let separator = name.index(before: uuidStart)
    guard name[separator] == "-" else { return false }
    return UUID(uuidString: String(name[uuidStart...])) != nil
  }
}
