import Foundation

class FileKeyHandle: @unchecked Sendable {
  struct NoHandle { init() {} }
  required init(noHandle: NoHandle) {}
  func decryptChunk(nonce: Data, ciphertext: Data) throws -> Data { Data() }
}

class MasterKeyHandle: @unchecked Sendable {
  struct NoHandle { init() {} }
  required init(noHandle: NoHandle) {}
  func deriveFileKey(fileId: Data) throws -> FileKeyHandle { FileKeyHandle(noHandle: .init()) }
}

enum ProvenanceHeaders {
  static func apply(to request: inout URLRequest) {
    request.setValue("mobile-ios", forHTTPHeaderField: "X-Beebeeb-Client")
    request.setValue("harness", forHTTPHeaderField: "X-Beebeeb-Client-Version")
  }
}

enum PlaintextStorageProtection {
  static func protect(_ url: URL) -> Bool { true }
  static func isPurgePending() -> Bool { false }
}
