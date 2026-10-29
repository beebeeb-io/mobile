import Foundation
import CryptoKit

// Isolates authenticated empty-frame behavior from filesystem backup metadata,
// which is separately covered by preview-chunk-pipeline-test.swift.
func runEmptyPreviewFrameTest() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("empty-preview-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: directory) }
  let key = SymmetricKey(data: Data(repeating: 7, count: 32))
  let sealed = try AES.GCM.seal(Data(), using: key)
  let frame = sealed.combined!
  let plan = try PreviewChunkPlan(chunkCount: 1, originalSize: 0, plaintextChunkSize: 0)
  var assertions = 0
  func check(_ condition: Bool) {
    assertions += 1
    precondition(condition, "empty preview assertion \(assertions) failed")
  }
  check(frame.count == 28 && plan.expectedEncryptedSize == 28)
  for variant in 0..<4 {
    let output = directory.appendingPathComponent("\(variant).txt")
    var decrypts = 0
    let pipeline = try PreviewChunkPipeline(plan: plan, outputURL: output, decryptFrame: { bytes in
      decrypts += 1
      return try AES.GCM.open(AES.GCM.SealedBox(combined: bytes), using: key)
    }, onChunkDecrypted: { _, _ in })
    var bytes = frame
    if variant == 1 { bytes[27] ^= 1 }
    if variant == 2 { bytes.removeLast() }
    if variant == 3 { bytes.append(0) }
    do {
      try pipeline.receive(bytes)
      let result = try pipeline.finish()
      check(variant == 0 && decrypts == 1 && result.plaintextSize == 0 && result.chunksDecrypted == 1)
      check(try Data(contentsOf: output).isEmpty)
    } catch {
      pipeline.cleanup()
      check(variant != 0 && !FileManager.default.fileExists(atPath: output.path))
    }
  }
  print("empty-preview-frame: \(assertions) assertions, 0 failed")
}

try runEmptyPreviewFrameTest()
