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

  /// Request the full-resolution image as a `UIImage` for thumbnail regeneration.
  /// Unlike `requestImage`, this returns the UIImage directly instead of writing
  /// to a file, because the caller (thumbnail encoder) needs the pixel data.
  ///
  /// `allowNetworkAccess` defaults to `false` (conservative). The "Improve
  /// thumbnail quality" repair path passes `true`: it is a deliberate user
  /// action, so fetching iCloud-offloaded originals over the network is
  /// expected — otherwise every optimized-storage original fails non-retriably
  /// (task 0883). This is NOT the latency-sensitive grid render path; that path
  /// uses `requestImage` above, which keeps `isNetworkAccessAllowed = false`.
  public func requestFullImage(
    localIdentifier: String,
    allowNetworkAccess: Bool = false
  ) async throws -> UIImage {
    let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
    guard let asset = assets.firstObject else {
      throw NSError(domain: "BeebeebPhotoKit", code: 404,
                    userInfo: [NSLocalizedDescriptionKey: "PHAsset not found for localIdentifier"])
    }

    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .none
    options.isNetworkAccessAllowed = allowNetworkAccess
    options.isSynchronous = false

    // Request at the asset's full pixel dimensions
    let fullSize = CGSize(width: CGFloat(asset.pixelWidth), height: CGFloat(asset.pixelHeight))

    return try await withCheckedThrowingContinuation { continuation in
      PHImageManager.default().requestImage(
        for: asset,
        targetSize: fullSize,
        contentMode: .default,
        options: options
      ) { image, info in
        let isDegraded = (info?[PHImageResultIsDegradedKey] as? NSNumber)?.boolValue ?? false
        if isDegraded { return }
        if let cancelled = info?[PHImageCancelledKey] as? NSNumber, cancelled.boolValue {
          continuation.resume(throwing: NSError(domain: "BeebeebPhotoKit", code: -999,
                                                userInfo: [NSLocalizedDescriptionKey: "request cancelled"]))
          return
        }
        if let error = info?[PHImageErrorKey] as? NSError {
          continuation.resume(throwing: error)
          return
        }
        guard let image else {
          continuation.resume(throwing: NSError(domain: "BeebeebPhotoKit", code: 404,
                                                userInfo: [NSLocalizedDescriptionKey: "PHImageManager returned nil"]))
          return
        }
        continuation.resume(returning: image)
      }
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
