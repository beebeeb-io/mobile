#!/usr/bin/env swift
// Task 1721 — hostless ImageIO behavior harness for the iOS DNG thumbnail path.
// This mirrors BeebeebCryptoModule.generateDngThumbnail's ImageIO extraction
// logic while stubbing UIImage and ThumbnailGenerator, so it can run with
// `swift scripts/test-dng-thumbnail-imageio.swift` without building the app.

import CoreGraphics
import Foundation
import ImageIO

private struct UIImage {
  let cgImage: CGImage
}

private struct CapturedThumbnail {
  let width: Int
  let height: Int
  let config: ThumbnailGenerator.Config
}

private enum ThumbnailGenerator {
  enum Config: String {
    case small
    case medium
    case large
  }

  private(set) static var lastCapture: CapturedThumbnail?

  static func generate(from image: UIImage, config: Config) -> Data? {
    lastCapture = CapturedThumbnail(
      width: image.cgImage.width,
      height: image.cgImage.height,
      config: config
    )
    return Data([0x42])
  }

  static func clear() {
    lastCapture = nil
  }
}

private struct GeneratedThumbnail {
  let outputPath: String
  let capture: CapturedThumbnail
  let elapsedMs: Double
}

private enum HarnessError: Error, CustomStringConvertible {
  case missingFixture(String)
  case failedToOpenSource
  case failedToExtractPreview
  case failedToEncode
  case missingCapture
  case assertion(String)

  var description: String {
    switch self {
    case .missingFixture(let path): return "missing fixture: \(path)"
    case .failedToOpenSource: return "failed to open DNG image source"
    case .failedToExtractPreview: return "failed to extract DNG preview"
    case .failedToEncode: return "failed to encode DNG thumbnail"
    case .missingCapture: return "ThumbnailGenerator stub did not capture input"
    case .assertion(let message): return message
    }
  }
}

private func fileURL(fromURI uri: String) -> URL {
  if let url = URL(string: uri), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: uri)
}

private func generateDngThumbnail(
  localUri: String,
  maxSize: Int,
  omitMaxPixelSize: Bool = false
) throws -> GeneratedThumbnail {
  let url = fileURL(fromURI: localUri)

  let sourceOptions: CFDictionary = [
    kCGImageSourceShouldCache: false,
    kCGImageSourceShouldCacheImmediately: false
  ] as CFDictionary

  guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else {
    throw HarnessError.failedToOpenSource
  }

  let safeMaxSize = max(256, min(maxSize, 1600))
  var thumbnailOptions: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceShouldCache: false,
    kCGImageSourceShouldCacheImmediately: true,
  ]
  if !omitMaxPixelSize {
    thumbnailOptions[kCGImageSourceThumbnailMaxPixelSize] = safeMaxSize
  }

  let start = DispatchTime.now().uptimeNanoseconds
  guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
    throw HarnessError.failedToExtractPreview
  }
  let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000

  let image = UIImage(cgImage: cgImage)
  let config: ThumbnailGenerator.Config
  if maxSize >= 1200 {
    config = .large
  } else if maxSize <= 384 {
    config = .small
  } else {
    config = .medium
  }

  ThumbnailGenerator.clear()
  guard let webpData = ThumbnailGenerator.generate(from: image, config: config) else {
    throw HarnessError.failedToEncode
  }
  guard let capture = ThumbnailGenerator.lastCapture else {
    throw HarnessError.missingCapture
  }

  let outputPath = NSTemporaryDirectory() + "dng-thumb-\(UUID().uuidString).webp"
  try webpData.write(to: URL(fileURLWithPath: outputPath))
  return GeneratedThumbnail(outputPath: outputPath, capture: capture, elapsedMs: elapsedMs)
}

private struct Case {
  let maxSize: Int
  let expectedConfig: ThumbnailGenerator.Config
}

private let repoRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
private let fixturePath = repoRoot
  .appendingPathComponent("e2e/fixtures/preview-matrix/raw/sample.dng")
  .path
private let omitMaxPixelSize = CommandLine.arguments.contains("--mutate-no-max-pixel-size")
private var passCount = 0
private var failCount = 0
private var latencyLines: [String] = []

private func record(_ name: String, _ body: () throws -> Void) {
  do {
    try body()
    passCount += 1
    print("PASS \(name)")
  } catch {
    failCount += 1
    print("FAIL \(name): \(error)")
  }
}

record("fixture exists") {
  guard FileManager.default.fileExists(atPath: fixturePath) else {
    throw HarnessError.missingFixture(fixturePath)
  }
}

for testCase in [
  Case(maxSize: 384, expectedConfig: .small),
  Case(maxSize: 768, expectedConfig: .medium),
  Case(maxSize: 1600, expectedConfig: .large),
] {
  record("sample.dng max \(testCase.maxSize) stays capped and uses \(testCase.expectedConfig.rawValue)") {
    let generated = try generateDngThumbnail(
      localUri: fixturePath,
      maxSize: testCase.maxSize,
      omitMaxPixelSize: omitMaxPixelSize
    )
    defer { try? FileManager.default.removeItem(atPath: generated.outputPath) }

    let maxDecodedDimension = max(generated.capture.width, generated.capture.height)
    latencyLines.append(
      "max=\(testCase.maxSize) decoded=\(generated.capture.width)x\(generated.capture.height) config=\(generated.capture.config.rawValue) imageioMs=\(String(format: "%.2f", generated.elapsedMs))"
    )
    guard maxDecodedDimension <= testCase.maxSize else {
      throw HarnessError.assertion(
        "decoded \(generated.capture.width)x\(generated.capture.height) exceeds cap \(testCase.maxSize)"
      )
    }
    guard generated.capture.config == testCase.expectedConfig else {
      throw HarnessError.assertion(
        "config \(generated.capture.config.rawValue) != \(testCase.expectedConfig.rawValue)"
      )
    }
  }
}

record("corrupt DNG source throws") {
  let corruptPath = NSTemporaryDirectory() + "corrupt-\(UUID().uuidString).dng"
  try Data("not-a-dng".utf8).write(to: URL(fileURLWithPath: corruptPath))
  defer { try? FileManager.default.removeItem(atPath: corruptPath) }
  do {
    _ = try generateDngThumbnail(localUri: corruptPath, maxSize: 384)
    throw HarnessError.assertion("corrupt source unexpectedly generated a thumbnail")
  } catch HarnessError.failedToOpenSource {
    return
  } catch HarnessError.failedToExtractPreview {
    return
  }
}

for line in latencyLines {
  print("LATENCY \(line)")
}
print("RESULT pass=\(passCount) fail=\(failCount) mutation=\(omitMaxPixelSize ? "no-max-pixel-size" : "none")")
if failCount > 0 {
  exit(1)
}
