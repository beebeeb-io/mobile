import Foundation

struct PreviewChunkPlan {
  static let frameOverheadBytes = 28
  static let maxChunkCount = 1_000_000
  static let maxPlaintextChunkSize = 256 * 1024 * 1024

  let chunkCount: Int
  let originalSize: Int
  let plaintextChunkSize: Int
  let expectedEncryptedSize: Int

  init(chunkCount: Int, originalSize: Int, plaintextChunkSize: Int) throws {
    guard chunkCount > 0, chunkCount <= Self.maxChunkCount else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 20,
        userInfo: [NSLocalizedDescriptionKey: "Invalid chunk count"]
      )
    }
    guard originalSize >= 0 else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 21,
        userInfo: [NSLocalizedDescriptionKey: "Invalid download size metadata"]
      )
    }
    if originalSize == 0 {
      guard chunkCount == 1, plaintextChunkSize == 0 else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 21,
          userInfo: [NSLocalizedDescriptionKey: "Invalid empty-file chunk metadata"]
        )
      }
    } else {
      guard plaintextChunkSize > 0, plaintextChunkSize <= Self.maxPlaintextChunkSize else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 21,
          userInfo: [NSLocalizedDescriptionKey: "Invalid plaintext chunk size"]
        )
      }
      if chunkCount == 1 {
        guard plaintextChunkSize == originalSize, originalSize <= Self.maxPlaintextChunkSize else {
          throw NSError(
            domain: "BeebeebPreviewDownload",
            code: 21,
            userInfo: [NSLocalizedDescriptionKey: "Single chunk metadata exceeds bounded frame size"]
          )
        }
      } else {
        let fullChunkCount = chunkCount - 1
        let fullChunkBytes = plaintextChunkSize.multipliedReportingOverflow(by: fullChunkCount)
        guard !fullChunkBytes.overflow, fullChunkBytes.partialValue < originalSize else {
          throw NSError(
            domain: "BeebeebPreviewDownload",
            code: 21,
            userInfo: [NSLocalizedDescriptionKey: "Chunk metadata exceeds original size"]
          )
        }
        let maxPlaintextBytes = plaintextChunkSize.multipliedReportingOverflow(by: chunkCount)
        guard !maxPlaintextBytes.overflow, originalSize <= maxPlaintextBytes.partialValue else {
          throw NSError(
            domain: "BeebeebPreviewDownload",
            code: 21,
            userInfo: [NSLocalizedDescriptionKey: "Original size exceeds declared chunks"]
          )
        }
      }
    }

    let overheadBytes = Self.frameOverheadBytes.multipliedReportingOverflow(by: chunkCount)
    guard !overheadBytes.overflow else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 21,
        userInfo: [NSLocalizedDescriptionKey: "Encrypted size metadata overflow"]
      )
    }
    let expectedEncryptedSize = originalSize.addingReportingOverflow(overheadBytes.partialValue)
    guard !expectedEncryptedSize.overflow else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 21,
        userInfo: [NSLocalizedDescriptionKey: "Encrypted size metadata overflow"]
      )
    }

    self.chunkCount = chunkCount
    self.originalSize = originalSize
    self.plaintextChunkSize = plaintextChunkSize
    self.expectedEncryptedSize = expectedEncryptedSize.partialValue
  }

  func plaintextSize(at index: Int) throws -> Int {
    guard index >= 0, index < chunkCount else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 22,
        userInfo: [NSLocalizedDescriptionKey: "Chunk index out of bounds"]
      )
    }
    if originalSize == 0 {
      return 0
    }
    if chunkCount == 1 {
      return originalSize
    }
    let isLast = index == chunkCount - 1
    let size = isLast ? originalSize - plaintextChunkSize * (chunkCount - 1) : plaintextChunkSize
    guard size > 0 else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 23,
        userInfo: [NSLocalizedDescriptionKey: "Invalid chunk size"]
      )
    }
    return size
  }

  func frameSize(at index: Int) throws -> Int {
    let size = try plaintextSize(at: index).addingReportingOverflow(Self.frameOverheadBytes)
    guard !size.overflow else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 23,
        userInfo: [NSLocalizedDescriptionKey: "Encrypted frame size overflow"]
      )
    }
    return size.partialValue
  }
}

final class PreviewChunkPipeline {
  struct Result {
    let outputPath: String
    let plaintextSize: Int
    let chunksDecrypted: Int
  }

  private let plan: PreviewChunkPlan
  private let outputURL: URL
  private let tmpURL: URL
  private let decryptFrame: (Data) throws -> Data
  private let onChunkDecrypted: (Int, Int) -> Void
  private var buffer = Data()
  private var chunkIndex = 0
  private var plaintextBytes = 0
  private var finished = false
  private let handle: FileHandle

  init(
    plan: PreviewChunkPlan,
    outputURL: URL,
    decryptFrame: @escaping (Data) throws -> Data,
    onChunkDecrypted: @escaping (Int, Int) -> Void
  ) throws {
    self.plan = plan
    self.outputURL = outputURL
    self.tmpURL = outputURL
      .deletingLastPathComponent()
      .appendingPathComponent(".\(outputURL.lastPathComponent).\(UUID().uuidString).tmp")
    self.decryptFrame = decryptFrame
    self.onChunkDecrypted = onChunkDecrypted

    let outputDirectory = outputURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: outputDirectory,
      withIntermediateDirectories: true
    )
    Self.protectPlaintextPath(outputDirectory)
    FileManager.default.createFile(atPath: tmpURL.path, contents: nil)
    Self.protectPlaintextPath(tmpURL)
    self.handle = try FileHandle(forWritingTo: tmpURL)
  }

  deinit {
    try? handle.close()
  }

  func receive(_ data: Data) throws {
    guard !finished else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 24,
        userInfo: [NSLocalizedDescriptionKey: "Received data after pipeline finished"]
      )
    }
    guard !data.isEmpty else { return }
    guard data.count <= Int.max - buffer.count else {
      throw NSError(
        domain: "BeebeebPreviewDownload",
        code: 29,
        userInfo: [NSLocalizedDescriptionKey: "Encrypted buffer size overflow"]
      )
    }
    buffer.append(data)
    try drainCompleteFrames()
  }

  func finish() throws -> Result {
    guard !finished else {
      return Result(outputPath: outputURL.path, plaintextSize: plaintextBytes, chunksDecrypted: chunkIndex)
    }
    do {
      try drainCompleteFrames()
      guard chunkIndex == plan.chunkCount else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 25,
          userInfo: [NSLocalizedDescriptionKey: "Encrypted payload ended before chunk \(chunkIndex)"]
        )
      }
      guard buffer.isEmpty else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 26,
          userInfo: [NSLocalizedDescriptionKey: "Encrypted payload has trailing bytes"]
        )
      }
      guard plaintextBytes == plan.originalSize else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 27,
          userInfo: [NSLocalizedDescriptionKey: "Plaintext size mismatch"]
        )
      }
      try handle.close()
      try? FileManager.default.removeItem(at: outputURL)
      try FileManager.default.moveItem(at: tmpURL, to: outputURL)
      Self.protectPlaintextPath(outputURL)
      finished = true
      return Result(outputPath: outputURL.path, plaintextSize: plaintextBytes, chunksDecrypted: chunkIndex)
    } catch {
      cleanup()
      throw error
    }
  }

  func cleanup() {
    try? handle.close()
    try? FileManager.default.removeItem(at: tmpURL)
  }

  private func drainCompleteFrames() throws {
    while chunkIndex < plan.chunkCount {
      let frameSize = try plan.frameSize(at: chunkIndex)
      guard buffer.count >= frameSize else { return }
      let frame = buffer.prefix(frameSize)
      buffer.removeSubrange(0..<frameSize)
      let plaintext = try decryptFrame(Data(frame))
      let expectedPlaintextSize = try plan.plaintextSize(at: chunkIndex)
      guard plaintext.count == expectedPlaintextSize else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 28,
          userInfo: [NSLocalizedDescriptionKey: "Decrypted chunk \(chunkIndex) size mismatch"]
        )
      }
      try handle.write(contentsOf: plaintext)
      let newPlaintextBytes = plaintextBytes.addingReportingOverflow(plaintext.count)
      guard !newPlaintextBytes.overflow, newPlaintextBytes.partialValue <= plan.originalSize else {
        throw NSError(
          domain: "BeebeebPreviewDownload",
          code: 27,
          userInfo: [NSLocalizedDescriptionKey: "Plaintext size overflow"]
        )
      }
      plaintextBytes = newPlaintextBytes.partialValue
      chunkIndex += 1
      onChunkDecrypted(chunkIndex, plan.chunkCount)
    }
  }

  private static func protectPlaintextPath(_ url: URL) {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableURL = url
    try? mutableURL.setResourceValues(values)
#if os(iOS) || os(tvOS) || os(watchOS)
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: url.path
    )
#endif
  }
}
