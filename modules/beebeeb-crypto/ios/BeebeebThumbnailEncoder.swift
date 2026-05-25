import UIKit
import SDWebImage
import SDWebImageWebPCoder

/// Resize a UIImage and encode it as WebP with the given quality.
///
/// Uses `SDWebImageWebPCoder` (already a pod dependency) for the WebP encoding
/// and `UIGraphicsImageRenderer` for the resize — both are production-proven
/// in the NativeBackupEngine and BeebeebCryptoModule.
public enum BeebeebThumbnailEncoder {

    /// Resize `image` to `targetWidth` (preserving aspect ratio) and encode as WebP.
    /// - Returns: WebP-encoded `Data`
    /// - Throws: if WebP encoding fails
    public static func encode(image: UIImage, targetWidth: Int, quality: CGFloat) throws -> Data {
        let scaledImage = resize(image: image, targetWidth: CGFloat(targetWidth))
        let options: [SDImageCoderOption: Any] = [
            .encodeCompressionQuality: quality,
            .encodeFirstFrameOnly: true,
        ]
        guard let data = SDImageWebPCoder.shared.encodedData(
            with: scaledImage,
            format: .webP,
            options: options
        ) else {
            throw NSError(
                domain: "BeebeebThumbnailGen", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "WebP encode failed"]
            )
        }
        return data
    }

    private static func resize(image: UIImage, targetWidth: CGFloat) -> UIImage {
        let ratio = image.size.height / max(1, image.size.width)
        let size = CGSize(width: targetWidth, height: round(targetWidth * ratio))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}
