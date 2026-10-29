import Foundation

var assertionCount = 0

func fail(_ message: String) -> Never {
  fputs("preview-chunk-pipeline-test: FAIL: \(message)\n", stderr)
  exit(1)
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertionCount += 1
  if !condition() {
    fail(message)
  }
}

func expectThrows(_ message: String, _ body: () throws -> Void) {
  assertionCount += 1
  do {
    try body()
    fail(message)
  } catch {
    // Expected.
  }
}

struct PreviewChunkPipelineTest {
  static func makeFrame(_ plaintext: Data) -> Data {
    var frame = Data(repeating: 0xA5, count: PreviewChunkPlan.frameOverheadBytes)
    frame.append(plaintext)
    return frame
  }

  static func main() throws {
    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("preview-chunk-pipeline-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let outputURL = tempRoot.appendingPathComponent("out.bin")
    let chunkPlaintexts = [
      Data("abcd".utf8),
      Data("efgh".utf8),
      Data("ij".utf8),
    ]

    let frames = chunkPlaintexts.map(makeFrame)
    var decryptedFrames: [Data] = []
    var progress: [(Int, Int)] = []
    let plan = try PreviewChunkPlan(
      chunkCount: chunkPlaintexts.count,
      originalSize: chunkPlaintexts.reduce(0) { $0 + $1.count },
      plaintextChunkSize: 4
    )

    let pipeline = try PreviewChunkPipeline(
      plan: plan,
      outputURL: outputURL,
      decryptFrame: { frame in
        decryptedFrames.append(frame)
        guard frame.count >= PreviewChunkPlan.frameOverheadBytes else {
          throw NSError(domain: "PreviewChunkPipelineTest", code: 1)
        }
        return frame.suffix(frame.count - PreviewChunkPlan.frameOverheadBytes)
      },
      onChunkDecrypted: { completed, total in
        progress.append((completed, total))
      }
    )

    let networkFragments = [
      frames[0].prefix(5),
      frames[0].dropFirst(5) + frames[1].prefix(9),
      frames[1].dropFirst(9) + frames[2],
    ]
    for fragment in networkFragments {
      try pipeline.receive(Data(fragment))
    }

    expect(decryptedFrames.count == 3, "expected complete frames to decrypt before finish, got \(decryptedFrames.count)")
    expect(progress.map { $0.0 } == [1, 2, 3], "progress did not advance during receive-time decrypt: \(progress)")
    expect(!FileManager.default.fileExists(atPath: outputURL.path), "final output appeared before finish")
    let result = try pipeline.finish()
    expect(result.chunksDecrypted == 3, "expected 3 chunks, got \(result.chunksDecrypted)")
    expect(result.plaintextSize == 10, "expected 10 plaintext bytes, got \(result.plaintextSize)")
    expect(decryptedFrames == frames, "decrypt callback did not receive exact complete frames in order")
    let finalPlaintext = try Data(contentsOf: outputURL)
    expect(finalPlaintext == Data("abcdefghij".utf8), "final plaintext mismatch")
    let resourceValues = try outputURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
    expect(resourceValues.isExcludedFromBackup == true, "final plaintext output is not excluded from backup")

    let trailingOutputURL = tempRoot.appendingPathComponent("trailing.bin")
    try Data("previous".utf8).write(to: trailingOutputURL)
    let trailing = try PreviewChunkPipeline(
      plan: try PreviewChunkPlan(chunkCount: 1, originalSize: 2, plaintextChunkSize: 2),
      outputURL: trailingOutputURL,
      decryptFrame: { frame in frame.suffix(frame.count - PreviewChunkPlan.frameOverheadBytes) },
      onChunkDecrypted: { _, _ in }
    )
    try trailing.receive(makeFrame(Data("ok".utf8)) + Data([0xFF]))
    do {
      _ = try trailing.finish()
      fail("finish succeeded with trailing encrypted bytes")
    } catch {
      let preserved = try Data(contentsOf: trailingOutputURL)
      expect(preserved == Data("previous".utf8), "trailing failure removed or changed existing output")
    }

    // F1: even forged size/count headers cannot authorize an unfinished core stream.
    let truncatedOutput = tempRoot.appendingPathComponent("truncated.bin")
    var finishCalls = 0
    let truncated = try PreviewChunkPipeline(
      plan: try PreviewChunkPlan(chunkCount: 2, originalSize: 64, plaintextChunkSize: 32),
      outputURL: truncatedOutput,
      decryptFrame: { frame in Data(frame.suffix(32)) },
      finishDecryption: {
        finishCalls += 1
        throw NSError(domain: "CoreMissingAuthenticatedLastFrame", code: 1)
      },
      onChunkDecrypted: { _, _ in }
    )
    try truncated.receive(makeFrame(Data(repeating: 1, count: 32)))
    try truncated.receive(makeFrame(Data(repeating: 2, count: 32)))
    expectThrows("published an unfinished core stream") { _ = try truncated.finish() }
    expect(finishCalls == 1, "core finish was not called")
    expect(!FileManager.default.fileExists(atPath: truncatedOutput.path), "truncated plaintext was published")
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: tempRoot.path)
    expect(!leftovers.contains { $0.contains("truncated.bin") }, "truncated temporary plaintext survived")

    expectThrows("accepted zero chunks") {
      _ = try PreviewChunkPlan(chunkCount: 0, originalSize: 1, plaintextChunkSize: 1)
    }
    expectThrows("accepted oversized chunk metadata") {
      _ = try PreviewChunkPlan(
        chunkCount: 1,
        originalSize: PreviewChunkPlan.maxPlaintextChunkSize + 1,
        plaintextChunkSize: PreviewChunkPlan.maxPlaintextChunkSize + 1
      )
    }
    expectThrows("accepted inconsistent chunk metadata") {
      _ = try PreviewChunkPlan(chunkCount: 3, originalSize: 8, plaintextChunkSize: 4)
    }
    let emptyPlan = try PreviewChunkPlan(chunkCount: 1, originalSize: 0, plaintextChunkSize: 0)
    expect(emptyPlan.expectedEncryptedSize == PreviewChunkPlan.frameOverheadBytes, "empty-file encrypted size mismatch")
    expect(plan.expectedEncryptedSize == 94, "encrypted size calculation mismatch: \(plan.expectedEncryptedSize)")

    print("preview-chunk-pipeline-test: \(assertionCount) assertions, 0 failed")
  }
}

try PreviewChunkPipelineTest.main()
