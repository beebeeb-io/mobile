import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Photo preview encoder: sizes, no upscale, orientation, formats. Images are
// generated in memory; nothing large touches the disk.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}

/// Noisy-gradient RGB image so the encoders have something to compress.
func makeImage(_ w: Int, _ h: Int) -> CGImage {
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    for i in 0..<40 {
        ctx.setFillColor(red: CGFloat(i % 7) / 7, green: CGFloat(i % 5) / 5, blue: CGFloat(i % 3) / 3, alpha: 1)
        ctx.fill(CGRect(x: (i * w) / 40, y: (i * 37) % h, width: w / 8, height: h / 5))
    }
    return ctx.makeImage()!
}

/// Encodes `image` as JPEG in memory, optionally with an EXIF orientation tag.
func sourceData(_ w: Int, _ h: Int, orientation: Int? = nil) -> CGImageSource {
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    var props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
    if let o = orientation { props[kCGImagePropertyOrientation] = o }
    CGImageDestinationAddImage(dest, makeImage(w, h), props as CFDictionary)
    precondition(CGImageDestinationFinalize(dest))
    return CGImageSourceCreateWithData(out as CFData, nil)!
}

let heicAvailable = (CGImageDestinationCopyTypeIdentifiers() as? [String] ?? []).contains("public.heic")
print(heicAvailable ? "INFO: HEIC encoding available on this host" : "INFO: HEIC encoding NOT available on this host; skipping HEIC cases")

func brand(_ d: Data) -> String { String(decoding: d.subdata(in: 8..<min(d.count, 12)), as: UTF8.self) }
func isFtypHeif(_ d: Data) -> Bool {
    d.count > 12 && String(decoding: d.subdata(in: 4..<8), as: UTF8.self) == "ftyp" && ["heic", "mif1", "heix"].contains(brand(d))
}
func dims(_ d: Data) -> (Int, Int) {
    let s = CGImageSourceCreateWithData(d as CFData, nil)!
    let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as! [CFString: Any]
    return (p[kCGImagePropertyPixelWidth] as! Int, p[kCGImagePropertyPixelHeight] as! Int)
}

let big = sourceData(6000, 4000)

// JPEG @ 2560
let j = try PhotoPreviewEncoder.encode(source: big, format: .jpeg, longEdge: 2560)
check(j.width == 2560 && j.height == 1707, "jpeg 6000x4000 @2560 -> 2560x1707 (got \(j.width)x\(j.height))")
check(j.data.count > 2 && j.data[0] == 0xFF && j.data[1] == 0xD8, "jpeg output has FFD8 magic")
check(dims(j.data) == (2560, 1707), "jpeg decoded dimensions match reported")

// HEIC @ 2560
if heicAvailable {
    let h = try PhotoPreviewEncoder.encode(source: big, format: .heic, longEdge: 2560)
    check(h.width == 2560 && h.height == 1707, "heic 6000x4000 @2560 -> 2560x1707 (got \(h.width)x\(h.height))")
    check(isFtypHeif(h.data), "heic output is an ftyp box with heic/mif1 brand (\(brand(h.data)))")
    print("INFO: heic \(h.data.count) bytes vs jpeg \(j.data.count) bytes")
    check(h.data.count < j.data.count, "heic at 0.80 is smaller than jpeg at 0.80")
}

// No upscale
let small = sourceData(1000, 800)
let su = try PhotoPreviewEncoder.encode(source: small, format: .jpeg, longEdge: 3840)
check(su.width == 1000 && su.height == 800, "jpeg 1000x800 @3840 stays 1000x800 (got \(su.width)x\(su.height))")
if heicAvailable {
    let sh = try PhotoPreviewEncoder.encode(source: small, format: .heic, longEdge: 3840)
    check(sh.width == 1000 && sh.height == 800, "heic 1000x800 @3840 stays 1000x800")
}

// EXIF orientation 6 (rotate 90 CW): 3000x2000 stored -> 1707x2560 portrait at 2560
let rotated = sourceData(3000, 2000, orientation: 6)
let r = try PhotoPreviewEncoder.encode(source: rotated, format: .jpeg, longEdge: 2560)
check(r.width < r.height, "orientation 6 yields portrait output (got \(r.width)x\(r.height))")
check(r.height == 2560 && r.width == 1707, "orientation 6 @2560 -> 1707x2560")
let rs = try PhotoPreviewEncoder.encode(source: rotated, format: .jpeg, longEdge: 3840)
check(rs.width == 2000 && rs.height == 3000, "orientation 6 @3840 not upscaled (got \(rs.width)x\(rs.height))")

// Format parsing
check(PhotoPreviewFormat(rawValue: "heic") == .heic && PhotoPreviewFormat(rawValue: "jpeg") == .jpeg, "format raw values")
check(PhotoPreviewFormat(rawValue: "png") == nil, "unknown format rejected")

// Bad input
let empty = CGImageSourceCreateWithData(Data() as CFData, nil)
if let empty = empty {
    var threw = false
    do { _ = try PhotoPreviewEncoder.encode(source: empty, format: .jpeg, longEdge: 1280) } catch { threw = true }
    check(threw, "empty source throws")
} else {
    check(true, "empty data yields no source")
}

// Retry at lower quality when the first encode is over the cap
let fitsBig = try PhotoPreviewEncoder.encodeFittingCap(source: big, format: .jpeg, longEdge: 2560, maxBytes: Int.max)
check(fitsBig.data == j.data, "under the cap: the default-quality encode is kept")
let tight = try PhotoPreviewEncoder.encodeFittingCap(source: big, format: .jpeg, longEdge: 2560, maxBytes: j.data.count - 1)
check(tight.data.count < j.data.count, "over the cap: re-encoded once at a lower quality (\(tight.data.count) < \(j.data.count))")
let lowQ = try PhotoPreviewEncoder.encode(source: big, format: .jpeg, longEdge: 2560, quality: PhotoPreviewEncoder.retryQuality)
check(tight.data == lowQ.data, "the retry uses quality 0.6")
check(PhotoPreviewEncoder.retryQuality == 0.60, "retry quality is 0.6")

// Colour: the output keeps the source's colour profile and its colours. Tagged
// sources (sRGB as a camera writes it, Display P3 as an iPhone writes it, Adobe
// RGB as some cameras write it) are generated in memory with saturated patches,
// encoded through the real encoder, decoded again (colour-managed) and compared
// in the source's own colour space: a dropped or wrong profile would be read as
// sRGB and shift every patch. (Compared in sRGB, near-zero channels of colours
// outside sRGB are amplified by the conversion, so that is not a fair yardstick.)
func taggedSource(_ space: CFString) -> CGImageSource {
    let w = 600, h = 400
    let cs = CGColorSpace(name: space)!
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let patches: [(CGFloat, CGFloat, CGFloat)] = [(0.9, 0.1, 0.1), (0.1, 0.8, 0.2), (0.15, 0.2, 0.9), (0.95, 0.85, 0.2), (0.2, 0.2, 0.2), (0.85, 0.85, 0.85)]
    for (i, p) in patches.enumerated() {
        ctx.setFillColor(CGColor(colorSpace: cs, components: [p.0, p.1, p.2, 1])!)
        ctx.fill(CGRect(x: (i % 3) * 200, y: (i / 3) * 200, width: 200, height: 200))
    }
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImageDestinationLossyCompressionQuality: 1.0] as CFDictionary)
    precondition(CGImageDestinationFinalize(dest))
    return CGImageSourceCreateWithData(out as CFData, nil)!
}
func profileName(_ s: CGImageSource) -> String? {
    (CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any])?[kCGImagePropertyProfileName] as? String
}
/// Mean colour of patch centres (0-255), drawn (colour-managed) into `space`.
func patchMeans(_ s: CGImageSource, in space: CFString) -> [[Double]] {
    let img = CGImageSourceCreateImageAtIndex(s, 0, nil)!
    let w = img.width, h = img.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: space)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    var means: [[Double]] = []
    for i in 0..<6 {
        let cx = ((i % 3) * 2 + 1) * w / 6, cy = h - ((i / 3) * 2 + 1) * h / 4  // CG origin is bottom-left
        var sum = [0.0, 0.0, 0.0]; var n = 0.0
        for y in (cy - 20)..<(cy + 20) { for x in (cx - 20)..<(cx + 20) {
            let o = (y * w + x) * 4
            for k in 0..<3 { sum[k] += Double(buf[o + k]) }
            n += 1
        } }
        means.append(sum.map { $0 / n })
    }
    return means
}
let colourCases: [(CFString, String)] = [
    (CGColorSpace.sRGB, "sRGB IEC61966-2.1"), (CGColorSpace.displayP3, "Display P3"), (CGColorSpace.adobeRGB1998, "Adobe RGB (1998)"),
]
for (space, expectedProfile) in colourCases {
    let src = taggedSource(space)
    check(profileName(src) == expectedProfile, "test source is tagged \(expectedProfile) (got \(profileName(src) ?? "none"))")
    let want = patchMeans(src, in: space)
    for fmt in heicAvailable ? [PhotoPreviewFormat.heic, .jpeg] : [.jpeg] {
        for longEdge in [300, 600] {
            let enc = try PhotoPreviewEncoder.encode(source: src, format: fmt, longEdge: longEdge)
            let outSrc = CGImageSourceCreateWithData(enc.data as CFData, nil)!
            check(profileName(outSrc) == expectedProfile,
                  "\(fmt) @\(longEdge) from \(expectedProfile) keeps the profile (got \(profileName(outSrc) ?? "none"))")
            let got = patchMeans(outSrc, in: space)
            var worst = 0.0
            for (a, b) in zip(want, got) { for k in 0..<3 { worst = max(worst, abs(a[k] - b[k])) } }
            check(worst <= 4, "\(fmt) @\(longEdge) from \(expectedProfile): colours match the source (worst channel diff \(String(format: "%.2f", worst)))")
        }
    }
}

// Mirrored setting is account-scoped
let suite = "photo-preview-setting-test-\(UUID().uuidString)"
let defaults = UserDefaults(suiteName: suite)!
defer { defaults.removePersistentDomain(forName: suite) }
check(PhotoPreviewSettingStore.current(forAccount: "acct-a", defaults: defaults) == nil, "nothing stored: disabled")
try PhotoPreviewSettingStore.save(enabled: true, format: "heic", px: 3840, accountId: "acct-a", defaults: defaults)
let mine = PhotoPreviewSettingStore.current(forAccount: "acct-a", defaults: defaults)
check(mine?.format == .heic && mine?.px == 3840, "owner account sees its enabled setting")
check(PhotoPreviewSettingStore.current(forAccount: "acct-b", defaults: defaults) == nil, "another account's batch: disabled")
check(PhotoPreviewSettingStore.current(forAccount: "", defaults: defaults) == nil, "empty batch account: disabled")
defaults.removeObject(forKey: PhotoPreviewSettingStore.accountKey)
check(PhotoPreviewSettingStore.current(forAccount: "acct-a", defaults: defaults) == nil, "missing owner: disabled")
try PhotoPreviewSettingStore.save(enabled: true, format: "jpeg", px: 1280, accountId: "", defaults: defaults)
check(PhotoPreviewSettingStore.current(forAccount: "acct-a", defaults: defaults) == nil, "saved without an account: disabled for every batch")
try PhotoPreviewSettingStore.save(enabled: false, format: "jpeg", px: 1280, accountId: "acct-a", defaults: defaults)
check(PhotoPreviewSettingStore.current(forAccount: "acct-a", defaults: defaults) == nil, "Off: disabled")
var rejected = false
do { try PhotoPreviewSettingStore.save(enabled: true, format: "png", px: 1280, accountId: "acct-a", defaults: defaults) } catch { rejected = true }
check(rejected, "enabled with an unknown format is refused")
rejected = false
do { try PhotoPreviewSettingStore.save(enabled: true, format: "heic", px: 999, accountId: "acct-a", defaults: defaults) } catch { rejected = true }
check(rejected, "enabled with an unknown size is refused")
try PhotoPreviewSettingStore.save(enabled: true, format: "heic", px: 2560, accountId: "acct-a", defaults: defaults)
PhotoPreviewSettingStore.clear(defaults: defaults)
check(PhotoPreviewSettingStore.current(forAccount: "acct-a", defaults: defaults) == nil, "clear: disabled")
let keys = [PhotoPreviewSettingStore.enabledKey, PhotoPreviewSettingStore.formatKey, PhotoPreviewSettingStore.pxKey, PhotoPreviewSettingStore.accountKey]
check(keys.allSatisfy { defaults.object(forKey: $0) == nil }, "clear removes every io.beebeeb.photoPreview.* key")
check(keys.allSatisfy { $0.hasPrefix("io.beebeeb.photoPreview.") }, "all keys share the io.beebeeb.photoPreview. prefix")

print("photo-preview-encoder: \(assertions) assertions, 0 failed")
