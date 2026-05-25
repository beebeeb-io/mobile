import ExpoModulesCore
import Foundation
import CoreGraphics

public final class ThumbnailServiceModule: Module, ThumbnailEventEmitter {
  private static var localIdentifierMap: [String: String] = [:]
  private static let localIdentifierMapLock = NSLock()

  static func lookupLocalIdentifier(_ fileId: String) -> String? {
    localIdentifierMapLock.lock()
    defer { localIdentifierMapLock.unlock() }
    return localIdentifierMap[fileId]
  }

  private static var apiBaseURL: URL?
  private static var sessionToken: String?
  private static let credentialsLock = NSLock()

  static func credentials() -> (URL, String)? {
    credentialsLock.lock()
    defer { credentialsLock.unlock() }
    guard let url = apiBaseURL, let token = sessionToken else { return nil }
    return (url, token)
  }

  private static var fileKeys: [String: Data] = [:]
  private static let fileKeysLock = NSLock()

  static func fileKey(_ fileId: String) -> Data? {
    fileKeysLock.lock()
    defer { fileKeysLock.unlock() }
    return fileKeys[fileId]
  }

  internal func emit(_ name: String, body: [String: Any]) {
    sendEvent(name, body)
  }

  public func definition() -> ModuleDefinition {
    Name("ThumbnailService")
    Events("onThumbnailReady", "onAssociationCleared")

    OnCreate {
      Task {
        await ThumbnailService.shared.wire(
          emitter: self,
          localIdentifierLookup: { fileId in
            ThumbnailServiceModule.lookupLocalIdentifier(fileId)
          },
          apiCredentialsProvider: {
            ThumbnailServiceModule.credentials()
          },
          fileKeyProvider: { fileId in
            ThumbnailServiceModule.fileKey(fileId)
          }
        )
      }
    }

    AsyncFunction("getThumbnail") { (fileId: String, width: Double, height: Double) async throws -> [String: Any] in
      let result = try await ThumbnailService.shared.getThumbnail(
        for: fileId,
        targetSize: CGSize(width: width, height: height)
      )
      return [
        "uri": result.fileURL.absoluteString,
        "source": result.source.rawValue,
      ]
    }

    AsyncFunction("removeAssociation") { (fileId: String) async -> Void in
      await ThumbnailService.shared.forgetFile(fileId)
    }

    AsyncFunction("regenerateThumbnail") { (fileId: String, width: Int, jpegQuality: Float) async throws -> [String: Any] in
      let result = try await ThumbnailService.shared.regenerateThumbnail(
        for: fileId,
        quality: .continuous(width: width, jpegQuality: jpegQuality)
      )
      return [
        "fileId": result.fileId,
        "bytesUploaded": result.bytesUploaded,
      ]
    }

    AsyncFunction("setLocalIdentifierMap") { (map: [String: String]) -> Void in
      ThumbnailServiceModule.localIdentifierMapLock.lock()
      ThumbnailServiceModule.localIdentifierMap = map
      ThumbnailServiceModule.localIdentifierMapLock.unlock()
    }

    AsyncFunction("setLocalIdentifier") { (fileId: String, localIdentifier: String) -> Void in
      ThumbnailServiceModule.localIdentifierMapLock.lock()
      ThumbnailServiceModule.localIdentifierMap[fileId] = localIdentifier
      ThumbnailServiceModule.localIdentifierMapLock.unlock()
    }

    AsyncFunction("removeLocalIdentifier") { (fileId: String) async -> Void in
      ThumbnailServiceModule.localIdentifierMapLock.lock()
      ThumbnailServiceModule.localIdentifierMap.removeValue(forKey: fileId)
      ThumbnailServiceModule.localIdentifierMapLock.unlock()
      await ThumbnailService.shared.forgetFile(fileId)
    }

    AsyncFunction("setApiCredentials") { (baseURL: String, token: String) -> Void in
      ThumbnailServiceModule.credentialsLock.lock()
      ThumbnailServiceModule.apiBaseURL = URL(string: baseURL)
      ThumbnailServiceModule.sessionToken = token
      ThumbnailServiceModule.credentialsLock.unlock()
    }

    AsyncFunction("setFileKey") { (fileId: String, keyBytes: Data) -> Void in
      ThumbnailServiceModule.fileKeysLock.lock()
      ThumbnailServiceModule.fileKeys[fileId] = keyBytes
      ThumbnailServiceModule.fileKeysLock.unlock()
    }

    AsyncFunction("clearFileKeys") { () -> Void in
      ThumbnailServiceModule.fileKeysLock.lock()
      ThumbnailServiceModule.fileKeys.removeAll()
      ThumbnailServiceModule.fileKeysLock.unlock()
    }

#if DEBUG
    AsyncFunction("runSelfTests") { () async throws -> [String: Any] in
      var results: [String: Bool] = [:]

      let svc = ThumbnailService.shared
      let probeFile = "selftest-\(UUID().uuidString)"
      await svc.forgetFile(probeFile)
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(probeFile).png")
      try? "x".data(using: .utf8)?.write(to: url)
      await svc.setState(.photoKitResolved(url), for: probeFile)
      let didAccept = await svc.writeCache(
        CacheKey(fileId: probeFile, source: .remote),
        url: url
      )
      results["photoKitResolved_drops_remote_write"] = (didAccept == false)

      await svc.forgetFile(probeFile)

      results["service_compiled"] = true
      return results.mapValues { $0 as Any }
    }

    AsyncFunction("__queueDbSmokeTest") { () -> [String: Any] in
        let db = ThumbnailQueueDB.shared
        db.clearAll()
        db.enqueue(fileIds: ["a", "b", "c"], qualityPreset: "w768q082")
        let ready = db.popReady(limit: 2)
        db.markSucceeded(fileId: "a")
        db.recordFailure(fileId: "b", category: .network_5xx, message: "test")
        let stats = db.stats()
        return [
            "popped": ready.count,
            "pending": stats.pending,
            "running": stats.running,
            "succeeded": stats.succeeded,
            "failed_retry": stats.failedRetry
        ]
    }
#endif
  }
}

extension ThumbnailService {
  func wire(
    emitter: ThumbnailEventEmitter,
    localIdentifierLookup: @escaping (FileId) -> String?,
    apiCredentialsProvider: @escaping () async -> (URL, String)?,
    fileKeyProvider: @escaping (FileId) async -> Data?
  ) {
    self.eventEmitter = emitter
    self.localIdentifierLookup = localIdentifierLookup
    self.apiCredentialsProvider = apiCredentialsProvider
    self.fileKeyProvider = fileKeyProvider
  }
}
