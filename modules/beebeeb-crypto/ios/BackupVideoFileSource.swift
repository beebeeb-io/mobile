import AVFoundation
import Foundation

/// Owns only files exported by backup; a PhotoKit source URL is never deleted.
struct BackupVideoFileSource {
  let asset: AVAsset
  let url: URL
  let uti: String
  let sizeBytes: Int
  let ownsFile: Bool

  func cleanup() {
    if ownsFile { try? FileManager.default.removeItem(at: url) }
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
    let url = exportDirectory.appendingPathComponent("backup-video-\(UUID().uuidString).\(type == .mov ? "mov" : "mp4")")
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
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }
}
