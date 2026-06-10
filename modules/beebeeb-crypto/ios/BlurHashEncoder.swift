import UIKit

/// Self-contained BlurHash encoder (woltapp reference algorithm, public domain).
///
/// The JS upload path (`src/lib/thumbnail.ts` → `react-native-blurhash`) emits a
/// blurhash with `encode(uri, 4, 3)` for the medium thumbnail (task 0552). The
/// native camera-roll backup path (`NativeBackupEngine`) does its own thumbnail
/// generation and never touched JS, so backed-up photos had a NULL `files.blurhash`
/// and showed no instant placeholder in the Photos grid. This encoder closes that
/// gap natively (task 0631): same 4x3 components, same ~28-char output, so the
/// existing decoder (`react-native-blurhash` on render, web blurhash on web)
/// renders the placeholder identically regardless of which client produced it.
///
/// Computed off a small downscale (≤32px) — blurhash only needs a coarse image,
/// and the basis-function pass is O(width·height·components).
public enum BlurHashEncoder {
    /// Encode `image` to a blurhash string. Returns nil on any failure (the
    /// caller treats a missing blurhash as "no placeholder", never an error).
    public static func encode(_ image: UIImage, componentsX: Int = 4, componentsY: Int = 3) -> String? {
        guard componentsX >= 1, componentsX <= 9, componentsY >= 1, componentsY <= 9 else { return nil }
        guard let small = downscale(image, maxDimension: 32), let cg = small.cgImage else { return nil }

        let width = cg.width
        let height = cg.height
        guard width > 0, height > 0 else { return nil }

        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
        let drawn: Bool = pixels.withUnsafeMutableBytes { ptr -> Bool in
            guard let base = ptr.baseAddress, let ctx = CGContext(
                data: base,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }

        var factors: [(Float, Float, Float)] = []
        factors.reserveCapacity(componentsX * componentsY)
        for y in 0..<componentsY {
            for x in 0..<componentsX {
                let normalisation: Float = (x == 0 && y == 0) ? 1 : 2
                let factor = multiplyBasisFunction(
                    componentX: x,
                    componentY: y,
                    width: width,
                    height: height,
                    bytesPerRow: bytesPerRow,
                    pixels: pixels,
                    normalisation: normalisation
                )
                factors.append(factor)
            }
        }

        guard let dc = factors.first else { return nil }
        let ac = Array(factors.dropFirst())

        var hash = ""
        let sizeFlag = (componentsX - 1) + (componentsY - 1) * 9
        hash += encode83(sizeFlag, length: 1)

        let maximumValue: Float
        if !ac.isEmpty {
            let actualMax = ac.map { Swift.max(abs($0.0), abs($0.1), abs($0.2)) }.max() ?? 0
            let quantisedMaximumValue = Int(Swift.max(0, Swift.min(82, floor(actualMax * 166 - 0.5))))
            maximumValue = Float(quantisedMaximumValue + 1) / 166
            hash += encode83(quantisedMaximumValue, length: 1)
        } else {
            maximumValue = 1
            hash += encode83(0, length: 1)
        }

        hash += encode83(encodeDC(dc), length: 4)
        for factor in ac {
            hash += encode83(encodeAC(factor, maximumValue: maximumValue), length: 2)
        }
        return hash
    }

    // MARK: - Basis function

    private static func multiplyBasisFunction(
        componentX: Int,
        componentY: Int,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        pixels: [UInt8],
        normalisation: Float
    ) -> (Float, Float, Float) {
        var r: Float = 0, g: Float = 0, b: Float = 0
        for y in 0..<height {
            let rowBase = y * bytesPerRow
            for x in 0..<width {
                let basis = cos(Float.pi * Float(componentX) * Float(x) / Float(width)) *
                            cos(Float.pi * Float(componentY) * Float(y) / Float(height))
                let i = rowBase + x * 4
                r += basis * srgbToLinear(pixels[i])
                g += basis * srgbToLinear(pixels[i + 1])
                b += basis * srgbToLinear(pixels[i + 2])
            }
        }
        let scale = normalisation / Float(width * height)
        return (r * scale, g * scale, b * scale)
    }

    // MARK: - Colour helpers

    private static func encodeDC(_ value: (Float, Float, Float)) -> Int {
        let r = linearToSrgb(value.0)
        let g = linearToSrgb(value.1)
        let b = linearToSrgb(value.2)
        return (r << 16) + (g << 8) + b
    }

    private static func encodeAC(_ value: (Float, Float, Float), maximumValue: Float) -> Int {
        let quant: (Float) -> Int = { v in
            Int(Swift.max(0, Swift.min(18, floor(signPow(v / maximumValue, 0.5) * 9 + 9.5))))
        }
        return quant(value.0) * 19 * 19 + quant(value.1) * 19 + quant(value.2)
    }

    private static func srgbToLinear(_ value: UInt8) -> Float {
        let v = Float(value) / 255
        return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }

    private static func linearToSrgb(_ value: Float) -> Int {
        let v = Swift.max(0, Swift.min(1, value))
        if v <= 0.0031308 {
            return Int(v * 12.92 * 255 + 0.5)
        }
        return Int((1.055 * pow(v, 1 / 2.4) - 0.055) * 255 + 0.5)
    }

    private static func signPow(_ value: Float, _ exp: Float) -> Float {
        return (value < 0 ? -1 : 1) * pow(abs(value), exp)
    }

    // MARK: - Base83

    private static let base83Chars = Array(
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"
    )

    private static func encode83(_ value: Int, length: Int) -> String {
        var result = ""
        for i in 1...length {
            let digit = (value / Int(pow(83.0, Double(length - i)))) % 83
            result.append(base83Chars[digit])
        }
        return result
    }

    // MARK: - Downscale

    private static func downscale(_ image: UIImage, maxDimension: CGFloat) -> UIImage? {
        let w = image.size.width
        let h = image.size.height
        guard w > 0, h > 0 else { return nil }
        let scale = Swift.min(1, maxDimension / Swift.max(w, h))
        let size = CGSize(width: Swift.max(1, round(w * scale)), height: Swift.max(1, round(h * scale)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}
