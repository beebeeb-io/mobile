import Foundation

private var assertionCount = 0

private func fail(_ message: String) -> Never {
  fputs("native-preview-working-storage-test: FAIL: \(message)\n", stderr)
  exit(1)
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertionCount += 1
  if !condition() {
    fail(message)
  }
}

private func touchFile(_ url: URL) {
  FileManager.default.createFile(atPath: url.path, contents: Data("x".utf8))
}

private func exists(_ url: URL) -> Bool {
  FileManager.default.fileExists(atPath: url.path)
}

private let cache = FileManager.default.temporaryDirectory
  .appendingPathComponent("native-preview-working-storage-test-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: cache) }

let oldPreviewTemp = cache.appendingPathComponent(".photo.jpg.550E8400-E29B-41D4-A716-446655440000.tmp")
let oldStreamDir = cache.appendingPathComponent(".beebeeb-stream-file-id-550E8400-E29B-41D4-A716-446655440001", isDirectory: true)
let publicFinal = cache.appendingPathComponent("photo.jpg")
let unknownDotFile = cache.appendingPathComponent(".photo.jpg.not-a-uuid.tmp")
let unknownStreamDir = cache.appendingPathComponent(".beebeeb-stream-file-id-not-a-uuid", isDirectory: true)
let plainHiddenFile = cache.appendingPathComponent(".keepme")

try FileManager.default.createDirectory(at: oldStreamDir, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: unknownStreamDir, withIntermediateDirectories: true)
touchFile(oldPreviewTemp)
touchFile(publicFinal)
touchFile(unknownDotFile)
touchFile(plainHiddenFile)

try NativePreviewWorkingStorage.prepare(cacheDirectory: cache)
expect(!exists(oldPreviewTemp), "old native preview temp was not removed")
expect(!exists(oldStreamDir), "old native stream directory was not removed")
expect(exists(publicFinal), "public preview cache entry was removed")
expect(exists(unknownDotFile), "unrecognized dot temp was removed")
expect(exists(unknownStreamDir), "unrecognized stream directory was removed")
expect(exists(plainHiddenFile), "plain hidden file was removed")

let livePreviewTemp = cache.appendingPathComponent(".video.mov.550E8400-E29B-41D4-A716-446655440002.tmp")
let liveStreamDir = cache.appendingPathComponent(".beebeeb-stream-file-id-550E8400-E29B-41D4-A716-446655440003", isDirectory: true)
touchFile(livePreviewTemp)
try FileManager.default.createDirectory(at: liveStreamDir, withIntermediateDirectories: true)
try NativePreviewWorkingStorage.prepare(cacheDirectory: cache)
expect(exists(livePreviewTemp), "same-process prepare removed live preview temp")
expect(exists(liveStreamDir), "same-process prepare removed live stream directory")

NativePreviewWorkingStorage.resetPreparedDirectoriesForTests()
try NativePreviewWorkingStorage.prepare(cacheDirectory: cache)
expect(!exists(livePreviewTemp), "fresh-process prepare did not remove previous preview temp")
expect(!exists(liveStreamDir), "fresh-process prepare did not remove previous stream directory")
expect(exists(publicFinal), "fresh-process prepare removed public cache entry")
expect(exists(unknownDotFile), "fresh-process prepare removed unrecognized dot temp")
expect(exists(unknownStreamDir), "fresh-process prepare removed unrecognized stream directory")
expect(exists(plainHiddenFile), "fresh-process prepare removed plain hidden file")

print("native-preview-working-storage-test: \(assertionCount) assertions, 0 failed")
