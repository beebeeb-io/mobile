import Foundation
import UIKit
import SDWebImage
import SDWebImageWebPCoder

/// Shared thumbnail generation using Rust Lanczos3 resize + Swift WebP encode.
///
/// Replaces the duplicated resize/encode code that was in both
/// `NativeBackupEngine` and `BeebeebCryptoModule`.
public enum ThumbnailGenerator {
    public struct Config {
        public let ladder: [(maxDimension: Int, quality: CGFloat)]
        public let targetBytes: Int
        public let maxBytes: Int

        public static let medium = Config(
            ladder: [
                (768, 0.82), (768, 0.74), (768, 0.66), (768, 0.58), (768, 0.50),
                (640, 0.58), (512, 0.56), (384, 0.54),
            ],
            targetBytes: 100 * 1024,
            maxBytes: 128 * 1024 - 28
        )

        public static let small = Config(
            ladder: [(384, 0.78), (384, 0.66), (384, 0.54), (320, 0.50), (256, 0.48)],
            targetBytes: 24 * 1024,
            maxBytes: 32 * 1024 - 28
        )

        public static let large = Config(
            ladder: [
                (1280, 0.84), (1280, 0.76), (1280, 0.68),
                (1024, 0.70), (768, 0.74), (640, 0.62),
            ],
            targetBytes: 150 * 1024,
            maxBytes: 192 * 1024 - 28
        )
    }

    /// Map a variant string ("small" / "medium" / "large") to the matching config.
    public static func config(for variant: String?) -> Config {
        switch variant ?? "medium" {
        case "small": return .small
        case "large": return .large
        default: return .medium
        }
    }

    /// Generate a WebP thumbnail from a UIImage using Rust resize + Swift WebP encode.
    public static func generate(from image: UIImage, config: Config) -> Data? {
        guard let cgImage = image.cgImage else { return nil }
        let srcWidth = UInt32(cgImage.width)
        let srcHeight = UInt32(cgImage.height)

        // Convert to RGBA
        guard let rgba = imageToRGBA(cgImage) else { return nil }

        var fallback: Data? = nil

        for step in config.ladder {
            // Resize via Rust (Lanczos3, SIMD)
            let resized: ResizeResult
            do {
                resized = try resizeForThumbnail(
                    rgba: rgba,
                    srcWidth: srcWidth,
                    srcHeight: srcHeight,
                    maxDimension: UInt32(step.maxDimension)
                )
            } catch {
                continue
            }

            // Convert back to UIImage for WebP encoding
            guard let resizedImage = rgbaToUIImage(
                resized.rgba, width: Int(resized.width), height: Int(resized.height)
            ) else { continue }

            // Encode to WebP via SDWebImageWebPCoder
            guard let webp = encodeWebP(resizedImage, quality: step.quality) else { continue }

            if webp.count <= config.targetBytes {
                return webp
            }
            if webp.count <= config.maxBytes && fallback == nil {
                fallback = webp
            }
        }

        return fallback
    }

    // MARK: - Private helpers

    private static func imageToRGBA(_ cgImage: CGImage) -> Data? {
        let width = cgImage.width
        let height = cgImage.height
        let bytesPerRow = width * 4
        var data = Data(count: height * bytesPerRow)
        data.withUnsafeMutableBytes { ptr in
            guard let context = CGContext(
                data: ptr.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return data
    }

    private static func rgbaToUIImage(_ data: Data, width: Int, height: Int) -> UIImage? {
        let bytesPerRow = width * 4
        guard let provider = CGDataProvider(data: data as CFData),
              let cgImage = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
              ) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    private static func encodeWebP(_ image: UIImage, quality: CGFloat) -> Data? {
        SDImageWebPCoder.shared.encodedData(
            with: image,
            format: .webP,
            options: [
                .encodeCompressionQuality: quality,
                .encodeFirstFrameOnly: true,
            ]
        ) as Data?
    }
}
