import Foundation
import CoreGraphics
import ImageIO

/// Wire/UI format of a photo preview.
enum PhotoPreviewFormat: String {
  case heic
  case jpeg

  var typeIdentifier: CFString {
    switch self {
    case .heic: return "public.heic" as CFString
    case .jpeg: return "public.jpeg" as CFString
    }
  }

  var fileExtension: String { self == .heic ? "heic" : "jpg" }
}

enum PhotoPreviewEncoderError: Error {
  case unreadableSource
  case thumbnailFailed
  case destinationUnavailable
  case finalizeFailed
}

/// Pure ImageIO encoder, no PhotoKit. Decodes through
/// `CGImageSourceCreateThumbnailAtIndex` so a large original is downsampled
/// during decode and its full bitmap is never held in memory.
enum PhotoPreviewEncoder {
  static func encode(
    source: CGImageSource,
    format: PhotoPreviewFormat,
    longEdge: Int,
    quality: CGFloat = 0.80
  ) throws -> (data: Data, width: Int, height: Int) {
    guard CGImageSourceGetCount(source) > 0,
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let w = props[kCGImagePropertyPixelWidth] as? Int,
          let h = props[kCGImagePropertyPixelHeight] as? Int,
          w > 0, h > 0
    else { throw PhotoPreviewEncoderError.unreadableSource }

    // Never upscale: cap at the source's own long edge.
    let maxPixel = max(1, min(longEdge, max(w, h)))
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceShouldCacheImmediately: false,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      throw PhotoPreviewEncoderError.thumbnailFailed
    }

    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, format.typeIdentifier, 1, nil) else {
      throw PhotoPreviewEncoderError.destinationUnavailable
    }
    let destProps: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(dest, image, destProps as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw PhotoPreviewEncoderError.finalizeFailed }
    return (out as Data, image.width, image.height)
  }

  /// Quality used for the one retry when the first encode does not fit the upload cap.
  static let retryQuality: CGFloat = 0.60

  /// Encode at the default quality; when the result is larger than `maxBytes`
  /// (a noisy 4K JPEG can be), encode once more at `retryQuality`. The caller
  /// still enforces the cap on the encrypted bytes.
  static func encodeFittingCap(
    source: CGImageSource,
    format: PhotoPreviewFormat,
    longEdge: Int,
    maxBytes: Int
  ) throws -> (data: Data, width: Int, height: Int) {
    let first = try encode(source: source, format: format, longEdge: longEdge)
    guard first.data.count > maxBytes else { return first }
    return try encode(source: source, format: format, longEdge: longEdge, quality: retryQuality)
  }
}

/// The account's photo preview setting, mirrored from JS. Stored in the app's own
/// UserDefaults (not the App Group) together with the account it belongs to; the
/// backup engine reads it after each upload and only for that same account.
enum PhotoPreviewSettingStore {
  static let enabledKey = "io.beebeeb.photoPreview.enabled"
  static let formatKey = "io.beebeeb.photoPreview.format"
  static let pxKey = "io.beebeeb.photoPreview.px"
  static let accountKey = "io.beebeeb.photoPreview.accountId"
  static let allowedPx: Set<Int> = [1280, 1920, 2560, 3840]

  enum StoreError: Error {
    case invalidFormat
    case invalidSize
  }

  /// An enabled setting needs a valid format and size. `accountId` is the account
  /// the setting was read for; an empty id stores a setting no batch can match.
  static func save(enabled: Bool, format: String, px: Int, accountId: String, defaults: UserDefaults = .standard) throws {
    if enabled {
      guard PhotoPreviewFormat(rawValue: format) != nil else { throw StoreError.invalidFormat }
      guard allowedPx.contains(px) else { throw StoreError.invalidSize }
    }
    defaults.set(enabled, forKey: enabledKey)
    defaults.set(accountId, forKey: accountKey)
    if PhotoPreviewFormat(rawValue: format) != nil { defaults.set(format, forKey: formatKey) }
    if allowedPx.contains(px) { defaults.set(px, forKey: pxKey) }
  }

  /// nil unless previews are enabled with a valid format and size, and the stored
  /// owner is exactly `accountId`. A missing or different owner means disabled.
  static func current(forAccount accountId: String, defaults: UserDefaults = .standard) -> (format: PhotoPreviewFormat, px: Int)? {
    guard !accountId.isEmpty,
          defaults.string(forKey: accountKey) == accountId,
          defaults.bool(forKey: enabledKey),
          let raw = defaults.string(forKey: formatKey), let format = PhotoPreviewFormat(rawValue: raw),
          allowedPx.contains(defaults.integer(forKey: pxKey)) else { return nil }
    return (format, defaults.integer(forKey: pxKey))
  }

  /// Sign-out / account purge: forget the setting and its owner.
  static func clear(defaults: UserDefaults = .standard) {
    for key in [enabledKey, formatKey, pxKey, accountKey] { defaults.removeObject(forKey: key) }
  }
}
