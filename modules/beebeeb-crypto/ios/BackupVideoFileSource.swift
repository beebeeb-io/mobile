import AVFoundation
import Foundation

/// Owns only files exported by backup; a PhotoKit source URL is never deleted.
struct BackupVideoFileSource {
  let asset: AVAsset
  let url: URL
  let uti: String
  let sizeBytes: Int
  let ownsFile: Bool

  private static let exportLock = NSLock()
  private static var activeExportURLs = Set<URL>()

  static func reserveExportURL(in directory: URL, fileExtension: String) -> URL {
    exportLock.lock()
    defer { exportLock.unlock() }
    let url = directory.appendingPathComponent("backup-video-\(UUID().uuidString).\(fileExtension)")
    activeExportURLs.insert(url.standardizedFileURL)
    return url
  }

  /// A killed process leaves no live reservations. Keep the lock across
  /// enumeration/removal so a concurrent export cannot be swept after reserve.
  static func sweepAbandonedExports(in directory: URL) {
    exportLock.lock()
    defer { exportLock.unlock() }
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]
    ) else { return }
    for url in urls {
      guard url.lastPathComponent.hasPrefix("backup-video-"),
            ["mov", "mp4"].contains(url.pathExtension.lowercased()),
            !activeExportURLs.contains(url.standardizedFileURL),
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
            values.isRegularFile == true, values.isSymbolicLink != true else { continue }
      try? FileManager.default.removeItem(at: url)
    }
  }

  func cleanup() {
    guard ownsFile else { return }
    Self.exportLock.lock()
    defer { Self.exportLock.unlock() }
    try? FileManager.default.removeItem(at: url)
    Self.activeExportURLs.remove(url.standardizedFileURL)
  }

  static func resolve(
    asset: AVAsset,
    audioMix: AVAudioMix?,
    exportDirectory: URL
  ) async throws -> BackupVideoFileSource {
    try Task.checkCancellation()
    if let source = asset as? AVURLAsset,
       FileManager.default.isReadableFile(atPath: source.url.path),
       let values = try? source.url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
       values.isRegularFile == true, let size = values.fileSize, size > 0 {
      return Self(asset: asset, url: source.url,
                  uti: source.url.pathExtension.lowercased() == "mov" ? "com.apple.quicktime-movie" : "public.mpeg-4",
                  sizeBytes: size, ownsFile: false)
    }
    try FileManager.default.createDirectory(at: exportDirectory, withIntermediateDirectories: true)
    guard PlaintextStorageProtection.protect(exportDirectory),
          let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
      throw NSError(domain: "BackupVideoExport", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Could not prepare video backup export"])
    }
    exporter.audioMix = audioMix
    let types = exporter.supportedFileTypes
    let type: AVFileType
    if types.contains(.mov) { type = .mov }
    else if types.contains(.mp4) { type = .mp4 }
    else { throw NSError(domain: "BackupVideoExport", code: 2,
                         userInfo: [NSLocalizedDescriptionKey: "This video cannot be exported for backup"]) }
    let url = reserveExportURL(in: exportDirectory, fileExtension: type == .mov ? "mov" : "mp4")
    do {
      if #available(iOS 18.0, macOS 15.0, *) {
        try await exporter.export(to: url, as: type)
      } else {
        exporter.outputURL = url
        exporter.outputFileType = type
        try await withTaskCancellationHandler {
          try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            exporter.exportAsynchronously {
              if exporter.status == .completed { continuation.resume() }
              else { continuation.resume(throwing: exporter.error ?? CancellationError()) }
            }
          }
        } onCancel: {
          exporter.cancelExport()
        }
      }
      try Task.checkCancellation()
      guard PlaintextStorageProtection.protect(url),
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else {
        throw NSError(domain: "BackupVideoExport", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "Video backup export was empty or unavailable"])
      }
      return Self(asset: asset, url: url,
                  uti: type == .mov ? "com.apple.quicktime-movie" : "public.mpeg-4",
                  sizeBytes: size, ownsFile: true)
    } catch {
      Self(asset: asset, url: url, uti: "", sizeBytes: 0, ownsFile: true).cleanup()
      throw error
    }
  }
}
