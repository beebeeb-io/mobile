import Foundation
import Photos
import UIKit

public enum PhotoKitResult: Sendable, Equatable {
  case success(URL)
  case notFound
  case error(String)
}

public actor PhotoKitResolver {
  public static let shared = PhotoKitResolver()

  private var inFlightRequests: [FileId: PHImageRequestID] = [:]

  private let cacheDirectory: URL = {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    let dir = docs.appendingPathComponent("beebeeb-photokit-cache", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  public func requestImage(
    fileId: FileId,
    localIdentifier: String,
    targetSize: CGSize
  ) async -> PhotoKitResult {
    cancelInFlight(for: fileId)

    let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
    guard let asset = assets.firstObject else {
      return .notFound
    }

    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .exact
    options.isNetworkAccessAllowed = false
    options.isSynchronous = false

    let pixelSize = CGSize(
      width: max(96, targetSize.width * UIScreen.main.scale),
      height: max(96, targetSize.height * UIScreen.main.scale)
    )

    return await withCheckedContinuation { continuation in
      let requestId = PHImageManager.default().requestImage(
        for: asset,
        targetSize: pixelSize,
        contentMode: .aspectFill,
        options: options
      ) { image, info in
        let isDegraded = (info?[PHImageResultIsDegradedKey] as? NSNumber)?.boolValue ?? false
        if isDegraded {
          return
        }
        if let cancelled = info?[PHImageCancelledKey] as? NSNumber, cancelled.boolValue {
          continuation.resume(returning: .error("cancelled"))
          return
        }
        if let error = info?[PHImageErrorKey] as? NSError {
          if error.code == 3164 {
            continuation.resume(returning: .notFound)
          } else {
            continuation.resume(returning: .error(error.localizedDescription))
          }
          return
        }
        guard let image else {
          continuation.resume(returning: .notFound)
          return
        }
        let outURL = self.cacheDirectory.appendingPathComponent("\(fileId).png")
        guard let data = image.pngData() else {
          continuation.resume(returning: .error("pngData() returned nil"))
          return
        }
        do {
          try data.write(to: outURL, options: .atomic)
          continuation.resume(returning: .success(outURL))
        } catch {
          continuation.resume(returning: .error("write failed: \(error.localizedDescription)"))
        }
      }
      Task { await self.register(requestId: requestId, for: fileId) }
    }
  }

  public func cancelInFlight(for fileId: FileId) {
    if let id = inFlightRequests.removeValue(forKey: fileId) {
      PHImageManager.default().cancelImageRequest(id)
    }
  }

  private func register(requestId: PHImageRequestID, for fileId: FileId) {
    inFlightRequests[fileId] = requestId
  }
}
